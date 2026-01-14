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
import type { WorkspaceConfig } from "./types.js";

// ============================================================================
// Types
// ============================================================================

export interface SimpleBugExecutorConfig {
  pollIntervalMs?: number;      // Default: 30000 (30s)
  maxRetries?: number;          // Default: 3
  baseBackoffMs?: number;       // Default: 1000 (1s)
  timeoutSeconds?: number;      // Default: 3600 (1 hour)
  staleThresholdMinutes?: number;  // Default: 30
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

    // Update status to running
    await this.supabase
      .from('bridge_commands')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .eq('id', command.id);

    // Capture starting git ref for verification
    const startRef = await this.getHeadRef(workingDirectory);
    this.log(`Starting ref: ${startRef}`);

    // Fetch bug memory
    this.log(`Fetching bug memory ${memoryId}`);
    const bugMemory = await this.fetchBugMemory(command.workspace_id, memoryId);
    if (!bugMemory) {
      throw new Error(`Bug memory ${memoryId} not found`);
    }

    // Build unified prompt (single agent - no auditor phase)
    const prompt = this.buildUnifiedBugPrompt(
      bugMemory,
      commitmentId,
      workingDirectory,
      command.workspace_id
    );

    // Spawn Claude via stdin (NOT -p flag)
    this.log(`Spawning Claude in ${workingDirectory} (timeout: ${timeoutSeconds}s)`);
    const claudeResult = await this.spawnTerminalClaude(
      workingDirectory,
      prompt,
      timeoutSeconds,
      command.id
    );

    // Verify outcomes - check git commits and ledger state
    const verification = await this.verifyOutcome(
      workingDirectory,
      commitmentId,
      startRef,
      { success: claudeResult.success, blocked_reason: claudeResult.blocked_reason }
    );

    // Return result with verification data
    return {
      ...claudeResult,
      verified: verification.verified,
      files_changed: verification.filesChanged.length > 0
        ? verification.filesChanged
        : claudeResult.files_changed,
      verification,
    };
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
  // Unified Bug Prompt (No Auditor Phase)
  // --------------------------------------------------------------------------

  private buildUnifiedBugPrompt(
    bugMemory: BugMemory,
    commitmentId: string,
    workingDirectory: string,
    _workspaceId: string
  ): string {
    const bugInfo = this.extractBugInfo(bugMemory);

    // Format console errors
    const consoleErrorsText = bugInfo.consoleErrors
      ?.map(e => `- [${e.level}] ${e.message}`)
      .join('\n') || 'None recorded';

    // Format behavior trace
    const behaviorText = bugInfo.behaviorTrace
      ?.slice(-10)
      .map(a => `- ${a.type}: ${a.target || ''}`)
      .join('\n') || 'Not recorded';

    return `# Bug Fix Task

You are fixing a bug. Your job is to:
1. **Analyze** the bug to understand the root cause
2. **Implement** a focused fix
3. **Verify** the fix works
4. **Close** the commitment with evidence

## Bug Report

**Description**: ${bugInfo.description}

**Page URL**: ${bugInfo.pageUrl || 'Not provided'}
**Element**: ${bugInfo.elementText || 'Not specified'}
**Screenshot**: ${bugInfo.screenshotUrl || 'None'}

## Console Errors
${consoleErrorsText}

## User Behavior (last 10 actions)
${behaviorText}

---

## Your Process

### Phase 1: Analysis
Before touching any code:
- Search for relevant files using Grep/Glob
- Read the likely affected code
- Form a hypothesis about the root cause
- Identify which files need changes (max 5 files)

### Phase 2: Implementation
- Make minimal, focused changes
- Do NOT modify: package.json, *.lock, *.config.*, test fixtures
- Keep changes to the identified files only

### Phase 3: Verification
Run appropriate checks:
- TypeScript: npx tsc --noEmit
- Tests: npm test (if test files exist for changed code)
- Build: npm run build (if build script exists)

### Phase 4: Closure
When complete, you MUST:

1. **Commit your changes** (if any files were modified):
\`\`\`bash
git add -A
git commit -m "fix: <brief description of fix>

Fixes bug: ${bugInfo.description.slice(0, 50)}..."
git push origin HEAD
\`\`\`

2. **Capture evidence** (run from ${workingDirectory}):
\`\`\`bash
mentu capture "Fixed: <your summary here>" --kind evidence --actor agent:claude-vps
\`\`\`
This outputs a memory ID like mem_XXXXXXXX. Copy that ID.

3. **Close commitment** (use the mem_ID from above):
\`\`\`bash
mentu close ${commitmentId} --evidence mem_XXXXXXXX --actor agent:claude-vps
\`\`\`

**IMPORTANT**: The mentu commands write to the LOCAL ledger at .mentu/ledger.jsonl.
This is how we verify your work was actually done.

---

## Constraints

- Maximum 5 files changed
- Do NOT add new dependencies
- Do NOT modify configuration files
- If you cannot fix within scope, capture a "blocked" memory and stop

## Working Directory

${workingDirectory}

## Commitment ID

${commitmentId}

---

## Output

When complete, output this JSON on its own line:
{
  "success": true,
  "summary": "Brief description of what was fixed",
  "files_changed": ["path/to/file1.ts"],
  "tests_passed": true
}

If blocked, output:
{
  "success": false,
  "summary": "Why fix could not be completed",
  "blocked_reason": "Specific blocker",
  "files_changed": []
}

---

Begin by searching for code related to the bug description.`;
  }

