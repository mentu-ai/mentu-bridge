/**
 * Bug Executor - Main orchestrator with beacon-parity features
 *
 * Ported from beacon/executor.rs for beacon-parity.
 * Integrates: realtime subscription, atomic claiming, genesis enforcement,
 * worktree isolation, and output streaming.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "child_process";
import { RealtimeSubscriber, BridgeCommand, RealtimeEvent } from "./realtime-subscriber.js";
import { GenesisEnforcer } from "./genesis-enforcer.js";
import { WorktreeManager } from "./worktree-manager.js";
import { OutputStreamer } from "./output-streamer.js";
import { CraftExecutor } from "./craft-executor.js";
import { isCraftPrompt } from "./prompt-builder.js";

export interface ExecutionResult {
  success: boolean;
  summary: string;
  files_changed: string[];
  tests_passed: boolean;
  pr_url?: string;
  exit_code: number;
  output: string;
}

/**
 * BugExecutor orchestrates the full bug execution lifecycle with beacon-parity features.
 */
export class BugExecutor {
  private supabase: SupabaseClient;
  private workspaceId: string;
  private machineId: string;
  private realtimeSubscriber: RealtimeSubscriber;
  private genesisEnforcer: GenesisEnforcer | null = null;
  private worktreeManager: WorktreeManager;
  private craftExecutor: CraftExecutor;
  private isProcessing = false;
  private processingQueue: BridgeCommand[] = [];

  constructor(
    supabase: SupabaseClient,
    workspaceId: string,
    machineId: string
  ) {
    this.supabase = supabase;
    this.workspaceId = workspaceId;
    this.machineId = machineId;
    this.realtimeSubscriber = new RealtimeSubscriber(supabase, workspaceId, machineId);
    this.worktreeManager = new WorktreeManager();
    this.craftExecutor = new CraftExecutor(supabase, workspaceId);
  }

  /**
   * Start the bug executor
   */
  async start(): Promise<void> {
    console.log(`[BugExecutor] Starting with machineId: ${this.machineId}`);

    // Set up event handler
    this.realtimeSubscriber.onEvent((event) => this.handleRealtimeEvent(event));

    // Subscribe to realtime changes
    await this.realtimeSubscriber.subscribe();

    // Also poll for any pending commands on startup
    await this.pollPendingCommands();

    console.log("[BugExecutor] Ready and listening for commands");
  }

  /**
   * Stop the bug executor
   */
  async stop(): Promise<void> {
    await this.realtimeSubscriber.unsubscribe();
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

    const { data, error } = await this.supabase
      .from("bridge_commands")
      .select("*")
      .eq("workspace_id", this.workspaceId)
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(10);

    if (error) {
      console.error("[BugExecutor] Poll error:", error);
      return;
    }

    for (const command of data || []) {
      this.queueCommand(command as BridgeCommand);
    }
  }

  /**
   * Execute a single command
   */
  private async executeCommand(command: BridgeCommand): Promise<void> {
    const commandId = command.id;
    console.log(`[BugExecutor] Processing command ${commandId}`);

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

      // Step 4: Execute with output streaming
      const streamer = new OutputStreamer(this.supabase, commandId, this.workspaceId);
      streamer.start();

      try {
        const result = await this.runClaudeCommand(command, execDir, streamer);

        // Step 5: Update command with result
        await this.completeCommand(commandId, result);
        console.log(`[BugExecutor] Completed ${commandId} - success: ${result.success}`);

        // Step 6: Capture evidence and close commitment (if linked)
        if (command.commitment_id) {
          const evidenceId = await this.captureEvidence(command.commitment_id, result);
          await this.closeCommitment(command.commitment_id, evidenceId, result.success);
        }

      } finally {
        await streamer.stop();
      }

    } catch (error) {
      console.error(`[BugExecutor] Failed ${commandId}:`, error);
      await this.failCommand(commandId, (error as Error).message);

      if (command.commitment_id) {
        await this.handleCommitmentFailure(command.commitment_id, error as Error);
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

      const craftResult = await this.craftExecutor.execute(
        command.prompt,
        execDir,
        command.commitment_id,
        streamer,
        command.timeout_seconds || 3600
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
        env: { ...process.env }
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
  private async captureEvidence(commitmentId: string, result: ExecutionResult): Promise<string> {
    const { data, error } = await this.supabase.from("operations").insert({
      type: "capture",
      payload: {
        kind: "execution-result",
        body: `Bug fix execution completed.\n\nSuccess: ${result.success}\nSummary: ${result.summary}\nFiles: ${result.files_changed.join(", ") || "none"}\nTests: ${result.tests_passed}`,
        result: result,
        refs: [commitmentId]
      },
      workspace_id: this.workspaceId
    }).select("id").single();

    if (error || !data) {
      throw new Error(`Failed to capture evidence: ${error?.message}`);
    }

    return data.id;
  }

  /**
   * Close a commitment with evidence
   */
  private async closeCommitment(commitmentId: string, evidenceId: string, success: boolean): Promise<void> {
    await this.supabase.from("operations").insert({
      type: "close",
      payload: {
        target: commitmentId,
        evidence: evidenceId,
        outcome: success ? "completed" : "failed"
      },
      workspace_id: this.workspaceId
    });
  }

  /**
   * Handle commitment failure (annotate + release)
   */
  private async handleCommitmentFailure(commitmentId: string, error: Error): Promise<void> {
    // Annotate with failure
    await this.supabase.from("operations").insert({
      type: "annotate",
      payload: {
        target: commitmentId,
        body: `Execution failed: ${error.message}`,
        kind: "execution-failure"
      },
      workspace_id: this.workspaceId
    });

    // Release claim
    await this.supabase.from("operations").insert({
      type: "release",
      payload: {
        target: commitmentId,
        reason: error.message
      },
      workspace_id: this.workspaceId
    });
  }
}
