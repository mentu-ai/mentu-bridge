import { createClient, RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { spawn, ChildProcess } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import type { BridgeConfig, Command, ExecutionResult, MentuOperation } from './types.js';
import { CommitmentScheduler, type ExecuteCommitmentEvent } from './scheduler.js';
import { ApprovalHandler } from './approval.js';

export class BridgeDaemon {
  private config: BridgeConfig;
  private supabase: SupabaseClient;
  private channel: RealtimeChannel | null = null;
  private currentProcess: ChildProcess | null = null;
  private currentCommandId: string | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private scheduler: CommitmentScheduler;
  private approvalHandler: ApprovalHandler;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.anonKey
    );
    this.scheduler = new CommitmentScheduler(config);
    this.approvalHandler = new ApprovalHandler(this.supabase, config, (msg) => this.log(msg));
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
    this.log(`Workspace ID: ${this.config.workspace.id}`);

    // Register machine
    await this.registerMachine();

    // Subscribe to commands
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
    const { error } = await this.supabase
      .from('bridge_machines')
      .upsert({
        id: this.config.machine.id,
        workspace_id: this.config.workspace.id,
        user_id: this.config.user.id,
        name: this.config.machine.name,
        hostname: os.hostname(),
        agents_available: Object.keys(this.config.agents),
        status: 'online',
        last_seen_at: new Date().toISOString(),
      });

    if (error) {
      this.log(`Failed to register machine: ${error.message}`);
      throw error;
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
    this.channel = this.supabase
      .channel('bridge-commands')
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'bridge_commands',
          filter: `workspace_id=eq.${this.config.workspace.id}`,
        },
        (payload) => {
          this.handleCommand(payload.new as Command);
        }
      )
      .subscribe((status) => {
        this.log(`Subscription status: ${status}`);

        // Auto-reconnect on channel errors
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          this.log('Connection lost. Reconnecting in 5 seconds...');
          setTimeout(() => this.reconnect(), 5000);
        }
      });
  }

  private async reconnect(): Promise<void> {
    this.log('Attempting to reconnect...');

    // Remove old channel
    if (this.channel) {
      await this.supabase.removeChannel(this.channel);
      this.channel = null;
    }

    // Resubscribe
    await this.subscribe();

    // Process any pending commands we missed
    await this.processPendingCommands();
  }

  private async processPendingCommands(): Promise<void> {
    this.log('Checking for pending commands...');

    const { data: pendingCommands, error } = await this.supabase
      .from('bridge_commands')
      .select('*')
      .eq('workspace_id', this.config.workspace.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: true });

    if (error) {
      this.log(`Failed to fetch pending commands: ${error.message}`);
      return;
    }

    if (pendingCommands && pendingCommands.length > 0) {
      this.log(`Found ${pendingCommands.length} pending commands`);
      for (const command of pendingCommands) {
        await this.handleCommand(command as Command);
      }
    }
  }

  private async handleCommand(command: Command): Promise<void> {
    // Check if targeted at another machine
    if (
      command.target_machine_id &&
      command.target_machine_id !== this.config.machine.id
    ) {
      return; // Not for us
    }

    // Skip if already completed or running
    if (command.status === 'completed' || command.status === 'running' || command.status === 'failed' || command.status === 'timeout') {
      return;
    }

    // Attempt to claim (or verify already claimed by us)
    const claimed = await this.claimCommand(command.id);
    if (claimed === false) {
      this.log(`Command ${command.id} already claimed by another machine`);
      return;
    }
    if (claimed === 'already_mine') {
      this.log(`Command ${command.id} already claimed by this machine, executing...`);
    }

    this.log(`Executing command ${command.id}`);
    this.log(`  Agent: ${command.agent}`);
    this.log(`  Directory: ${command.working_directory}`);
    this.log(`  Prompt: ${command.prompt.substring(0, 100)}...`);

    // Mentu: Capture task when claimed
    const taskMemory = await this.captureMemory(
      `Bridge Task [${command.agent}]: ${command.prompt}\n\nDirectory: ${command.working_directory}\nMachine: ${this.config.machine.name}`,
      'task'
    );

    try {
      // Validate
      this.validateCommand(command);

      // Execute
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
    const args = [...agentConfig.default_flags, ...command.flags, command.prompt];

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

      const child = spawn(agentConfig.path, args, {
        cwd: command.working_directory,
        shell: false,
        env: { ...process.env },
      });

      this.currentProcess = child;

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

    // Dispose approval handler
    await this.approvalHandler.dispose();

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

    // Unsubscribe
    if (this.channel) {
      await this.supabase.removeChannel(this.channel);
    }

    this.log('Shutdown complete');
    process.exit(0);
  }
}