  private extractBugInfo(memory: BugMemory): {
    description: string;
    pageUrl?: string;
    elementText?: string;
    screenshotUrl?: string;
    consoleErrors?: Array<{ level: string; message: string }>;
    behaviorTrace?: Array<{ type: string; target?: string }>;
  } {
    const payload = memory.payload || {};
    const body = (payload.body as string) || '';
    const meta = payload.meta || {};

    // Extract first paragraph as description (before --- separator)
    const description = body.split('---')[0]?.trim().slice(0, 800) || body.slice(0, 800);

    return {
      description,
      pageUrl: meta.page_url as string | undefined,
      elementText: meta.element_text as string | undefined,
      screenshotUrl: meta.screenshot_url as string | undefined,
      consoleErrors: meta.console_errors as Array<{ level: string; message: string }> | undefined,
      behaviorTrace: meta.behavior_trace as Array<{ type: string; target?: string }> | undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Terminal Claude Spawn (via stdin, NOT -p flag)
  // --------------------------------------------------------------------------

  private async spawnTerminalClaude(
    workingDirectory: string,
    prompt: string,
    timeoutSeconds: number,
    commandId: string
  ): Promise<BugFixResult> {
    return new Promise((resolve) => {
      this.log(`Spawning claude in terminal mode`);

      const proc = spawn('claude', [
        '--dangerously-skip-permissions',
        '--max-turns', '30',
      ], {
        cwd: workingDirectory,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MENTU_BRIDGE_COMMAND_ID: commandId,
          MENTU_API_URL: this.apiConfig.proxyUrl,
          MENTU_PROXY_TOKEN: this.apiConfig.apiKey,
          MENTU_ACTOR: 'agent:claude-vps',
          // Ensure OAuth token is passed
          ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
            CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
          }),
        },
      });

      this.currentProcess = proc;

      // Pipe prompt to stdin
      proc.stdin.write(prompt);
      proc.stdin.end();

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // Timeout handler
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        this.log(`Command timed out after ${timeoutSeconds}s`);
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
        // Log progress every 2KB
        if (stdout.length % 2000 < chunk.length) {
          this.log(`Output: ${stdout.length} bytes`);
        }
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        this.currentProcess = null;

        const exitCode = code ?? 1;
        this.log(`Claude exited with code ${exitCode}${timedOut ? ' (timeout)' : ''}`);

        // Try to extract JSON result from output
        const jsonMatch = stdout.match(/\{[\s\S]*?"success"[\s\S]*?\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            resolve({
              success: parsed.success ?? (exitCode === 0),
              verified: false,  // Will be set by verifyOutcome
              summary: parsed.summary ?? stdout.slice(-500),
              files_changed: parsed.files_changed ?? [],
              tests_passed: parsed.tests_passed ?? false,
              blocked_reason: parsed.blocked_reason,
              exit_code: exitCode,
              output: stdout.slice(-10000),
            });
            return;
          } catch {
            // Fall through to default
          }
        }

        resolve({
          success: !timedOut && exitCode === 0,
          verified: false,  // Will be set by verifyOutcome
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
        resolve({
          success: false,
          verified: false,  // Will be set by verifyOutcome
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

    // Trigger callback if configured
    if (commitmentId) {
      await this.triggerCallback(command, commitmentId, result);
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
