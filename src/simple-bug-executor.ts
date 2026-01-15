/**
 * SimpleBugExecutor - Streamlined bug execution with polling and retry
 *
 * Design principles:
 * - Single Claude session (no Auditor/Executor split)
 * - Polling instead of Realtime subscriptions
 * - Auto-retry with exponential backoff
 * - Terminal mode via stdin (NOT headless -p)
 * - Bridge is infrastructure, Claude is actor
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { spawn, ChildProcess, exec } from "child_process";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { WorkspaceConfig } from "./types.js";

// Execution log directory
const EXECUTION_LOG_DIR = process.env.EXECUTION_LOG_DIR || '/home/mentu/logs/executions';

// ============================================================================
// Types
// ============================================================================

export interface SimpleBugExecutorConfig {
  pollIntervalMs?: number;      // Default: 30000 (30s)
  maxRetries?: number;          // Default: 3
  baseBackoffMs?: number;       // Default: 1000 (1s)
  timeoutSeconds?: number;      // Default: 3600 (1 hour)
  staleThresholdMinutes?: number;  // Default: 30
  maxTurns?: number;            // Default: 50 (configurable)
}

export interface BugCommand {
  id: string;
  workspace_id: string;
  working_directory: string;
  command_type: string;
  status: string;
  timeout_seconds?: number;
  commitment_id?: string;
  payload?: {
    memory_id?: string;
    commitment_id?: string;
    timeout_seconds?: number;
    [key: string]: unknown;
  };
  created_at: string;
  claimed_at?: string;
  claimed_by_machine_id?: string;
}

export interface BugMemory {
  id: string;
  op: string;
  payload: {
    body?: string;
    kind?: string;
    meta?: {
      page_url?: string;
      element_text?: string;
      element_tag?: string;
      screenshot_url?: string;
      console_errors?: Array<{ level: string; message: string }>;
      behavior_trace?: Array<{ type: string; target?: string }>;
      [key: string]: unknown;
    };
    callback_url?: string;
    callback_secret?: string;
    [key: string]: unknown;
  };
}

export interface VerificationResult {
  verified: boolean;
  gitCommits: number;
  filesChanged: string[];
  ledgerHasClose: boolean;
  pushedToRemote: boolean;
  headRef: string;
  reason: string;
}

export interface BugFixResult {
  success: boolean;
  verified: boolean;        // NEW: verification passed
  summary: string;
  files_changed: string[];
  tests_passed: boolean;
  exit_code: number;
  output: string;
  verification?: VerificationResult;  // NEW
  blocked_reason?: string;
}

interface RetryState {
  attempt: number;
  lastError: string;
  nextRetryAt?: string;
}

// ============================================================================
// SimpleBugExecutor
// ============================================================================

export class SimpleBugExecutor {
  private supabase: SupabaseClient;
  private workspaces: WorkspaceConfig[];
  private workspaceIds: string[];
  private machineId: string;
  private apiConfig: { proxyUrl: string; apiKey: string };

  // State
  private pollInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private currentProcess: ChildProcess | null = null;
  private isShuttingDown = false;

  // Configuration
  private readonly POLL_INTERVAL_MS: number;
  private readonly MAX_RETRIES: number;
  private readonly BASE_BACKOFF_MS: number;
  private readonly TIMEOUT_SECONDS: number;
  private readonly STALE_THRESHOLD_MINUTES: number;
  private readonly MAX_TURNS: number;

  constructor(
    supabase: SupabaseClient,
    workspaces: WorkspaceConfig[],
    machineId: string,
    apiConfig: { proxyUrl: string; apiKey: string },
    config: SimpleBugExecutorConfig = {}
  ) {
    this.supabase = supabase;
    this.workspaces = workspaces;
    this.workspaceIds = workspaces.map(w => w.id);
    this.machineId = machineId;
    this.apiConfig = apiConfig;

    // Apply config with defaults
    this.POLL_INTERVAL_MS = config.pollIntervalMs ?? 30_000;
    this.MAX_RETRIES = config.maxRetries ?? 3;
    this.BASE_BACKOFF_MS = config.baseBackoffMs ?? 1000;
    this.TIMEOUT_SECONDS = config.timeoutSeconds ?? 3600;
    this.STALE_THRESHOLD_MINUTES = config.staleThresholdMinutes ?? 30;
    this.MAX_TURNS = config.maxTurns ?? 50;
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async start(): Promise<void> {
    this.log('Starting SimpleBugExecutor...');
    this.log(`Machine ID: ${this.machineId}`);
    this.log(`Watching ${this.workspaces.length} workspaces: ${this.workspaces.map(w => w.name).join(', ')}`);
    this.log(`Poll interval: ${this.POLL_INTERVAL_MS}ms, Max retries: ${this.MAX_RETRIES}`);

    // 1. Recover stuck commands first
    await this.recoverStuckCommands();

    // 2. Process any pending commands immediately
    await this.processPendingCommands();

    // 3. Start polling loop
    this.pollInterval = setInterval(
      () => this.processPendingCommands(),
      this.POLL_INTERVAL_MS
    );

    this.log('SimpleBugExecutor ready (polling mode)');
  }

  async stop(): Promise<void> {
    this.log('Stopping SimpleBugExecutor...');
    this.isShuttingDown = true;

    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Kill current process if running
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      await this.sleep(2000);
      if (this.currentProcess) {
        this.currentProcess.kill('SIGKILL');
      }
    }

    this.log('SimpleBugExecutor stopped');
  }

  // --------------------------------------------------------------------------
  // Polling & Queue Processing
  // --------------------------------------------------------------------------

  private async processPendingCommands(): Promise<void> {
    if (this.isProcessing || this.isShuttingDown) return;

    this.isProcessing = true;

    try {
      const commands = await this.queryPendingCommands();

      for (const command of commands) {
        if (this.isShuttingDown) break;
        await this.processCommandWithRetry(command);
      }
    } catch (error) {
      this.log(`Poll error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  private async queryPendingCommands(): Promise<BugCommand[]> {
    if (this.workspaceIds.length === 0) return [];

    const { data, error } = await this.supabase
      .from('bridge_commands')
      .select('*')
      .in('workspace_id', this.workspaceIds)
      .eq('command_type', 'bug_execution')
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(5);

    if (error) {
      this.log(`Query error: ${error.message}`);
      return [];
    }

    if (data && data.length > 0) {
      this.log(`Found ${data.length} pending bug_execution commands`);
    }

    return (data || []) as BugCommand[];
  }

  // --------------------------------------------------------------------------
  // Retry Logic
  // --------------------------------------------------------------------------

  private async processCommandWithRetry(command: BugCommand): Promise<void> {
    let attempt = 0;
    let lastError = '';

    while (attempt < this.MAX_RETRIES) {
      attempt++;

      this.log(`Processing ${command.id} (attempt ${attempt}/${this.MAX_RETRIES})`);

      try {
        // Attempt to claim
        const claimed = await this.claimCommand(command.id);
        if (!claimed) {
          this.log(`Could not claim ${command.id} (already claimed)`);
          return;
        }

        // Execute the bug fix
        const result = await this.executeBugFix(command);

        // Handle result
        await this.handleResult(command, result);

        // Success - exit retry loop
        return;

      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.log(`Attempt ${attempt} failed: ${lastError}`);

        if (attempt < this.MAX_RETRIES) {
          // Calculate backoff: 1s, 2s, 4s (exponential)
          const backoffMs = this.BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          this.log(`Retrying in ${backoffMs}ms...`);

          // Update command with retry state
          await this.updateRetryState(command.id, {
            attempt,
            lastError,
            nextRetryAt: new Date(Date.now() + backoffMs).toISOString(),
          });

          // Reset to pending so we can re-claim
          await this.resetToPending(command.id);

          await this.sleep(backoffMs);
        }
      }
    }

    // All retries exhausted
    this.log(`All ${this.MAX_RETRIES} attempts failed for ${command.id}`);
    await this.failCommand(command.id, `Failed after ${this.MAX_RETRIES} attempts. Last error: ${lastError}`);
  }

  // --------------------------------------------------------------------------
  // Command Claiming
  // --------------------------------------------------------------------------

  private async claimCommand(commandId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from('bridge_commands')
      .update({
        status: 'claimed',
        claimed_by_machine_id: this.machineId,
        claimed_at: new Date().toISOString(),
      })
      .eq('id', commandId)
      .eq('status', 'pending')
      .select();

    if (error) {
      this.log(`Claim error: ${error.message}`);
      return false;
    }

    return (data?.length ?? 0) > 0;
  }

  /**
   * Claim the commitment via mentu CLI (proper ledger operation)
   * This shows the commitment as "in progress" in the dashboard
   */
  private async claimCommitment(commitmentId: string): Promise<void> {
    this.log(`Claiming commitment ${commitmentId}`);

    return new Promise((resolve) => {
      // Use mentu claim command to properly record in ledger
      exec(
        `mentu claim ${commitmentId} --actor agent:claude-vps`,
        { timeout: 30000 },
        (error, stdout, stderr) => {
          if (error) {
            this.log(`Warning: Could not claim commitment: ${stderr || error.message}`);
            // Don't throw - continue with execution even if claim fails
          } else {
            this.log(`Commitment ${commitmentId} claimed via ledger`);
          }
          resolve();
        }
      );
    });
  }

  // --------------------------------------------------------------------------
  // Bug Execution (Single Agent)
  // --------------------------------------------------------------------------

  private async executeBugFix(command: BugCommand): Promise<BugFixResult> {
    const payload = command.payload || {};
    const memoryId = payload.memory_id;
    const commitmentId = command.commitment_id || payload.commitment_id;
    const workingDirectory = command.working_directory;
    const timeoutSeconds = payload.timeout_seconds || command.timeout_seconds || this.TIMEOUT_SECONDS;

    if (!memoryId) {
      throw new Error('Bug execution requires payload.memory_id');
    }

    if (!commitmentId) {
      throw new Error('Bug execution requires commitment_id');
    }

    // Update bridge_commands status
    await this.supabase
      .from('bridge_commands')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .eq('id', command.id);

    // Claim the commitment (move to 'claimed' state)
    await this.claimCommitment(commitmentId);

    // Record to ledger (v2.0 prep)
    const executionStartId = await this.recordExecutionStart(
      commitmentId,
      workingDirectory,
      command.id
    );

    // Capture starting git ref for verification
    const startRef = await this.getHeadRef(workingDirectory);
    this.log(`Starting ref: ${startRef}`);

    // Fetch bug memory for description
    this.log(`Fetching bug memory ${memoryId}`);
    const bugMemory = await this.fetchBugMemory(command.workspace_id, memoryId);
    if (!bugMemory) {
      throw new Error(`Bug memory ${memoryId} not found`);
    }

    // Extract bug description
    const bugDescription = this.extractBugDescription(bugMemory);

    // Build minimal prompt (delegates to repo's protocol file)
    const prompt = this.buildMinimalPrompt(bugDescription, commitmentId, memoryId);

    // Spawn Claude with CLI argument (not stdin)
    this.log(`Spawning Claude in ${workingDirectory} (max turns: ${this.MAX_TURNS}, timeout: ${timeoutSeconds}s)`);
    const claudeResult = await this.spawnClaudeWithArg(
      workingDirectory,
      prompt,
      timeoutSeconds,
      command.id,
      commitmentId
    );

    // Verify outcomes
    const verification = await this.verifyOutcome(
      workingDirectory,
      commitmentId,
      startRef,
      { success: claudeResult.success, blocked_reason: claudeResult.blocked_reason }
    );

    const finalResult: BugFixResult = {
      ...claudeResult,
      verified: verification.verified,
      files_changed: verification.filesChanged.length > 0
        ? verification.filesChanged
        : claudeResult.files_changed,
      verification,
    };

    // Record completion to ledger (v2.0 prep)
    await this.recordExecutionComplete(executionStartId, commitmentId, finalResult);

    return finalResult;
  }

  private async fetchBugMemory(workspaceId: string, memoryId: string): Promise<BugMemory | null> {
    const { data, error } = await this.supabase
      .from('operations')
      .select('id, op, payload')
      .eq('id', memoryId)
      .eq('workspace_id', workspaceId)
      .single();

    if (error || !data) {
      this.log(`Failed to fetch memory ${memoryId}: ${error?.message}`);
      return null;
    }

    return data as BugMemory;
  }

  // --------------------------------------------------------------------------
  // Minimal Bug Prompt (Delegates to BUG-FIX-PROTOCOL.md)
  // --------------------------------------------------------------------------

  /**
   * Build minimal prompt that delegates to repo's BUG-FIX-PROTOCOL.md
   *
   * v1.0: Minimal prompt, repo owns instructions
   * v2.0: Will add worktree path, session tracking
   */
  private buildMinimalPrompt(
    bugDescription: string,
    commitmentId: string,
    memoryId: string
  ): string {
    return `Fix this bug (commitment: ${commitmentId}):
${bugDescription}

Full instructions: Read ./BUG-FIX-PROTOCOL.md
Bug details available as memory: ${memoryId}`;
  }

  /**
   * Extract bug description from memory payload
   */
  private extractBugDescription(memory: BugMemory): string {
    const payload = memory.payload || {};
    const body = (payload.body as string) || '';

    // Extract first paragraph (before --- separator) as description
    const description = body.split('---')[0]?.trim().slice(0, 800) || body.slice(0, 800);

    return description || 'Bug details in memory';
  }

  // --------------------------------------------------------------------------
  // Claude Spawn with CLI Argument (v1.0 - NOT stdin)
  // --------------------------------------------------------------------------

  /**
   * Spawn Claude with prompt as CLI argument (not stdin)
   *
   * v1.0: CLI argument spawn pattern
   * v1.1: Added execution log file for lineage tracking
   * v2.0: Will add tmux session tracking
   */
  private async spawnClaudeWithArg(
    workingDirectory: string,
    prompt: string,
    timeoutSeconds: number,
    commandId: string,
    commitmentId: string
  ): Promise<BugFixResult> {
    return new Promise((resolve) => {
      this.log(`[v1.1] Spawning claude with CLI arg in ${workingDirectory}`);

      // Create execution log file for lineage
      let logStream: fs.WriteStream | null = null;
      const logPath = path.join(EXECUTION_LOG_DIR, `${commandId}.log`);

      try {
        // Ensure log directory exists
        fs.mkdirSync(EXECUTION_LOG_DIR, { recursive: true });
        logStream = fs.createWriteStream(logPath, { flags: 'a' });

        // Write execution header
        const header = [
          '================================================================================',
          `EXECUTION LOG: ${commandId}`,
          `Commitment: ${commitmentId}`,
          `Started: ${new Date().toISOString()}`,
          `Working Directory: ${workingDirectory}`,
          `Timeout: ${timeoutSeconds}s`,
          '================================================================================',
          '',
          '--- PROMPT ---',
          prompt,
          '',
          '--- OUTPUT ---',
          ''
        ].join('\n');
        logStream.write(header);
        this.log(`Execution log: ${logPath}`);
      } catch (err) {
        this.log(`Warning: Could not create execution log: ${(err as Error).message}`);
      }

      // NEW: Pass prompt as positional argument, NOT via stdin
      const proc = spawn('claude', [
        '--dangerously-skip-permissions',
        '--max-turns', this.MAX_TURNS.toString(),
        prompt,  // ← Prompt as CLI argument
      ], {
        cwd: workingDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],  // stdin ignored (no piping)
        env: {
          ...process.env,
          MENTU_BRIDGE_COMMAND_ID: commandId,
          MENTU_COMMITMENT: commitmentId,
          MENTU_API_URL: this.apiConfig.proxyUrl,
          MENTU_PROXY_TOKEN: this.apiConfig.apiKey,
          MENTU_ACTOR: 'agent:claude-vps',
          ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
            CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          }),
        },
      });

      this.currentProcess = proc;

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        this.log(`Command timed out after ${timeoutSeconds}s`);
        logStream?.write('\n--- TIMEOUT ---\n');
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (this.currentProcess === proc) {
            proc.kill('SIGKILL');
          }
        }, 5000);
      }, timeoutSeconds * 1000);

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        // Stream to log file
        logStream?.write(chunk);
        if (stdout.length % 5000 < chunk.length) {
          this.log(`Output: ${stdout.length} bytes`);
        }
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        // Stream stderr to log file with prefix
        logStream?.write(`[stderr] ${chunk}`);
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        this.currentProcess = null;

        const exitCode = code ?? 1;
        this.log(`Claude exited with code ${exitCode}${timedOut ? ' (timeout)' : ''}`);

        // Write footer and close log
        if (logStream) {
          const footer = [
            '',
            '--- END ---',
            `Completed: ${new Date().toISOString()}`,
            `Exit Code: ${exitCode}`,
            `Status: ${timedOut ? 'TIMEOUT' : (exitCode === 0 ? 'SUCCESS' : 'FAILED')}`,
            '================================================================================'
          ].join('\n');
          logStream.write(footer);
          logStream.end();
        }

        resolve({
          success: !timedOut && exitCode === 0,
          verified: false,
          summary: timedOut
            ? `Timed out after ${timeoutSeconds}s`
            : stdout.slice(-1000) || stderr.slice(-500) || 'No output',
          files_changed: [],
          tests_passed: false,
          blocked_reason: timedOut ? 'Execution timeout' : undefined,
          exit_code: exitCode,
          output: stdout.slice(-10000),
        });
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        this.currentProcess = null;

        this.log(`Spawn error: ${err.message}`);

        // Close log file on error
        if (logStream) {
          logStream.write(`\n--- ERROR ---\n${err.message}\n`);
          logStream.end();
        }

        resolve({
          success: false,
          verified: false,
          summary: `Spawn error: ${err.message}`,
          files_changed: [],
          tests_passed: false,
          blocked_reason: err.message,
          exit_code: 1,
          output: stderr,
        });
      });
    });
  }

  // --------------------------------------------------------------------------
  // Ledger Recording (v2.0 Prep)
  // --------------------------------------------------------------------------

  /**
   * Record execution_start to ledger via mentu capture
   *
   * v1.0: Records for audit trail
   * v2.0: This becomes the dispatch mechanism (instead of bridge_commands)
   */
  private async recordExecutionStart(
    commitmentId: string,
    workingDirectory: string,
    commandId: string
  ): Promise<string | null> {
    try {
      const response = await fetch(`${this.apiConfig.proxyUrl}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Token': this.apiConfig.apiKey,
        },
        body: JSON.stringify({
          op: 'capture',
          body: `Bug execution starting for ${commitmentId}`,
          kind: 'execution_start',
          actor: 'agent:bridge-executor',
          meta: {
            commitment_id: commitmentId,
            working_directory: workingDirectory,
            bridge_command_id: commandId,
            state: 'starting',
            max_turns: this.MAX_TURNS,
            // v2.0 will add: tmux_session, worktree_path
          },
        }),
      });

      if (!response.ok) {
        this.log(`[Ledger] execution_start capture failed: ${await response.text()}`);
        return null;
      }

      const result = await response.json() as { id: string };
      this.log(`[Ledger] Recorded execution_start: ${result.id}`);
      return result.id;

    } catch (err) {
      this.log(`[Ledger] execution_start error: ${err instanceof Error ? err.message : String(err)}`);
      return null;  // Non-fatal: continue execution even if ledger fails
    }
  }

  /**
   * Record execution completion to ledger
   */
  private async recordExecutionComplete(
    executionStartId: string | null,
    commitmentId: string,
    result: BugFixResult
  ): Promise<void> {
    if (!executionStartId) return;

    try {
      await fetch(`${this.apiConfig.proxyUrl}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Token': this.apiConfig.apiKey,
        },
        body: JSON.stringify({
          op: 'annotate',
          target: executionStartId,
          body: result.success
            ? `Execution completed successfully: ${result.summary.slice(0, 200)}`
            : `Execution failed: ${result.blocked_reason || result.summary.slice(0, 200)}`,
          actor: 'agent:bridge-executor',
          meta: {
            state: result.verified ? 'verified' : (result.success ? 'completed' : 'failed'),
            exit_code: result.exit_code,
            files_changed: result.files_changed,
            verified: result.verified,
          },
        }),
      });

      this.log(`[Ledger] Recorded execution completion for ${commitmentId}`);
    } catch (err) {
      this.log(`[Ledger] completion annotation error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --------------------------------------------------------------------------
  // Result Handling & Callbacks
  // --------------------------------------------------------------------------

  private async handleResult(command: BugCommand, result: BugFixResult): Promise<void> {
    const commandId = command.id;
    const commitmentId = command.commitment_id || command.payload?.commitment_id;

    // Success requires verification, not just exit code
    const actualSuccess = result.verified ?? result.success;

    // Update bridge_commands with result
    // Note: Only use columns that exist in the table schema (status, completed_at, result)
    // exit_code, output, error are stored in the result JSONB column
    await this.supabase
      .from('bridge_commands')
      .update({
        status: actualSuccess ? 'completed' : 'failed',
        completed_at: new Date().toISOString(),
        result: {
          success: actualSuccess,
          verified: result.verified,
          summary: result.summary,
          files_changed: result.files_changed,  // From git, not Claude
          tests_passed: result.tests_passed,
          blocked_reason: result.blocked_reason,
          exit_code: result.exit_code,
          verification: result.verification,
          output: result.output?.slice(-5000), // Truncate to avoid huge payloads
        },
      })
      .eq('id', commandId);

    this.log(`Completed ${commandId} - verified: ${result.verified}, success: ${actualSuccess}`);
    this.log(`Verification reason: ${result.verification?.reason}`);

    // Close commitment if verified successful (via Supabase, not local ledger)
    if (actualSuccess && commitmentId) {
      await this.closeCommitment(commitmentId, command.workspace_id, result);
    }

    // Trigger callback if configured
    if (commitmentId) {
      await this.triggerCallback(command, commitmentId, result);
    }
  }

  /**
   * Close the commitment via Supabase after successful execution
   * This handles the case where commitment is in Supabase but not local ledger
   */
  private async closeCommitment(
    commitmentId: string,
    workspaceId: string,
    result: BugFixResult
  ): Promise<void> {
    this.log(`Closing commitment ${commitmentId} via Supabase`);

    try {
      // First capture evidence memory
      const evidenceId = `mem_${crypto.randomBytes(4).toString('hex')}`;
      const evidenceBody = `Bug fix verified: ${result.summary?.slice(0, 500) || 'No summary'}
Files changed: ${result.files_changed?.join(', ') || 'None'}
Git commits: ${result.verification?.gitCommits || 0}
Pushed: ${result.verification?.pushedToRemote ? 'Yes' : 'No'}`;

      // Create evidence memory operation
      await this.supabase.from('operations').insert({
        id: evidenceId,
        workspace_id: workspaceId,
        op: 'capture',
        ts: new Date().toISOString(),
        actor: 'agent:claude-vps',
        payload: {
          body: evidenceBody,
          kind: 'evidence',
        },
      });

      // Create close operation
      const closeOpId = `op_${crypto.randomBytes(4).toString('hex')}`;
      await this.supabase.from('operations').insert({
        id: closeOpId,
        workspace_id: workspaceId,
        op: 'close',
        ts: new Date().toISOString(),
        actor: 'agent:claude-vps',
        payload: {
          commitment: commitmentId,
          evidence: evidenceId,
        },
      });

      // Update commitments table
      await this.supabase
        .from('commitments')
        .update({
          state: 'closed',
          evidence: evidenceId,
          closed_by: 'agent:claude-vps',
          closed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', commitmentId);

      this.log(`Commitment ${commitmentId} closed with evidence ${evidenceId}`);
    } catch (err) {
      this.log(`Warning: Failed to close commitment: ${(err as Error).message}`);
      // Don't throw - execution was successful even if close fails
    }
  }

  private async triggerCallback(
    command: BugCommand,
    commitmentId: string,
    result: BugFixResult
  ): Promise<void> {
    try {
      // Find the source memory to get callback URL
      const { data: commitment } = await this.supabase
        .from('operations')
        .select('payload')
        .eq('id', commitmentId)
        .single();

      const sourceId = commitment?.payload?.source as string | undefined;
      if (!sourceId) return;

      const { data: memory } = await this.supabase
        .from('operations')
        .select('payload')
        .eq('id', sourceId)
        .single();

      const callbackUrl = memory?.payload?.callback_url as string | undefined;
      if (!callbackUrl) return;

      // Build callback payload
      const callbackPayload = {
        commitmentId,
        memoryId: sourceId,
        state: result.success ? 'closed' : 'failed',
        summary: result.summary,
        error: result.blocked_reason,
        files_changed: result.files_changed,
        timestamp: new Date().toISOString(),
      };

      // Sign payload if secret provided
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'Mentu-SimpleBugExecutor/1.0',
      };

      const callbackSecret = memory?.payload?.callback_secret as string | undefined;
      if (callbackSecret) {
        const hmac = crypto.createHmac('sha256', callbackSecret);
        hmac.update(JSON.stringify(callbackPayload));
        headers['X-Mentu-Signature'] = `sha256=${hmac.digest('hex')}`;
      }

      // Deliver callback
      const response = await fetch(callbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(callbackPayload),
      });

      this.log(`Callback to ${callbackUrl}: ${response.status}`);

    } catch (err) {
      this.log(`Callback error: ${err instanceof Error ? err.message : String(err)}`);
      // Don't fail the command - callback is best-effort
    }
  }

  // --------------------------------------------------------------------------
  // Stuck Command Recovery
  // --------------------------------------------------------------------------

  private async recoverStuckCommands(): Promise<void> {
    this.log('Checking for stuck commands...');

    const staleThreshold = new Date(Date.now() - this.STALE_THRESHOLD_MINUTES * 60 * 1000);

    // Find commands stuck in 'claimed' by THIS machine
    const { data: stuckCommands, error } = await this.supabase
      .from('bridge_commands')
      .select('id, status, claimed_at')
      .in('workspace_id', this.workspaceIds)
      .eq('command_type', 'bug_execution')
      .eq('status', 'claimed')
      .eq('claimed_by_machine_id', this.machineId)
      .lt('claimed_at', staleThreshold.toISOString());

    if (error) {
      this.log(`Recovery query error: ${error.message}`);
      return;
    }

    if (!stuckCommands || stuckCommands.length === 0) {
      this.log('No stuck commands found');
      return;
    }

    this.log(`Found ${stuckCommands.length} stuck commands to recover`);

    for (const cmd of stuckCommands) {
      await this.resetToPending(cmd.id);
      this.log(`Reset ${cmd.id} to pending`);
    }

    this.log('Stuck command recovery complete');
  }

  // --------------------------------------------------------------------------
  // Status Updates
  // --------------------------------------------------------------------------

  private async resetToPending(commandId: string): Promise<void> {
    await this.supabase
      .from('bridge_commands')
      .update({
        status: 'pending',
        claimed_by_machine_id: null,
        claimed_at: null,
      })
      .eq('id', commandId);
  }

  private async failCommand(commandId: string, errorMessage: string): Promise<void> {
    await this.supabase
      .from('bridge_commands')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        result: { success: false, error: errorMessage },
      })
      .eq('id', commandId);
  }

  private async updateRetryState(commandId: string, state: RetryState): Promise<void> {
    await this.supabase
      .from('bridge_commands')
      .update({
        result: { retry_state: state },
      })
      .eq('id', commandId);
  }

  // --------------------------------------------------------------------------
  // Utilities
  // --------------------------------------------------------------------------

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private log(message: string): void {
    console.log(`[${new Date().toISOString()}] [SimpleBugExecutor] ${message}`);
  }

  // --------------------------------------------------------------------------
  // Git Verification Helpers
  // --------------------------------------------------------------------------

  private async getHeadRef(cwd: string): Promise<string> {
    return new Promise((resolve) => {
      exec('git rev-parse HEAD', { cwd }, (error, stdout) => {
        if (error) {
          resolve('');
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  private async getCommitsSince(cwd: string, startRef: string): Promise<number> {
    return new Promise((resolve) => {
      exec(`git rev-list ${startRef}..HEAD --count`, { cwd }, (error, stdout) => {
        if (error) {
          resolve(0);
        } else {
          resolve(parseInt(stdout.trim(), 10) || 0);
        }
      });
    });
  }

  private async getFilesChangedSince(cwd: string, startRef: string): Promise<string[]> {
    return new Promise((resolve) => {
      exec(`git diff --name-only ${startRef}..HEAD`, { cwd }, (error, stdout) => {
        if (error || !stdout.trim()) {
          resolve([]);
        } else {
          resolve(stdout.trim().split('\n').filter(Boolean));
        }
      });
    });
  }

  private async checkRemotePush(cwd: string): Promise<boolean> {
    return new Promise((resolve) => {
      exec('git status -sb', { cwd }, (error, stdout) => {
        if (error) {
          resolve(false);
        } else {
          // If output contains "ahead", we haven't pushed
          resolve(!stdout.includes('ahead'));
        }
      });
    });
  }

  // --------------------------------------------------------------------------
  // Ledger Verification (via Supabase)
  // --------------------------------------------------------------------------

  private async checkLedgerClose(_cwd: string, commitmentId: string): Promise<boolean> {
    // Query Supabase for close operation instead of local ledger
    // The mentu CLI syncs to Supabase, so we verify there
    this.log(`Checking Supabase for close operation on ${commitmentId}...`);

    try {
      // Use contains filter for JSONB - more reliable than ->> syntax
      const { data, error } = await this.supabase
        .from('operations')
        .select('id, payload')
        .eq('op', 'close')
        .contains('payload', { commitment: commitmentId })
        .limit(1);

      if (error) {
        this.log(`Supabase close check error: ${error.message}`);
        // Fallback: fetch recent close ops and filter in JS
        const { data: fallbackData } = await this.supabase
          .from('operations')
          .select('id, payload')
          .eq('op', 'close')
          .order('id', { ascending: false })
          .limit(50);

        const found = fallbackData?.some(
          (op: { payload?: { commitment?: string } }) =>
            op.payload?.commitment === commitmentId
        ) ?? false;
        this.log(`Supabase close check (fallback) for ${commitmentId}: ${found ? 'FOUND' : 'not found'}`);
        return found;
      }

      const found = (data?.length ?? 0) > 0;
      this.log(`Supabase close check for ${commitmentId}: ${found ? 'FOUND' : 'not found'}`);
      return found;
    } catch (err) {
      this.log(`Supabase close check exception: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // --------------------------------------------------------------------------
  // Outcome Verification
  // --------------------------------------------------------------------------

  private async verifyOutcome(
    cwd: string,
    commitmentId: string,
    startRef: string,
    claudeResult: { success: boolean; blocked_reason?: string }
  ): Promise<VerificationResult> {
    this.log(`Verifying outcome for ${commitmentId}`);
    this.log(`Start ref: ${startRef}`);

    // Get git state
    const gitCommits = await this.getCommitsSince(cwd, startRef);
    const filesChanged = await this.getFilesChangedSince(cwd, startRef);
    const pushedToRemote = await this.checkRemotePush(cwd);
    const ledgerHasClose = await this.checkLedgerClose(cwd, commitmentId);
    const currentRef = await this.getHeadRef(cwd);

    this.log(`Git commits since start: ${gitCommits}`);
    this.log(`Files changed: ${filesChanged.join(', ') || 'none'}`);
    this.log(`Pushed to remote: ${pushedToRemote}`);
    this.log(`Ledger has close: ${ledgerHasClose}`);

    // Determine verification status
    let verified = false;
    let reason = '';

    if (claudeResult.blocked_reason) {
      // Blocked case: success if properly documented
      verified = ledgerHasClose || claudeResult.blocked_reason.length > 20;
      reason = verified
        ? 'Blocked with documented reason'
        : 'Blocked but no evidence captured';
    } else if (claudeResult.success) {
      // Success case: need commits OR ledger close
      if (gitCommits > 0 && ledgerHasClose) {
        verified = true;
        reason = `Verified: ${gitCommits} commits, ledger closed`;
      } else if (gitCommits > 0) {
        verified = true;
        reason = `Verified: ${gitCommits} commits (ledger close pending sync)`;
      } else if (ledgerHasClose) {
        // Ledger closed but no commits - might be "already fixed"
        verified = false;
        reason = 'Ledger closed but no git commits - unverified fix claim';
      } else {
        verified = false;
        reason = 'Claude claimed success but no git commits and no ledger close';
      }
    } else {
      // Claude reported failure
      verified = false;
      reason = 'Claude reported failure';
    }

    return {
      verified,
      gitCommits,
      filesChanged,
      ledgerHasClose,
      pushedToRemote,
      headRef: currentRef,
      reason,
    };
  }
}
