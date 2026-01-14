import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import ws from 'ws';
import type { BridgeConfig, Command, ExecutionResult, MentuOperation, WorktreeEnv, WorkspaceConfig } from './types.js';
import { CommitmentScheduler, type ExecuteCommitmentEvent } from './scheduler.js';
import { ApprovalHandler } from './approval.js';
import { GenesisEnforcer } from './genesis-enforcer.js';
import {
  createWorktree,
  worktreeExists,
  buildWorktreeEnv,
  isGitRepo,
  getWorktreePath,
} from './worktree.js';
import { SimpleBugExecutor } from './simple-bug-executor.js';
import { discoverWorkspaces, getWorkspaceDirectory } from './workspace-discovery.js';

export class BridgeDaemon {
  private config: BridgeConfig;
  private supabase: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private channels: RealtimeChannel[] = [];
  private currentProcess: ChildProcess | null = null;
  private currentCommandId: string | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private scheduler: CommitmentScheduler;
  private approvalHandler: ApprovalHandler;
  private enforcers: Map<string, GenesisEnforcer> = new Map();
  private bugExecutor?: SimpleBugExecutor;
  private workspaces: WorkspaceConfig[] = [];
  private processingCommands: Set<string> = new Set();  // Track in-flight commands
  private isReconnecting = false;  // Prevent cascading reconnects

