/**
 * Bug Executor - Main orchestrator with beacon-parity features
 *
 * Ported from beacon/executor.rs for beacon-parity.
 * Integrates: realtime subscription, atomic claiming, genesis enforcement,
 * worktree isolation, and output streaming.
 *
 * v2.0: Multi-workspace support via genesis.key discovery
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "child_process";
import { RealtimeSubscriber, BridgeCommand, RealtimeEvent } from "./realtime-subscriber.js";
import { GenesisEnforcer } from "./genesis-enforcer.js";
import { WorktreeManager } from "./worktree-manager.js";
import { OutputStreamer } from "./output-streamer.js";
import { CraftExecutor } from "./craft-executor.js";
import { isCraftPrompt } from "./prompt-builder.js";
import { writeBugContext } from './context-writer.js';
import type { WorkspaceConfig } from "./types.js";
import type { AuditOutput } from "./types/audit-output.js";

export interface ExecutionResult {
  success: boolean;
  summary: string;
  files_changed: string[];
  tests_passed: boolean;
  pr_url?: string;
  exit_code: number;
  output: string;
  error?: string;
  verification?: string;      // How success was verified
  blocked_reason?: string;    // Why fix couldn't be completed (Frame 2)
}


/**
 * Bug memory structure from operations table
 */
export interface BugMemory {
  id: string;
  op: string;  // 'capture' for memories
  payload: {
    body?: string;
    kind?: string;
    [key: string]: unknown;
  };
}

/**
 * BugExecutor orchestrates the full bug execution lifecycle with beacon-parity features.
 */
export class BugExecutor {
  private supabase: SupabaseClient;
  private workspaces: WorkspaceConfig[];
  private workspaceIds: string[];
  private machineId: string;
  private realtimeSubscribers: RealtimeSubscriber[] = [];
  private genesisEnforcer: GenesisEnforcer | null = null;
  private worktreeManager: WorktreeManager;
  private craftExecutors: Map<string, CraftExecutor> = new Map();
  private isProcessing = false;
  private processingQueue: BridgeCommand[] = [];

  constructor(
    supabase: SupabaseClient,
    workspaces: WorkspaceConfig[],
    machineId: string
  ) {
    this.supabase = supabase;
    this.workspaces = workspaces;
    this.workspaceIds = workspaces.map(w => w.id);
    this.machineId = machineId;

    // Create realtime subscriber for each workspace
    for (const workspace of workspaces) {
      const subscriber = new RealtimeSubscriber(supabase, workspace.id, machineId);
      this.realtimeSubscribers.push(subscriber);

      // Create CraftExecutor per workspace
      this.craftExecutors.set(workspace.id, new CraftExecutor(supabase, workspace.id));
    }

    this.worktreeManager = new WorktreeManager();
  }

  /**
   * Get the CraftExecutor for a workspace
   */
  private getCraftExecutor(workspaceId: string): CraftExecutor {
    let executor = this.craftExecutors.get(workspaceId);
    if (!executor) {
      executor = new CraftExecutor(this.supabase, workspaceId);
      this.craftExecutors.set(workspaceId, executor);
    }
    return executor;
  }

  /**
   * Get workspace config by ID
   */
  private getWorkspace(workspaceId: string): WorkspaceConfig | undefined {
    return this.workspaces.find(w => w.id === workspaceId);
  }

  /**
   * Resolve working directory for a workspace.
   * Bug memories come from a specific workspace (e.g., WarrantyOS).
   * Execution must happen in that workspace's directory.
   */
  private resolveWorkspaceDirectory(workspaceId: string): string | undefined {
    const workspace = this.workspaces.find(w => w.id === workspaceId);
    if (!workspace) {
      console.warn(`[BugExecutor] Unknown workspace: ${workspaceId}`);
      return undefined;
    }
    return workspace.directory;
  }

  /**
   * Clean up stale commands on startup.
   * Commands stuck in pending/claimed/running beyond their timeout are marked as timeout.
   */
  async cleanupStaleCommands(): Promise<void> {
    const maxAgeHours = 4; // Commands older than 4 hours are stale

    const { data: staleCommands, error } = await this.supabase
      .from("bridge_commands")
      .select("id, status, timeout_seconds, created_at")
      .in("status", ["pending", "claimed", "running"])
      .in("workspace_id", this.workspaceIds);

    if (error) {
      console.error("[BugExecutor] Error checking stale commands:", error);
      return;
    }

    const now = new Date();
    let cleanedCount = 0;

    for (const cmd of staleCommands || []) {
      const created = new Date(cmd.created_at);
      const ageHours = (now.getTime() - created.getTime()) / (1000 * 60 * 60);
      const maxAgeForCommand = Math.max(maxAgeHours, (cmd.timeout_seconds || 600) / 3600 * 2);

      if (ageHours > maxAgeForCommand) {
        await this.supabase
          .from("bridge_commands")
          .update({
            status: "timeout",
            error: `Stale command cleaned up after ${ageHours.toFixed(1)} hours`,
            completed_at: new Date().toISOString()
          })
          .eq("id", cmd.id);
        cleanedCount++;
        console.log(`[BugExecutor] Cleaned stale command ${cmd.id} (${ageHours.toFixed(1)}h old)`);
      }
    }

    console.log(`[BugExecutor] Stale cleanup complete: ${cleanedCount} commands marked timeout`);
  }

  /**
   * Start the bug executor
   */
  async start(): Promise<void> {
    console.log(`[BugExecutor] Starting with machineId: ${this.machineId}`);
    console.log(`[BugExecutor] Watching ${this.workspaces.length} workspaces: ${this.workspaces.map(w => w.name).join(', ')}`);

    // Clean up stale commands before starting (F003)
    await this.cleanupStaleCommands();

    // Set up event handler for each subscriber
    for (const subscriber of this.realtimeSubscribers) {
      subscriber.onEvent((event) => this.handleRealtimeEvent(event));
      await subscriber.subscribe();
    }

    // Also poll for any pending commands on startup
    await this.pollPendingCommands();

    console.log("[BugExecutor] Ready and listening for commands");
  }

  /**
   * Stop the bug executor
   */
  async stop(): Promise<void> {
    for (const subscriber of this.realtimeSubscribers) {
      await subscriber.unsubscribe();
    }
    if (this.genesisEnforcer) {
      this.genesisEnforcer.dispose();
    }
    console.log("[BugExecutor] Stopped");
  }

  /**
   * Handle realtime events from the subscriber
   */
  private handleRealtimeEvent(event: RealtimeEvent): void {
    switch (event.type) {
      case 'CommandInserted':
        console.log(`[BugExecutor] New command: ${event.command.id}`);
        this.queueCommand(event.command);
        break;
      case 'CommandUpdated':
        // Handle updates if needed (e.g., approval status changes)
        if (event.command.approval_status === 'approved' && event.command.status === 'pending') {
          console.log(`[BugExecutor] Command approved: ${event.command.id}`);
          this.queueCommand(event.command);
        }
        break;
      case 'Connected':
        console.log("[BugExecutor] Realtime connected");
        break;
      case 'Disconnected':
        console.log("[BugExecutor] Realtime disconnected, will reconnect");
        break;
      case 'Error':
        console.error(`[BugExecutor] Realtime error: ${event.message}`);
        break;
    }
  }

  /**
   * Queue a command for processing
   */
  private queueCommand(command: BridgeCommand): void {
    // Only queue pending commands that target this machine or no specific machine
    if (command.status !== 'pending') return;
    if (command.target_machine_id && command.target_machine_id !== this.machineId) return;

    // Check if already in queue
    if (this.processingQueue.some(c => c.id === command.id)) return;

    this.processingQueue.push(command);
    this.processQueue();
  }

  /**
   * Process queued commands
   */
  private async processQueue(): Promise<void> {
    if (this.isProcessing) return;
    if (this.processingQueue.length === 0) return;

    this.isProcessing = true;

    while (this.processingQueue.length > 0) {
      const command = this.processingQueue.shift()!;
      try {
        await this.executeCommand(command);
      } catch (error) {
        console.error(`[BugExecutor] Error executing ${command.id}:`, error);
      }
    }

    this.isProcessing = false;
  }

  /**
   * Poll for pending commands (startup and reconnect)
   */
  private async pollPendingCommands(): Promise<void> {
    console.log("[BugExecutor] Polling for pending commands");

    if (this.workspaceIds.length === 0) {
      console.log("[BugExecutor] No workspace IDs to poll");
      return;
    }

    const { data, error } = await this.supabase
      .from("bridge_commands")
      .select("*")
      .in("workspace_id", this.workspaceIds)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) {
      console.error("[BugExecutor] Poll error:", error);
      return;
    }