  constructor(config: BridgeConfig) {
    this.config = config;
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.anonKey,
      {
        realtime: {
          params: {
            eventsPerSecond: 10,
          },
          heartbeatIntervalMs: 15000,  // 15 second heartbeat (more aggressive than default 30s)
          reconnectAfterMs: (tries: number) => Math.min(tries * 1000, 30000),  // Exponential backoff: 1s, 2s, 3s... up to 30s
          // Fix for Node.js < 22: explicitly provide WebSocket transport
          // See: https://github.com/orgs/supabase/discussions/37869
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          transport: ws as any,
        },
        auth: {
          persistSession: false,  // VPS daemon doesn't need session persistence
        },
      }
    );
    this.scheduler = new CommitmentScheduler(config);
    this.approvalHandler = new ApprovalHandler(this.supabase, config, (msg) => this.log(msg));
  }

  /**
   * Get or create a GenesisEnforcer for a workspace directory.
   */
  private getEnforcer(workspacePath: string): GenesisEnforcer {
    if (!this.enforcers.has(workspacePath)) {
      this.enforcers.set(workspacePath, new GenesisEnforcer(workspacePath));
    }
    return this.enforcers.get(workspacePath)!;
  }

  /**
   * Check genesis enforcement before executing a command.
   * Returns null if allowed, or an error message if denied.
   */
  private checkGenesisEnforcement(command: Command): string | null {
    const enforcer = this.getEnforcer(command.working_directory);

    // If no genesis.key exists, allow execution (backward compatible)
    if (!enforcer.hasGenesis()) {
      return null;
    }

    // Determine actor: use command actor if available, otherwise default
    const actor = 'agent:executor'; // Standardized actor for all executors (Beacon/Bridge)

    // Check if 'execute' operation is allowed
    const result = enforcer.check(actor, 'execute', { command });

    if (!result.allowed && result.violation) {
      return `Genesis enforcement denied: ${result.violation.message}`;
    }

    return null;
  }

  private log(message: string): void {
    console.log(`[${new Date().toISOString()}] ${message}`);
  }

  // Mentu integration: capture a memory
  private async captureMemory(body: string, kind?: string): Promise<MentuOperation | null> {
    try {
      const response = await fetch(`${this.config.mentu.proxy_url}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Token': this.config.mentu.api_key,
        },
        body: JSON.stringify({
          op: 'capture',
          body,
          kind,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        this.log(`Mentu capture failed: ${error}`);
        return null;
      }

      const operation = await response.json() as MentuOperation;
      this.log(`Mentu: Captured ${operation.id} (${kind || 'observation'})`);
      return operation;
    } catch (error) {
      this.log(`Mentu capture error: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async start(): Promise<void> {
    this.log('Starting bridge daemon...');
    this.log(`Machine ID: ${this.config.machine.id}`);

    // Discover workspaces from genesis.key files
    const rootDirs = this.config.execution.allowed_directories;
    this.workspaces = await discoverWorkspaces(this.supabase, rootDirs, this.config.machine.id);

    if (this.workspaces.length === 0) {
      // Fallback to config workspace for backwards compatibility
      if (this.config.workspace?.id) {
        this.log('[Discovery] No workspaces discovered, using config fallback');
        this.workspaces = [{
          id: this.config.workspace.id,
          name: 'default',
          directory: process.cwd(),
        }];
      } else {
        this.log('[Discovery] No workspaces found. Exiting.');
        process.exit(1);
      }
    }

    this.log(`[Discovery] Active workspaces: ${this.workspaces.map(w => w.name).join(', ')}`);

    // Register machine
    await this.registerMachine();

    // Subscribe to commands for all workspaces
    await this.subscribe();

    // Handle shutdown signals
    process.on('SIGTERM', () => this.shutdown());
    process.on('SIGINT', () => this.shutdown());

    // Register commitment execution handler
    this.scheduler.setExecuteHandler(async (event: ExecuteCommitmentEvent) => {
      this.log(`Executing commitment ${event.commitment.id} via scheduler`);

      await this.executeAgent(
        'claude',
        event.prompt,
        event.workingDirectory,
        event.timeout
      );

      // Check if commitment was closed by Claude
      const updated = await this.checkCommitmentStatus(event.commitment.id);

      if (updated.state !== 'closed') {
        // Claude didn't close it - scheduler will handle failure
        this.log(`Commitment ${event.commitment.id} not closed by Claude`);
      }
    });

    // Start commitment scheduler for due commitment polling
    this.scheduler.start();

    // Start SimpleBugExecutor with discovered workspaces
    const machineId = process.env.MENTU_MACHINE_ID || this.config.machine.id;

    if (this.workspaces.length > 0) {
      // Use service role client for SimpleBugExecutor if available (needed for operations table RLS)
      const serviceRoleKey = this.config.supabase.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY;
      const bugExecutorClient = serviceRoleKey
        ? createClient(this.config.supabase.url, serviceRoleKey)
        : this.supabase;

      if (serviceRoleKey) {
        this.log('[Daemon] SimpleBugExecutor using service role key (RLS bypass)');
      }

      this.bugExecutor = new SimpleBugExecutor(
        bugExecutorClient,
        this.workspaces,
        machineId,
        {
          proxyUrl: this.config.mentu.proxy_url,
          apiKey: this.config.mentu.api_key,
        },
        {
          pollIntervalMs: 30_000,
          maxRetries: 3,
          baseBackoffMs: 1000,
          timeoutSeconds: this.config.execution.default_timeout_seconds,
        }
      );

      // SimpleBugExecutor polls independently - start it
      await this.bugExecutor.start();
      this.log('[Daemon] SimpleBugExecutor started (polling mode)');
    } else {
      this.log('[Daemon] No workspaces, bug executor disabled');
    }

    this.log('Daemon running. Waiting for commands...');

    // Process any pending commands from before we started
    await this.processPendingCommands();
  }

  /**
   * Execute an agent with given prompt (used by scheduler)
   */
  private async executeAgent(
    agent: string,
    prompt: string,
    workingDirectory: string,
    timeout: number
  ): Promise<ExecutionResult> {
    const command: Command = {
      id: `scheduled_${Date.now()}`,
      workspace_id: this.config.workspace.id,
      prompt,
      working_directory: workingDirectory,
      agent,
      flags: [],
      timeout_seconds: Math.floor(timeout / 1000),
      target_machine_id: null,
      status: 'running',
      created_at: new Date().toISOString(),
      // Scheduled commands don't need approval
      approval_required: false,
      on_approve: null,
      approval_status: 'not_required',
      approved_at: null,
      approved_by: null,
    };

    return this.executeCommand(command);
  }

  /**
   * Check commitment status
   */
  private async checkCommitmentStatus(commitmentId: string): Promise<{ state: string }> {
    const response = await fetch(
      `${this.config.mentu.proxy_url}/rest/v1/commitments?id=eq.${commitmentId}&select=state`,
      {
        headers: {
          'X-Proxy-Token': this.config.mentu.api_key,
        },
      }
    );

    if (!response.ok) return { state: 'unknown' };
    const commitments = await response.json() as { state: string }[];
    return commitments[0] || { state: 'unknown' };
  }

  private async registerMachine(): Promise<void> {
    // Build machine registration data
    const machineData: Record<string, unknown> = {
      id: this.config.machine.id,
      workspace_id: this.config.workspace.id,
      name: this.config.machine.name,
      hostname: os.hostname(),
      agents_available: Object.keys(this.config.agents),
      status: 'online',
      last_seen_at: new Date().toISOString(),
    };

    // Only include user_id if it's a valid UUID
    if (this.config.user?.id && this.config.user.id.length === 36) {
      machineData.user_id = this.config.user.id;
    }

    const { error } = await this.supabase
      .from('bridge_machines')
      .upsert(machineData);

    if (error) {
      // Non-fatal: log warning and continue (singleton check already works)
      this.log(`Warning: Failed to register machine: ${error.message}`);
      this.log('Continuing without machine registration (commands will still execute)');
      return;
    }

    this.log('Machine registered successfully');

    // Start heartbeat every 60 seconds
    this.heartbeatInterval = setInterval(() => this.heartbeat(), 60000);
  }

  private async heartbeat(): Promise<void> {
    await this.supabase
      .from('bridge_machines')
      .update({
        status: this.currentProcess ? 'busy' : 'online',
        last_seen_at: new Date().toISOString(),
        current_command_id: this.currentCommandId,
      })
      .eq('id', this.config.machine.id);
  }

  private async subscribe(): Promise<void> {
    // Subscribe to each workspace
    for (const workspace of this.workspaces) {
      const channel = this.supabase
        .channel(`bridge-commands-${workspace.name}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'bridge_commands',
            filter: `workspace_id=eq.${workspace.id}`,
          },
          (payload) => {
            this.handleCommand(payload.new as Command);
          }
        )
        .subscribe((status) => {
          this.log(`[${workspace.name}] Subscription status: ${status}`);

          // Auto-reconnect on channel errors (only once for all channels)
          if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !this.isReconnecting) {
            this.log(`[${workspace.name}] Connection lost. Reconnecting in 5 seconds...`);
            this.isReconnecting = true;
            setTimeout(() => this.reconnect(), 5000);
          }
        });

      this.channels.push(channel);
    }

    // Keep single channel for backwards compat (used by reconnect)
    this.channel = this.channels[0] || null;
  }

  private async reconnect(): Promise<void> {
    this.log('Attempting to reconnect...');

    // Remove all channels
    for (const channel of this.channels) {
      await this.supabase.removeChannel(channel);
    }
    this.channels = [];
    this.channel = null;

    // Allow reconnects again after clearing channels
    this.isReconnecting = false;

    // Resubscribe
    await this.subscribe();

    // Process any pending commands we missed
    await this.processPendingCommands();
  }

  private async processPendingCommands(): Promise<void> {
    this.log('Checking for pending commands...');

    const workspaceIds = this.workspaces.map(w => w.id);

    if (workspaceIds.length === 0) {
      this.log('No workspace IDs to query');
      return;
    }

    // Query for pending commands
    const { data: pendingCommands, error: pendingError } = await this.supabase
      .from('bridge_commands')
      .select('*')
      .in('workspace_id', workspaceIds)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (pendingError) {
      this.log(`Failed to fetch pending commands: ${pendingError.message}`);
    }

    // Also query for orphaned claimed commands (claimed by this machine but not completed)
    // These can happen after daemon restart
    const { data: orphanedCommands, error: orphanedError } = await this.supabase
      .from('bridge_commands')
      .select('*')
      .in('workspace_id', workspaceIds)
      .eq('status', 'claimed')
      .eq('claimed_by_machine_id', this.config.machine.id)
      .order('created_at', { ascending: true });

    if (orphanedError) {
      this.log(`Failed to fetch orphaned commands: ${orphanedError.message}`);
    }

    const allCommands = [
      ...(pendingCommands || []),
      ...(orphanedCommands || [])
    ];

    if (allCommands.length > 0) {
      this.log(`Found ${allCommands.length} commands (${pendingCommands?.length || 0} pending, ${orphanedCommands?.length || 0} orphaned)`);
      for (const command of allCommands) {
        await this.handleCommand(command as Command);
      }
    }
  }

  private async handleCommand(command: Command): Promise<void> {
    this.log(`[handleCommand] Checking command ${command.id} (target: ${command.target_machine_id}, status: ${command.status})`);

    // Check if targeted at another machine
    if (
      command.target_machine_id &&
      command.target_machine_id !== this.config.machine.id
    ) {
      this.log(`[handleCommand] Skipping ${command.id} - target mismatch (${command.target_machine_id} !== ${this.config.machine.id})`);
      return; // Not for us
    }

    // Skip if already completed or running
    if (command.status === 'completed' || command.status === 'running' || command.status === 'failed' || command.status === 'timeout') {
      this.log(`[handleCommand] Skipping ${command.id} - status is ${command.status}`);
      return;
    }

    // Skip if already being processed by this daemon instance (prevents race from multiple workspace subscriptions)
    if (this.processingCommands.has(command.id)) {
      this.log(`[handleCommand] Skipping ${command.id} - already processing`);
      return;
    }

    // Skip bug_execution commands BEFORE claiming - SimpleBugExecutor handles them via independent polling
    // This prevents handleCommand from claiming the command and leaving it stuck in 'claimed' status
    if (command.command_type === 'bug_execution') {
      this.log(`[handleCommand] Skipping ${command.id} - bug_execution handled by SimpleBugExecutor`);
      return;
    }

    // Attempt to claim (or verify already claimed by us)
    this.log(`[handleCommand] Attempting to claim ${command.id}...`);
    const claimed = await this.claimCommand(command.id);
    if (claimed === false) {
      this.log(`Command ${command.id} already claimed by another machine`);
      return;
    }
    if (claimed === 'already_mine') {
      // Already claimed by us but not in processingCommands - resume execution
      // This happens after daemon restart when a command was claimed but not completed
      this.log(`[handleCommand] Resuming ${command.id} - was claimed by us but not completed`);
    }

    // Mark as processing
    this.processingCommands.add(command.id);

    this.log(`Executing command ${command.id}`);
    this.log(`  Agent: ${command.agent}`);
    this.log(`  Directory: ${command.working_directory}`);
    this.log(`  Prompt: ${command.prompt.substring(0, 100)}...`);

    // Check genesis enforcement before execution
    const genesisError = this.checkGenesisEnforcement(command);
    if (genesisError) {
      this.log(`Command ${command.id} blocked by genesis: ${genesisError}`);
      await this.submitResult(command.id, command, {
        status: 'failed',
        exit_code: 403,
        stdout: '',
        stderr: genesisError,
        error_message: genesisError,
      });
      this.currentCommandId = null;
      this.processingCommands.delete(command.id);
      return;
    }

    // Mentu: Capture task when claimed (not for bug_execution - already captured by proxy)
    const taskMemory = await this.captureMemory(
      `Bridge Task [${command.agent}]: ${command.prompt}\n\nDirectory: ${command.working_directory}\nMachine: ${this.config.machine.name}`,
      'task'
    );

    try {
      // Validate
      this.validateCommand(command);

      // Execute command
      const result = await this.executeCommand(command);

      // Check if approval is required
      if (command.approval_required && result.status === 'success') {
        this.log(`Command ${command.id} completed, awaiting approval`);

        // Update status to awaiting_approval
        await this.supabase
          .from('bridge_commands')
          .update({
            status: 'awaiting_approval',
            approval_status: 'pending',
          })
          .eq('id', command.id);

        // Capture Claude output as evidence
        await this.captureMemory(
          `Claude completed [${command.agent}]: ${result.stdout.substring(0, 500)}...\n\nAwaiting approval for: ${command.on_approve}`,
          'evidence'
        );

        // Wait for approval
        const approvalResult = await this.approvalHandler.waitForApproval(command);

        if (approvalResult === 'approved') {
          this.log(`Command ${command.id} approved, executing on_approve`);

          // Update status
          await this.supabase
            .from('bridge_commands')
            .update({ status: 'approved' })
            .eq('id', command.id);

          // Execute on_approve action
          const onApproveResult = await this.approvalHandler.executeOnApprove(command);

          // Capture on_approve result
          await this.captureMemory(
            `On-approve executed: ${command.on_approve}\n\nResult: ${onApproveResult.status}\nOutput: ${onApproveResult.stdout}`,
            'evidence'
          );

          await this.submitResult(command.id, command, onApproveResult, taskMemory?.id);
        } else if (approvalResult === 'rejected') {
          this.log(`Command ${command.id} rejected`);
          await this.submitResult(command.id, command, {
            status: 'failed',
            exit_code: 1,
            stdout: result.stdout,
            stderr: 'Command rejected by user',
            error_message: 'Approval rejected',
          }, taskMemory?.id);
        } else {
          // Timeout
          this.log(`Command ${command.id} approval timed out`);
          await this.submitResult(command.id, command, {
            status: 'timeout',
            exit_code: 1,
            stdout: result.stdout,
            stderr: 'Approval timed out after 24 hours',
            error_message: 'Approval timeout',
          }, taskMemory?.id);
        }
      } else {
        // No approval required - existing flow
        await this.submitResult(command.id, command, result, taskMemory?.id);
      }

      this.log(`Command ${command.id} completed with status: ${result.status}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Command ${command.id} failed: ${message}`);

      await this.submitResult(command.id, command, {
        status: 'failed',
        exit_code: 1,
        stdout: '',
        stderr: message,
        error_message: message,
      }, taskMemory?.id);
    }

    this.currentCommandId = null;
    this.processingCommands.delete(command.id);
  }

  private async claimCommand(commandId: string): Promise<boolean | 'already_mine'> {
    const { data, error } = await this.supabase
      .from('bridge_commands')
      .update({
        status: 'claimed',
        claimed_by_machine_id: this.config.machine.id,
        claimed_at: new Date().toISOString(),
      })
      .eq('id', commandId)
      .eq('status', 'pending') // Only claim if still pending
      .select();

    if (error || !data || data.length === 0) {
      // Check if already claimed by this machine
      const { data: existing } = await this.supabase
        .from('bridge_commands')
        .select('claimed_by_machine_id, status')
        .eq('id', commandId)
        .single();

      if (existing?.claimed_by_machine_id === this.config.machine.id && existing?.status === 'claimed') {
        this.currentCommandId = commandId;
        return 'already_mine';
      }
      return false;
    }

    this.currentCommandId = commandId;
    return true;
  }

  private validateCommand(command: Command): void {
    // Check working directory is allowed
    const allowed = this.config.execution.allowed_directories.some(
      (dir) => command.working_directory.startsWith(dir)
    );

    if (!allowed) {
      throw new Error(
        `Working directory not allowed: ${command.working_directory}. ` +
        `Allowed: ${this.config.execution.allowed_directories.join(', ')}`
      );
    }

    // Check agent is available
    if (!this.config.agents[command.agent]) {
      throw new Error(
        `Agent not available: ${command.agent}. ` +
        `Available: ${Object.keys(this.config.agents).join(', ')}`
      );
    }

    // Check directory exists
    if (!fs.existsSync(command.working_directory)) {
      throw new Error(
        `Working directory does not exist: ${command.working_directory}`
      );
    }
  }

  private async executeCommand(command: Command): Promise<ExecutionResult> {
    const agentConfig = this.config.agents[command.agent];
    // For Claude agent, use -p flag for headless mode (prompt must come after -p)
    const isClaudeAgent = command.agent === 'claude';
    const args = isClaudeAgent
      ? [...agentConfig.default_flags, ...command.flags, '-p', command.prompt]
      : [...agentConfig.default_flags, ...command.flags, command.prompt];

    // Determine execution directory and environment
    let execDir = command.working_directory;
    let worktreeEnv: WorktreeEnv | null = null;

    // Handle worktree creation if requested
    if (command.with_worktree && command.commitment_id) {
      const workspacePath = command.working_directory;

      // Only create worktree if directory is a git repo
      if (isGitRepo(workspacePath)) {
        try {
          // Check if worktree already exists (from previous attempt or reopen)
          if (worktreeExists(workspacePath, command.commitment_id)) {
            execDir = getWorktreePath(workspacePath, command.commitment_id);
            this.log(`Worktree already exists at ${execDir}`);
          } else {
            const worktree = createWorktree(workspacePath, command.commitment_id);
            execDir = worktree.worktree_path;
            this.log(`Created worktree at ${execDir} on branch ${worktree.worktree_branch}`);
          }

          // Build worktree environment variables
          worktreeEnv = buildWorktreeEnv(
            command.commitment_id,
            execDir,
            workspacePath
          );
          this.log(`Injecting env: MENTU_COMMITMENT=${worktreeEnv.MENTU_COMMITMENT}`);
        } catch (err) {
          this.log(`Failed to create worktree: ${err instanceof Error ? err.message : String(err)}`);
          // Continue without worktree - fall back to original directory
        }
      } else {
        this.log(`Worktree requested but ${workspacePath} is not a git repo`);
      }
    }

    // Update status to running
    await this.supabase
      .from('bridge_commands')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .eq('id', command.id);

    return new Promise((resolve) => {

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      this.log(`Spawning: ${agentConfig.path} ${args.join(' ')}`);
      this.log(`  cwd: ${execDir}`);

      // Merge worktree environment variables if available
      // Include CLAUDE_CODE_OAUTH_TOKEN for Max subscription auth (preferred over API key)
      const env = {
        ...process.env,
        ...(worktreeEnv || {}),
        // Ensure OAuth token is passed to Claude CLI if set
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        }),
        // Pass command ID for spawn_logs hook correlation
        MENTU_BRIDGE_COMMAND_ID: command.id,
      };

      const child = spawn(agentConfig.path, args, {
        cwd: execDir,
        shell: false,
        env,
      });

      this.currentProcess = child;

      // Close stdin immediately - Claude Code waits for stdin if left open
      child.stdin.end();

      // Timeout handler
      const timeoutMs = (command.timeout_seconds || this.config.execution.default_timeout_seconds) * 1000;
      const timeout = setTimeout(() => {
        timedOut = true;
        this.log(`Command ${command.id} timed out after ${timeoutMs}ms`);
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }, timeoutMs);

      child.stdout.on('data', (data) => {
        stdout += data.toString();
        // Truncate if too large
        if (stdout.length > this.config.execution.max_output_bytes) {
          stdout = stdout.slice(-this.config.execution.max_output_bytes);
        }
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
        if (stderr.length > this.config.execution.max_output_bytes) {
          stderr = stderr.slice(-this.config.execution.max_output_bytes);
        }
      });

      child.on('close', (code) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        resolve({
          status: timedOut ? 'timeout' : code === 0 ? 'success' : 'failed',
          exit_code: code ?? 1,
          stdout,
          stderr,
        });
      });

      child.on('error', (error) => {
        clearTimeout(timeout);
        this.currentProcess = null;

        resolve({
          status: 'failed',
          exit_code: 1,
          stdout,
          stderr,
          error_message: error.message,
        });
      });
    });
  }

  private async submitResult(
    commandId: string,
    command: Command,
    result: ExecutionResult,
    taskMemoryId?: string
  ): Promise<void> {
    const now = new Date().toISOString();

    // Update command status
    await this.supabase
      .from('bridge_commands')
      .update({
        status: result.status === 'success' ? 'completed' : result.status,
        completed_at: now,
      })
      .eq('id', commandId);

    // Insert result
    await this.supabase.from('bridge_results').insert({
      command_id: commandId,
      machine_id: this.config.machine.id,
      status: result.status,
      exit_code: result.exit_code,
      stdout: result.stdout,
      stderr: result.stderr,
      stdout_truncated: result.stdout.length >= this.config.execution.max_output_bytes,
      stderr_truncated: result.stderr.length >= this.config.execution.max_output_bytes,
      error_message: result.error_message,
      started_at: now,
      completed_at: now,
    });

    // Mentu: Capture evidence with result
    const outputPreview = result.stdout.length > 500
      ? result.stdout.substring(0, 500) + '...'
      : result.stdout;
    const errorPreview = result.stderr.length > 200
      ? result.stderr.substring(0, 200) + '...'
      : result.stderr;

    const evidenceBody = result.status === 'success'
      ? `Bridge Result [${command.agent}]: SUCCESS (exit ${result.exit_code})\n\nTask: ${command.prompt.substring(0, 100)}${command.prompt.length > 100 ? '...' : ''}\n\nOutput:\n${outputPreview}${taskMemoryId ? `\n\nTask ref: ${taskMemoryId}` : ''}`
      : `Bridge Result [${command.agent}]: ${result.status.toUpperCase()} (exit ${result.exit_code})\n\nTask: ${command.prompt.substring(0, 100)}${command.prompt.length > 100 ? '...' : ''}\n\nError: ${result.error_message || errorPreview}${taskMemoryId ? `\n\nTask ref: ${taskMemoryId}` : ''}`;

    await this.captureMemory(evidenceBody, 'evidence');
  }

  async shutdown(): Promise<void> {
    this.log('Shutting down...');

    // Stop scheduler
    this.scheduler.stop();

    // Stop bug executor
    if (this.bugExecutor) {
      await this.bugExecutor.stop();
    }

    // Dispose approval handler
    await this.approvalHandler.dispose();

    // Dispose genesis enforcers
    for (const enforcer of this.enforcers.values()) {
      enforcer.dispose();
    }
    this.enforcers.clear();

    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    // Wait for current process if any
    if (this.currentProcess) {
      this.log('Waiting for current process to complete...');
      await new Promise((resolve) => setTimeout(resolve, 10000));
      if (this.currentProcess) {
        this.currentProcess.kill('SIGTERM');
      }
    }

    // Update machine status
    await this.supabase
      .from('bridge_machines')
      .update({ status: 'offline' })
      .eq('id', this.config.machine.id);

    // Unsubscribe all channels
    for (const channel of this.channels) {
      await this.supabase.removeChannel(channel);
    }
    this.channels = [];

    this.log('Shutdown complete');
    process.exit(0);
  }
}