    console.log(`[BugExecutor] Found ${data?.length || 0} pending commands`);
    for (const command of data || []) {
      this.queueCommand(command as BridgeCommand);
    }
  }

  /**
   * Execute a single command
   */
  private async executeCommand(command: BridgeCommand): Promise<void> {
    const commandId = command.id;
    console.log(`[BugExecutor] Processing command ${commandId} (type: ${command.command_type || 'spawn'})`);

    // Step 1: Atomic claim
    const claimed = await this.claimCommand(commandId);
    if (!claimed) {
      console.log(`[BugExecutor] Could not claim ${commandId} (already claimed)`);
      return;
    }

    const workspacePath = command.working_directory;
    let worktreePath: string | undefined;

    try {
      // Step 2: Genesis enforcement
      this.genesisEnforcer = new GenesisEnforcer(workspacePath);
      const enforcement = this.genesisEnforcer.check('agent:bridge-executor', 'execute');

      if (!enforcement.allowed) {
        throw new Error(`Genesis violation: ${enforcement.violation?.message}`);
      }
      console.log(`[BugExecutor] Genesis check passed for ${commandId}`);

      // Step 3: Worktree isolation (if enabled)
      let execDir = workspacePath;
      if (command.with_worktree && command.commitment_id) {
        const worktreeResult = await this.worktreeManager.createWorktree(
          workspacePath,
          command.commitment_id
        );

        if (!worktreeResult.success) {
          throw new Error(`Worktree creation failed: ${worktreeResult.error}`);
        }

        worktreePath = worktreeResult.worktreePath;
        execDir = worktreePath!;
        console.log(`[BugExecutor] Created worktree at ${execDir}`);
      }

      // Update status to running
      await this.updateCommandStatus(commandId, 'running');

      // Step 4: Execute based on command_type
      let result: ExecutionResult;

      if (command.command_type === 'bug_execution') {
        // Use Architect+Auditor+Executor pattern for bug execution
        console.log(`[BugExecutor] Using Architect+Auditor pattern for bug_execution`);
        result = await this.executeBugCommand(command);
      } else {
        // Standard execution with output streaming
        const streamer = new OutputStreamer(this.supabase, commandId, command.workspace_id);
        streamer.start();

        try {
          result = await this.runClaudeCommand(command, execDir, streamer);
        } finally {
          await streamer.stop();
        }
      }

      // Step 5: Update command with result
      await this.completeCommand(commandId, result);
      console.log(`[BugExecutor] Completed ${commandId} - success: ${result.success}`);

      // Step 6: Capture evidence and close commitment (if linked)
      if (command.commitment_id) {
        const evidenceId = await this.captureEvidence(command.workspace_id, command.commitment_id, result);
        await this.closeCommitment(command.workspace_id, command.commitment_id, evidenceId, result.success);
      }

    } catch (error) {
      console.error(`[BugExecutor] Failed ${commandId}:`, error);
      await this.failCommand(commandId, (error as Error).message);

      if (command.commitment_id) {
        await this.handleCommitmentFailure(command.workspace_id, command.commitment_id, error as Error);
      }
    } finally {
      // Cleanup genesis enforcer
      if (this.genesisEnforcer) {
        this.genesisEnforcer.dispose();
        this.genesisEnforcer = null;
      }
    }
  }

  /**
   * Atomic claim using UPDATE...WHERE pattern
   */
  private async claimCommand(commandId: string): Promise<boolean> {
    const { data, error } = await this.supabase
      .from("bridge_commands")
      .update({
        status: 'claimed',
        claimed_by_machine_id: this.machineId,
        claimed_at: new Date().toISOString()
      })
      .eq("id", commandId)
      .eq("status", "pending")
      .select();

    if (error) {
      console.error(`[BugExecutor] Claim error:`, error);
      return false;
    }

    // If no rows updated, someone else claimed it
    return (data?.length ?? 0) > 0;
  }

  /**
   * Update command status
   */
  private async updateCommandStatus(commandId: string, status: string): Promise<void> {
    const updates: Record<string, unknown> = { status };

    if (status === 'running') {
      updates.started_at = new Date().toISOString();
    }

    await this.supabase
      .from("bridge_commands")
      .update(updates)
      .eq("id", commandId);
  }

  /**
   * Complete a command with result
   */
  private async completeCommand(commandId: string, result: ExecutionResult): Promise<void> {
    await this.supabase
      .from("bridge_commands")
      .update({
        status: result.success ? 'completed' : 'failed',
        completed_at: new Date().toISOString(),
        exit_code: result.exit_code,
        output: result.output.slice(-10000), // Truncate to 10KB
        error: result.success ? null : result.summary
      })
      .eq("id", commandId);
  }

  /**
   * Mark a command as failed
   */
  private async failCommand(commandId: string, errorMessage: string): Promise<void> {
    await this.supabase
      .from("bridge_commands")
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        error: errorMessage
      })
      .eq("id", commandId);
  }

  /**
   * Run a Claude command with streaming output
   */
  private async runClaudeCommand(
    command: BridgeCommand,
    execDir: string,
    streamer: OutputStreamer
  ): Promise<ExecutionResult> {
    // Check if this is a /craft command
    if (isCraftPrompt(command.prompt) && command.commitment_id) {
      console.log(`[BugExecutor] Detected /craft command, using CraftExecutor`);

      const craftExecutor = this.getCraftExecutor(command.workspace_id);
      const craftResult = await craftExecutor.execute(
        command.prompt,
        execDir,
        command.commitment_id,
        streamer,
        command.timeout_seconds || 3600,
        command.id  // Pass command ID for spawn_logs correlation
      );

      return {
        success: craftResult.success,
        summary: craftResult.success
          ? `Craft workflow completed. PRD: ${craftResult.prdPath}, HANDOFF: ${craftResult.handoffPath}, RESULT: ${craftResult.resultPath}`
          : `Craft workflow failed at ${craftResult.phase}: ${craftResult.error}`,
        files_changed: [
          craftResult.prdPath,
          craftResult.handoffPath,
          craftResult.resultPath
        ].filter(Boolean) as string[],
        tests_passed: craftResult.success,
        exit_code: craftResult.success ? 0 : 1,
        output: craftResult.output,
      };
    }

    // Original implementation for non-craft commands
    return new Promise<ExecutionResult>((resolve) => {
      const args = [
        "--dangerously-skip-permissions",
        ...command.flags,
        "-p", command.prompt
      ];

      const proc = spawn("claude", args, {
        cwd: execDir,
        timeout: (command.timeout_seconds || 600) * 1000,
        env: {
          ...process.env,
          MENTU_BRIDGE_COMMAND_ID: command.id,
        }
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        streamer.write('stdout', chunk);
      });

      proc.stderr.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        streamer.write('stderr', chunk);
      });

      proc.on("close", (code) => {
        const exitCode = code ?? 1;

        // Try to extract JSON result from output
        const jsonMatch = stdout.match(/\{[\s\S]*?"success"[\s\S]*?\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            resolve({
              success: parsed.success ?? (exitCode === 0),
              summary: parsed.summary ?? stdout.slice(-500),
              files_changed: parsed.files_changed ?? [],
              tests_passed: parsed.tests_passed ?? false,
              pr_url: parsed.pr_url,
              exit_code: exitCode,
              output: stdout
            });
            return;
          } catch {
            // Fall through to default
          }
        }

        resolve({
          success: exitCode === 0,
          summary: stdout.slice(-1000) || stderr.slice(-500) || "No output",
          files_changed: [],
          tests_passed: false,
          exit_code: exitCode,
          output: stdout
        });
      });

      proc.on("error", (err) => {
        resolve({
          success: false,
          summary: `Spawn error: ${err.message}`,
          files_changed: [],
          tests_passed: false,
          exit_code: 1,
          output: stderr
        });
      });
    });
  }

  /**
   * Capture execution evidence
   */
  private async captureEvidence(workspaceId: string, commitmentId: string, result: ExecutionResult): Promise<string> {
    const evidenceId = `mem_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const { data, error } = await this.supabase.from("operations").insert({
      id: evidenceId,
      op: "capture",
      ts: new Date().toISOString(),
      actor: "agent:bridge-executor",
      payload: {
        kind: "execution-result",
        body: `Bug fix execution completed.\n\nSuccess: ${result.success}\nSummary: ${result.summary}\nFiles: ${result.files_changed.join(", ") || "none"}\nTests: ${result.tests_passed}`,
        result: result,
        refs: [commitmentId]
      },
      workspace_id: workspaceId
    }).select("id").single();

    if (error) {
      throw new Error(`Failed to capture evidence: ${error?.message}`);
    }

    return evidenceId;
  }

  /**
   * Close a commitment with evidence
   */
  private async closeCommitment(workspaceId: string, commitmentId: string, evidenceId: string, success: boolean): Promise<void> {
    const closeId = `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await this.supabase.from("operations").insert({
      id: closeId,
      op: "close",
      ts: new Date().toISOString(),
      actor: "agent:bridge-executor",
      payload: {
        target: commitmentId,
        evidence: evidenceId,
        outcome: success ? "completed" : "failed"
      },
      workspace_id: workspaceId
    });
  }

  /**
   * Handle commitment failure (annotate + release)
   */
  private async handleCommitmentFailure(workspaceId: string, commitmentId: string, error: Error): Promise<void> {
    // Annotate with failure
    const annotateId = `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await this.supabase.from("operations").insert({
      id: annotateId,
      op: "annotate",
      ts: new Date().toISOString(),
      actor: "agent:bridge-executor",
      payload: {
        target: commitmentId,
        body: `Execution failed: ${error.message}`,
        kind: "execution-failure"
      },
      workspace_id: workspaceId
    });

    // Release claim
    const releaseId = `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    await this.supabase.from("operations").insert({
      id: releaseId,
      op: "release",
      ts: new Date().toISOString(),
      actor: "agent:bridge-executor",
      payload: {
        target: commitmentId,
        reason: error.message
      },
      workspace_id: workspaceId
    });
  }

  /**
   * Fetch bug memory from operations table
   */
  private async fetchBugMemory(workspaceId: string, memoryId: string): Promise<BugMemory | null> {
    const { data, error } = await this.supabase
      .from("operations")
      .select("id, op, payload")
      .eq("id", memoryId)
      .eq("workspace_id", workspaceId)
      .single();

    if (error || !data) {
      console.error(`[BugExecutor] Failed to fetch memory ${memoryId}:`, error);
      return null;
    }

    return data as BugMemory;
  }

  /**
   * Extract essential bug info to minimize context window usage.
   *
   * Instead of passing the entire bug payload (~7000 tokens), extract only:
   * - Description (first paragraph, max 500 chars)
   * - Page URL
   * - Element targeted
   * - Screenshot URL
   * - Summary stats
   *
   * Full diagnostic data remains available via memory ID if needed.
   */
  private extractEssentialBugInfo(bugMemory: BugMemory): string {
    const payload = bugMemory.payload || {};
    const body = (payload.body as string) || '';
    const meta = (payload.meta as Record<string, unknown>) || {};

    // Extract just the description (before "---" separator or first 500 chars)
    const description = body.split('---')[0]?.trim().slice(0, 500) || body.slice(0, 500);

    // Build minimal context (~300 tokens instead of ~7000)
    return `## Bug Report

**Description**: ${description}

**Page**: ${meta.page_url || 'Unknown'}
**Element**: ${meta.element_text || 'Not specified'} (${meta.element_tag || 'unknown'})
**Screenshot**: ${meta.screenshot_url || 'None'}

**Stats**: ${meta.console_error_count || 0} errors, ${meta.behavior_event_count || 0} user actions recorded

Note: Full diagnostic data available in memory ${bugMemory.id} if needed.`;
  }

  /**
   * Craft audit boundaries via the Auditor role.
   *
   * The Auditor analyzes the bug and produces BOUNDARIES, not steps.
   * The Executor will decide HOW to fix within these boundaries.
   */
  private async craftAudit(bugMemory: BugMemory, workingDirectory: string): Promise<AuditOutput> {
    const bugContent = this.extractEssentialBugInfo(bugMemory);
    console.log(`[BugExecutor] Extracted bug info (${bugContent.length} chars):`);
    console.log(bugContent);

    const prompt = `You are the AUDITOR for a bug fix.

## Your Role (from Dual Triad)
- You CANNOT create vision (the bug report is the Architect's intent)
- You CAN see everything (codebase, history, context)
- Your job: Define BOUNDARIES for the Executor, NOT steps

## Bug Report
${bugContent}

## Working Directory
${workingDirectory}

## Your Task
1. Analyze the bug - what do you believe is broken?
2. Identify likely files involved
3. Define BOUNDARIES for the Executor:
   - Objective: What does "fixed" look like?
   - Scope: What files CAN and CANNOT be modified?
   - Constraints: What MUST NOT happen?
   - Success criteria: How to verify it works?

## CRITICAL RULES
- Do NOT output steps or instructions
- Do NOT tell the Executor what to do step-by-step
- The Executor has tools (Read, Edit, Bash, Grep) and will decide how to use them
- You define the GOAL and BOUNDARIES, the Executor figures out the PATH

## Output Format
Return ONLY this JSON (no markdown, no explanation):
{
  "context": {
    "hypothesis": "What you believe is broken",
    "likely_files": ["path/to/file1.ts", "path/to/file2.ts"],
    "confidence": 0.8
  },
  "audit": {
    "objective": "Clear statement of what 'fixed' means",
    "scope": {
      "allowed_patterns": ["src/**/*.ts", "src/**/*.tsx"],
      "forbidden_patterns": ["*.config.*", "package.json", "*.lock"],
      "max_file_changes": 5
    },
    "constraints": [
      "Must NOT break existing tests",
      "Must NOT add new dependencies",
      "Must NOT modify database schema"
    ],
    "success_criteria": [
      "The specific bug behavior no longer occurs",
      "Existing tests continue to pass",
      "TypeScript compiles without errors"
    ]
  }
}`;

    console.log(`[BugExecutor] Calling Auditor (prompt: ${prompt.length} chars)...`);
    const startTime = Date.now();
    const output = await this.callClaudeSimple(prompt, workingDirectory, 180_000); // 3 min for complex analysis
    console.log(`[BugExecutor] Auditor completed in ${Date.now() - startTime}ms`);
    console.log(`[BugExecutor] Auditor raw output (first 500 chars): ${output.slice(0, 500)}`);

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error(`[BugExecutor] No JSON found in output. Full output: ${output}`);
      throw new Error("No JSON found in auditor output");
    }
    return JSON.parse(jsonMatch[0]) as AuditOutput;
  }

  /**
   * Spawn the Executor with bounded scope.
   *
   * The Executor receives:
   * - Objective (what to achieve)
   * - Context (hypothesis, likely files)
   * - Scope boundaries (allowed/forbidden patterns)
   * - Constraints (what must NOT happen)
   * - Success criteria (how to verify)
   *
   * The Executor has tools (Read, Edit, Bash, Grep, Glob) and DECIDES which to use.
   * NO prescriptive steps. NO "1. Do this, 2. Do that".
   */
  private async spawnExecutor(
    audit: AuditOutput,
    workingDirectory: string,
    timeoutSeconds: number
  ): Promise<ExecutionResult> {
    const executorPrompt = `You are the EXECUTOR fixing a bug.

## Your Role (from Dual Triad)
- You have FULL filesystem access within scope
- You DECIDE which tools to use (Read, Edit, Bash, Grep, Glob)
- You are BOUNDED by the Auditor's scope - do not exceed it
- You figure out HOW to achieve the objective

## Objective
${audit.audit.objective}

## Context from Auditor
Hypothesis: ${audit.context.hypothesis}
Likely relevant files: ${audit.context.likely_files.join(", ")}
Confidence: ${audit.context.confidence}

## Scope Boundaries (MUST RESPECT)
- Allowed to modify: ${audit.audit.scope.allowed_patterns.join(", ")}
- FORBIDDEN to touch: ${audit.audit.scope.forbidden_patterns.join(", ")}
- Maximum files to change: ${audit.audit.scope.max_file_changes}

## Constraints (MUST NOT VIOLATE)
${audit.audit.constraints.map(c => `- ${c}`).join("\n")}

## Success Criteria (HOW TO VERIFY)
${audit.audit.success_criteria.map(c => `- ${c}`).join("\n")}

## Your Tools
You have: Read, Edit, Bash, Grep, Glob
Use them as YOU decide. There are no prescribed steps.

## When Complete
Output ONLY this JSON:
{
  "success": true,
  "summary": "Brief description of what you did",
  "files_changed": ["file1.ts", "file2.ts"],
  "verification": "How you verified success criteria were met",
  "tests_passed": true
}

If you cannot fix within scope, output:
{
  "success": false,
  "summary": "Why the fix is not possible within scope",
  "files_changed": [],
  "verification": "What was attempted",
  "tests_passed": false,
  "blocked_reason": "Explanation"
}`;

    const output = await this.callClaude(
      executorPrompt,
      workingDirectory,
      timeoutSeconds * 1000
    );

    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          success: parsed.success ?? false,
          summary: parsed.summary ?? output.slice(-500),
          files_changed: parsed.files_changed ?? [],
          verification: parsed.verification ?? "Not provided",
          tests_passed: parsed.tests_passed ?? false,
          pr_url: parsed.pr_url,
          blocked_reason: parsed.blocked_reason,  // Frame 2: Capture why fix couldn't complete
          exit_code: parsed.success ? 0 : 1,
          output: output
        };
      } catch {
        // Fall through to default
      }
    }

    return {
      success: false,
      summary: `Output unparseable: ${output.slice(-500)}`,
      files_changed: [],
      verification: "Parse failed",
      tests_passed: false,
      blocked_reason: "Output parse failed",  // Frame 2: Indicate failure reason
      exit_code: 1,
      output: output,
      error: "Output parse failed"
    };
  }

  /**
   * Log scope compliance (advisory - does not block execution)
   * Frame 2: Trust but verify. Log what happens.
   */
  private logScopeCompliance(audit: AuditOutput, result: ExecutionResult): void {
    const { forbidden_patterns, max_file_changes } = audit.audit.scope;

    // Log file count vs limit
    if (result.files_changed.length > max_file_changes) {
      console.warn(`[BugExecutor] SCOPE WARNING: Changed ${result.files_changed.length} files (limit: ${max_file_changes})`);
    }

    // Log forbidden pattern matches (advisory)
    for (const file of result.files_changed) {
      for (const pattern of forbidden_patterns) {
        // Simple string match for v1.0 (full minimatch for v2.0)
        const patternBase = pattern.replace(/\*/g, '');
        if (patternBase && file.includes(patternBase)) {
          console.warn(`[BugExecutor] SCOPE WARNING: ${file} may match forbidden pattern ${pattern}`);
        }
      }
    }

    console.log(`[BugExecutor] Scope compliance logged: ${result.files_changed.length} files changed`);
  }

  /**
   * Call Claude CLI in headless mode with tools enabled.
   * IMPORTANT: shell: true is required for Claude to work properly via spawn.
   */
  private callClaude(prompt: string, cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // Escape prompt for shell safety
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const proc = spawn("claude", [
        "--dangerously-skip-permissions",
        "--max-turns", "30",
        "-p", `'${escapedPrompt}'`
      ], {
        cwd,
        timeout: timeoutMs,
        shell: true,
        env: { ...process.env }
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(`Claude exited ${code}: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * Call Claude CLI for simple JSON output.
   * Uses --max-turns 5 to allow some tool exploration before JSON response.
   * IMPORTANT: shell: true is required for Claude to work properly via spawn.
   */
  private callClaudeSimple(prompt: string, cwd: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      // Escape prompt for shell safety
      const escapedPrompt = prompt.replace(/'/g, "'\\''");
      const proc = spawn("claude", [
        "--dangerously-skip-permissions",
        "--max-turns", "5",
        "-p", `'${escapedPrompt}'`
      ], {
        cwd,
        timeout: timeoutMs,
        shell: true,
        env: { ...process.env }
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => { stdout += data.toString(); });
      proc.stderr.on("data", (data) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        if (code !== 0 && !stdout) {
          reject(new Error(`Claude exited ${code}: ${stderr}`));
        } else {
          resolve(stdout);
        }
      });

      proc.on("error", reject);
    });
  }

  /**
   * Execute a bug_execution command using terminal-based Claude spawning.
   *
   * ARCHITECTURE CHANGE (v2.0):
   * - Bridge is INFRASTRUCTURE only (no ledger operations)
   * - Claude is the ACTOR (claims, captures, closes)
   * - Auditor still runs headless for boundary analysis
   * - Executor spawns in terminal mode with mentu CLI access
   */
  async executeBugCommand(command: BridgeCommand & { payload?: { memory_id?: string; commitment_id?: string; timeout_seconds?: number } }): Promise<ExecutionResult> {
    const payload = command.payload || {};
    const memoryId = payload.memory_id;
    const commitmentId = command.commitment_id || payload.commitment_id;
    const timeoutSeconds = payload.timeout_seconds || command.timeout_seconds || 3600;

    // CRITICAL FIX: Use command.working_directory directly
    // Do NOT use resolveWorkspaceDirectory() which overrides with workspace config
    const workingDirectory = command.working_directory;
    console.log(`[BugExecutor] Using command working_directory: ${workingDirectory}`);

    if (!memoryId) {
      throw new Error("Bug execution requires payload.memory_id");
    }

    if (!commitmentId) {
      throw new Error("Bug execution requires commitment_id");
    }

    // Update status to running (sets started_at)
    await this.updateCommandStatus(command.id, 'running');

    // Step 1: Fetch bug memory
    console.log(`[BugExecutor] Fetching bug memory ${memoryId}`);
    const bugMemory = await this.fetchBugMemory(command.workspace_id, memoryId);
    if (!bugMemory) {
      throw new Error(`Bug memory ${memoryId} not found`);
    }

    // Step 2: Auditor - craft scoped boundaries (still headless, returns JSON)
    console.log(`[BugExecutor] Crafting audit boundaries via Auditor`);
    const audit = await this.craftAudit(bugMemory, workingDirectory);
    console.log(`[BugExecutor] Auditor hypothesis: ${audit.context.hypothesis}`);

    // Step 3: Write context file for Claude to read
    console.log(`[BugExecutor] Writing bug context file`);
    const contextPath = await writeBugContext({
      commitmentId,
      audit,
      workingDirectory
    });
    console.log(`[BugExecutor] Context written to: ${contextPath}`);

    // Step 4: Spawn Claude in terminal mode
    // Claude will claim, fix, capture evidence, and close
    console.log(`[BugExecutor] Spawning terminal executor in ${workingDirectory}`);
    const result = await this.spawnTerminalExecutor(workingDirectory, commitmentId, timeoutSeconds, command.id);

    // Step 5: Store result in bridge_commands.result
    const { error: updateError } = await this.supabase
      .from("bridge_commands")
      .update({ result: { audit, execution: result } })
      .eq("id", command.id)
      .select();

    if (updateError) {
      console.error(`[BugExecutor] Failed to store result for ${command.id}:`, updateError);
    } else {
      console.log(`[BugExecutor] Result stored for ${command.id}`);
    }

    // NOTE: Bridge does NOT claim or close
    // Claude is expected to do this via mentu CLI
    return result;
  }

  /**
   * Spawn Claude in terminal mode.
   *
   * Claude runs IN the workspace with full tool access and mentu CLI.
   * Bridge's job is done after spawning - Claude handles claim/close.
   */
  private async spawnTerminalExecutor(
    workingDirectory: string,
    commitmentId: string,
    timeoutSeconds: number,
    commandId: string
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      const prompt = `You are fixing a bug for commitment ${commitmentId}.

Read .mentu/bug-context.md for full instructions.

Key steps:
1. mentu claim ${commitmentId}
2. Fix the bug (you have Read, Edit, Bash, Grep, Glob)
3. Verify your fix
4. mentu capture "Fixed: <summary>" --kind evidence
5. mentu close ${commitmentId} --evidence <mem_id>

When complete, output JSON:
{"success": true, "summary": "what you did", "files_changed": ["file.ts"]}`;

      console.log(`[BugExecutor] Spawning Claude in: ${workingDirectory}`);

      const proc = spawn("claude", [
        "--dangerously-skip-permissions",
        "--max-turns", "50",
        "-p", prompt
      ], {
        cwd: workingDirectory,
        timeout: timeoutSeconds * 1000,
        env: {
          ...process.env,
          MENTU_BRIDGE_COMMAND_ID: commandId,
        }
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        const chunk = data.toString();
        stdout += chunk;
        console.log(`[Executor] ${chunk.trim()}`);
      });

      proc.stderr.on("data", (data) => {
        const chunk = data.toString();
        stderr += chunk;
        console.error(`[Executor:stderr] ${chunk.trim()}`);
      });

      proc.on("close", (code) => {
        const exitCode = code ?? 1;
        console.log(`[BugExecutor] Claude exited with code ${exitCode}`);

        // Try to extract JSON result from output
        const jsonMatch = stdout.match(/\{[\s\S]*?"success"[\s\S]*?\}/);
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            resolve({
              success: parsed.success ?? (exitCode === 0),
              summary: parsed.summary ?? stdout.slice(-500),
              files_changed: parsed.files_changed ?? [],
              tests_passed: parsed.tests_passed ?? false,
              exit_code: exitCode,
              output: stdout
            });
            return;
          } catch {
            // Fall through to default
          }
        }

        resolve({
          success: exitCode === 0,
          summary: stdout.slice(-1000) || stderr.slice(-500) || "No output",
          files_changed: [],
          tests_passed: false,
          exit_code: exitCode,
          output: stdout
        });
      });

      proc.on("error", (err) => {
        console.error(`[BugExecutor] Spawn error:`, err);
        resolve({
          success: false,
          summary: `Spawn error: ${err.message}`,
          files_changed: [],
          tests_passed: false,
          exit_code: 1,
          output: stderr
        });
      });
    });
  }
}
