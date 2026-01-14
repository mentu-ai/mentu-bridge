---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: HANDOFF-BugExecutionLoop-v1.0
path: docs/HANDOFF-BugExecutionLoop-v1.0.md
type: handoff
intent: execute

version: "1.1"
created: 2026-01-11
last_updated: 2026-01-11

tier: T2
author_type: executor

parent: PRD-BugExecutionLoop-v1.0
children:
  - PROMPT-BugExecutionLoop-v1.0

mentu:
  commitment: cmt_6c8e6d56
  status: pending

validation:
  required: true
  tier: T2
---

# HANDOFF: Bug Execution Loop v1.0

## For the Coding Agent

Build a bug execution system in mentu-bridge with beacon-parity features: WebSocket realtime subscription, atomic claiming, genesis enforcement, worktree isolation, and output streaming. VPS-first deployment.

**Read the full PRD**: `docs/PRD-BugExecutionLoop-v1.0.md`

**Target**: VPS (208.167.255.71) running as systemd service

---

## Your Identity

You are operating as **executor** (from this HANDOFF's `author_type` field).

Your actor identity comes from the repository manifest (`.mentu/manifest.yaml`).

| Dimension | Source | Value |
|-----------|--------|-------|
| **Actor** | Repository manifest | (auto-resolved) |
| **Author Type** | This HANDOFF | executor |
| **Context** | Working directory | mentu-bridge |

**Your domain**: technical

**The Rule**:
- Failure in YOUR domain → Own it. Fix it. Don't explain.
- Failure in ANOTHER domain → You drifted. Re-read this HANDOFF.

**Quick reference**: `mentu stance executor` or `mentu stance executor --failure technical`

---

## Completion Contract

**First action**: Update `.claude/completion.json`:

```json
{
  "version": "2.0",
  "name": "Bug Execution Loop v1.1 (Beacon-Parity)",
  "tier": "T2",
  "required_files": [
    "src/realtime-subscriber.ts",
    "src/genesis-enforcer.ts",
    "src/worktree-manager.ts",
    "src/output-streamer.ts",
    "src/bug-executor.ts",
    "src/daemon.ts"
  ],
  "checks": {
    "tsc": true,
    "build": true,
    "test": false
  },
  "mentu": {
    "enabled": true,
    "commitments": {
      "mode": "dynamic",
      "min_count": 1,
      "require_closed": true,
      "require_evidence": true,
      "ids": ["cmt_6c8e6d56"]
    }
  },
  "max_iterations": 75
}
```

---

## Mentu Protocol

### Identity Resolution

```
┌───────────────────────────────────────────────────────────────────────────┐
│  ACTOR (WHO)              AUTHOR TYPE (ROLE)          CONTEXT (WHERE)     │
│  ─────────────            ──────────────────          ───────────────     │
│  From manifest            From this HANDOFF           From working dir    │
│  .mentu/manifest.yaml     author_type: executor       mentu-bridge        │
│                                                                           │
│  Actor is auto-resolved. Author type declares your role. Context tracks. │
└───────────────────────────────────────────────────────────────────────────┘
```

### Operations

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

# Check your actor identity (auto-resolved from manifest)
cat .mentu/manifest.yaml | grep actor

# Claim commitment (actor auto-resolved)
mentu claim cmt_6c8e6d56 --author-type executor

# Capture progress (actor auto-resolved, role declared)
mentu capture "{Progress}" --kind execution-progress --author-type executor
```

Save the commitment ID. You will close it with evidence.

---

## Build Order

### Stage 1: Realtime Subscriber

Create WebSocket subscription to bridge_commands table for instant command pickup.

**File**: `src/realtime-subscriber.ts`

```typescript
import { createClient, SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

export type RealtimeEvent =
  | { type: 'CommandInserted'; command: BridgeCommand }
  | { type: 'CommandUpdated'; command: BridgeCommand }
  | { type: 'Connected' }
  | { type: 'Disconnected' }
  | { type: 'Error'; message: string };

export interface BridgeCommand {
  id: string;
  workspace_id: string;
  prompt: string;
  working_directory: string;
  agent: string;
  flags: string[];
  timeout_seconds: number;
  target_machine_id?: string;
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed';
  claimed_by_machine_id?: string;
  claimed_at?: string;
  started_at?: string;
  completed_at?: string;
  exit_code?: number;
  output?: string;
  error?: string;
  approval_required: boolean;
  approval_status?: 'pending' | 'approved' | 'rejected';
  with_worktree: boolean;
  commitment_id?: string;
}

export type EventHandler = (event: RealtimeEvent) => void;

export class RealtimeSubscriber {
  private supabase: SupabaseClient;
  private workspaceId: string;
  private machineId: string;
  private channel?: RealtimeChannel;
  private handlers: EventHandler[] = [];
  private isConnected = false;

  constructor(supabase: SupabaseClient, workspaceId: string, machineId: string) {
    this.supabase = supabase;
    this.workspaceId = workspaceId;
    this.machineId = machineId;
  }

  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  private emit(event: RealtimeEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (e) {
        console.error("[RealtimeSubscriber] Handler error:", e);
      }
    }
  }

  async subscribe(): Promise<void> {
    console.log(`[RealtimeSubscriber] Subscribing to workspace ${this.workspaceId}`);

    this.channel = this.supabase
      .channel(`bridge_commands_${this.workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'bridge_commands',
          filter: `workspace_id=eq.${this.workspaceId}`
        },
        (payload) => {
          console.log("[RealtimeSubscriber] INSERT received");
          this.emit({
            type: 'CommandInserted',
            command: payload.new as BridgeCommand
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bridge_commands',
          filter: `workspace_id=eq.${this.workspaceId}`
        },
        (payload) => {
          console.log("[RealtimeSubscriber] UPDATE received");
          this.emit({
            type: 'CommandUpdated',
            command: payload.new as BridgeCommand
          });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log("[RealtimeSubscriber] Connected");
          this.isConnected = true;
          this.emit({ type: 'Connected' });
        } else if (status === 'CLOSED') {
          console.log("[RealtimeSubscriber] Disconnected");
          this.isConnected = false;
          this.emit({ type: 'Disconnected' });
        } else if (status === 'CHANNEL_ERROR') {
          console.error("[RealtimeSubscriber] Channel error");
          this.emit({ type: 'Error', message: 'Channel error' });
        }
      });
  }

  async unsubscribe(): Promise<void> {
    if (this.channel) {
      await this.supabase.removeChannel(this.channel);
      this.channel = undefined;
      this.isConnected = false;
      console.log("[RealtimeSubscriber] Unsubscribed");
    }
  }

  getIsConnected(): boolean {
    return this.isConnected;
  }
}
```

**Verification**:
```bash
npx tsc --noEmit src/realtime-subscriber.ts
```

---

### Stage 2: Genesis Enforcer

Create pre-execution validation against `.mentu/genesis.key` rules.

**File**: `src/genesis-enforcer.ts`

```typescript
import * as fs from "fs";
import * as path from "path";
import * as yaml from "yaml";

export interface GenesisViolation {
  code: 'PermissionDenied' | 'ConstraintViolated' | 'AuthorTypeDenied';
  message: string;
  actor: string;
  operation: string;
}

export interface EnforcementResult {
  allowed: boolean;
  violation?: GenesisViolation;
}

interface GenesisRules {
  trust?: {
    levels?: Record<string, string[]>;
    default_level?: string;
  };
  permissions?: {
    operations?: Record<string, {
      allowed_actors?: string[];
      denied_actors?: string[];
      requires_level?: string;
    }>;
  };
  constraints?: {
    max_file_changes?: number;
    forbidden_paths?: string[];
    require_tests?: boolean;
  };
}

export class GenesisEnforcer {
  private rules: GenesisRules | null = null;
  private genesisPath: string | null = null;
  private watcher?: fs.FSWatcher;

  async loadRules(workspacePath: string): Promise<void> {
    this.genesisPath = path.join(workspacePath, ".mentu", "genesis.key");

    if (!fs.existsSync(this.genesisPath)) {
      console.log("[GenesisEnforcer] No genesis.key found, allowing all operations");
      this.rules = null;
      return;
    }

    try {
      const content = fs.readFileSync(this.genesisPath, "utf-8");
      this.rules = yaml.parse(content) as GenesisRules;
      console.log("[GenesisEnforcer] Loaded genesis rules");
    } catch (e) {
      console.error("[GenesisEnforcer] Failed to parse genesis.key:", e);
      this.rules = null;
    }
  }

  watchForChanges(workspacePath: string): void {
    const genesisPath = path.join(workspacePath, ".mentu", "genesis.key");

    if (this.watcher) {
      this.watcher.close();
    }

    if (fs.existsSync(genesisPath)) {
      this.watcher = fs.watch(genesisPath, async (eventType) => {
        if (eventType === 'change') {
          console.log("[GenesisEnforcer] Genesis file changed, reloading");
          await this.loadRules(workspacePath);
        }
      });
    }
  }

  check(actor: string, operation: string): EnforcementResult {
    // If no rules, allow everything
    if (!this.rules) {
      return { allowed: true };
    }

    const opRules = this.rules.permissions?.operations?.[operation];

    // Check denied actors
    if (opRules?.denied_actors?.includes(actor)) {
      return {
        allowed: false,
        violation: {
          code: 'PermissionDenied',
          message: `Actor ${actor} is explicitly denied for operation ${operation}`,
          actor,
          operation
        }
      };
    }

    // Check allowed actors (if specified, actor must be in list)
    if (opRules?.allowed_actors && !opRules.allowed_actors.includes(actor)) {
      // Check for wildcard
      if (!opRules.allowed_actors.includes('*')) {
        return {
          allowed: false,
          violation: {
            code: 'PermissionDenied',
            message: `Actor ${actor} is not in allowed list for operation ${operation}`,
            actor,
            operation
          }
        };
      }
    }

    // Check trust level requirement
    if (opRules?.requires_level) {
      const actorLevel = this.getActorLevel(actor);
      const requiredLevel = opRules.requires_level;

      if (!this.hasLevel(actorLevel, requiredLevel)) {
        return {
          allowed: false,
          violation: {
            code: 'PermissionDenied',
            message: `Actor ${actor} (level: ${actorLevel}) does not meet required level ${requiredLevel}`,
            actor,
            operation
          }
        };
      }
    }

    return { allowed: true };
  }

  private getActorLevel(actor: string): string {
    if (!this.rules?.trust?.levels) {
      return this.rules?.trust?.default_level || 'untrusted';
    }

    for (const [level, actors] of Object.entries(this.rules.trust.levels)) {
      if (actors.includes(actor)) {
        return level;
      }
    }

    return this.rules.trust.default_level || 'untrusted';
  }

  private hasLevel(actorLevel: string, requiredLevel: string): boolean {
    const levelHierarchy = ['untrusted', 'basic', 'trusted', 'admin'];
    const actorIndex = levelHierarchy.indexOf(actorLevel);
    const requiredIndex = levelHierarchy.indexOf(requiredLevel);

    if (actorIndex === -1 || requiredIndex === -1) {
      return actorLevel === requiredLevel;
    }

    return actorIndex >= requiredIndex;
  }

  getConstraints(): GenesisRules['constraints'] | null {
    return this.rules?.constraints || null;
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = undefined;
    }
  }
}
```

**Verification**:
```bash
npx tsc --noEmit src/genesis-enforcer.ts
```

---

### Stage 3: Worktree Manager

Create git worktree isolation for per-commitment execution.

**File**: `src/worktree-manager.ts`

```typescript
import { execSync, exec } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface WorktreeResult {
  success: boolean;
  worktreePath?: string;
  branchName?: string;
  error?: string;
}

export class WorktreeManager {
  private worktreesDir = ".worktrees";

  getWorktreePath(repoPath: string, commitmentId: string): string {
    return path.join(repoPath, this.worktreesDir, commitmentId);
  }

  async createWorktree(repoPath: string, commitmentId: string): Promise<WorktreeResult> {
    const worktreePath = this.getWorktreePath(repoPath, commitmentId);
    const branchName = commitmentId;

    try {
      // Ensure .worktrees directory exists
      const worktreesPath = path.join(repoPath, this.worktreesDir);
      if (!fs.existsSync(worktreesPath)) {
        fs.mkdirSync(worktreesPath, { recursive: true });
      }

      // Check if worktree already exists
      if (fs.existsSync(worktreePath)) {
        console.log(`[WorktreeManager] Worktree ${commitmentId} already exists`);
        return {
          success: true,
          worktreePath,
          branchName
        };
      }

      // Check if branch already exists
      let branchExists = false;
      try {
        execSync(`git branch --list ${branchName}`, { cwd: repoPath, encoding: 'utf-8' });
        branchExists = true;
      } catch {
        branchExists = false;
      }

      // Create worktree with new branch or existing branch
      if (branchExists) {
        execSync(`git worktree add "${worktreePath}" ${branchName}`, {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        });
      } else {
        execSync(`git worktree add -b ${branchName} "${worktreePath}"`, {
          cwd: repoPath,
          encoding: 'utf-8',
          stdio: 'pipe'
        });
      }

      // Create symlink to .mentu directory
      const mentuSrc = path.join(repoPath, ".mentu");
      const mentuDest = path.join(worktreePath, ".mentu");

      if (fs.existsSync(mentuSrc) && !fs.existsSync(mentuDest)) {
        // Create relative symlink
        const relPath = path.relative(worktreePath, mentuSrc);
        fs.symlinkSync(relPath, mentuDest, 'dir');
        console.log(`[WorktreeManager] Symlinked .mentu to worktree`);
      }

      console.log(`[WorktreeManager] Created worktree at ${worktreePath}`);

      return {
        success: true,
        worktreePath,
        branchName
      };

    } catch (e) {
      const error = e as Error;
      console.error(`[WorktreeManager] Failed to create worktree:`, error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async cleanupWorktree(worktreePath: string): Promise<void> {
    try {
      if (!fs.existsSync(worktreePath)) {
        console.log(`[WorktreeManager] Worktree ${worktreePath} doesn't exist`);
        return;
      }

      // Get parent repo path
      const repoPath = path.dirname(path.dirname(worktreePath));
      const branchName = path.basename(worktreePath);

      // Remove worktree
      execSync(`git worktree remove "${worktreePath}" --force`, {
        cwd: repoPath,
        encoding: 'utf-8',
        stdio: 'pipe'
      });

      console.log(`[WorktreeManager] Removed worktree ${worktreePath}`);

      // Optionally delete branch (keep for history)
      // execSync(`git branch -D ${branchName}`, { cwd: repoPath });

    } catch (e) {
      const error = e as Error;
      console.error(`[WorktreeManager] Failed to cleanup worktree:`, error.message);
    }
  }

  listWorktrees(repoPath: string): string[] {
    try {
      const output = execSync('git worktree list --porcelain', {
        cwd: repoPath,
        encoding: 'utf-8'
      });

      const worktrees: string[] = [];
      const lines = output.split('\n');

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          const wt = line.replace('worktree ', '');
          if (wt.includes(this.worktreesDir)) {
            worktrees.push(wt);
          }
        }
      }

      return worktrees;
    } catch {
      return [];
    }
  }
}
```

**Verification**:
```bash
npx tsc --noEmit src/worktree-manager.ts
```

---

### Stage 4: Output Streamer

Create real-time log streaming to spawn_logs table.

**File**: `src/output-streamer.ts`

```typescript
import { SupabaseClient } from "@supabase/supabase-js";

export class OutputStreamer {
  private supabase: SupabaseClient;
  private commandId: string;
  private stdoutBuffer: string = "";
  private stderrBuffer: string = "";
  private intervalId?: NodeJS.Timeout;
  private streamInterval = 100; // 100ms flush interval
  private workspaceId: string;

  constructor(supabase: SupabaseClient, commandId: string, workspaceId: string) {
    this.supabase = supabase;
    this.commandId = commandId;
    this.workspaceId = workspaceId;
  }

  start(): void {
    console.log(`[OutputStreamer] Starting for command ${this.commandId}`);

    this.intervalId = setInterval(() => {
      this.flushBuffers();
    }, this.streamInterval);
  }

  write(stream: 'stdout' | 'stderr', data: string): void {
    if (stream === 'stdout') {
      this.stdoutBuffer += data;
    } else {
      this.stderrBuffer += data;
    }
  }

  private async flushBuffers(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.stdoutBuffer) {
      const chunk = this.stdoutBuffer;
      this.stdoutBuffer = "";
      promises.push(this.writeToDb('stdout', chunk));
    }

    if (this.stderrBuffer) {
      const chunk = this.stderrBuffer;
      this.stderrBuffer = "";
      promises.push(this.writeToDb('stderr', chunk));
    }

    await Promise.all(promises);
  }

  private async writeToDb(stream: 'stdout' | 'stderr', message: string): Promise<void> {
    try {
      await this.supabase.from('spawn_logs').insert({
        command_id: this.commandId,
        workspace_id: this.workspaceId,
        stream,
        message,
        ts: new Date().toISOString()
      });
    } catch (e) {
      console.error(`[OutputStreamer] Failed to write to spawn_logs:`, e);
    }
  }

  async flush(): Promise<void> {
    await this.flushBuffers();
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    // Final flush
    await this.flushBuffers();

    console.log(`[OutputStreamer] Stopped for command ${this.commandId}`);
  }
}
```

**Verification**:
```bash
npx tsc --noEmit src/output-streamer.ts
```

---

### Stage 5: Bug Executor (Beacon-Parity)

Create the main orchestrator using all beacon-ported modules.

**File**: `src/bug-executor.ts`

```typescript
import { SupabaseClient } from "@supabase/supabase-js";
import { spawn } from "child_process";
import { RealtimeSubscriber, BridgeCommand, RealtimeEvent } from "./realtime-subscriber";
import { GenesisEnforcer, EnforcementResult } from "./genesis-enforcer";
import { WorktreeManager, WorktreeResult } from "./worktree-manager";
import { OutputStreamer } from "./output-streamer";

export interface ExecutionResult {
  success: boolean;
  summary: string;
  files_changed: string[];
  tests_passed: boolean;
  pr_url?: string;
  exit_code: number;
  output: string;
}

interface ArchitectAuditorOutput {
  analysis: {
    hypothesis: string;
    likely_files: string[];
    investigation_steps: string[];
  };
  instructions: {
    objective: string;
    steps: string[];
    scope: {
      allowed_files: string[];
      forbidden: string[];
      max_file_changes: number;
    };
    success_criteria: string[];
    must_not: string[];
  };
}

export class BugExecutor {
  private supabase: SupabaseClient;
  private workspaceId: string;
  private machineId: string;
  private realtimeSubscriber: RealtimeSubscriber;
  private genesisEnforcer: GenesisEnforcer;
  private worktreeManager: WorktreeManager;
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
    this.genesisEnforcer = new GenesisEnforcer();
    this.worktreeManager = new WorktreeManager();
  }

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

  async stop(): Promise<void> {
    await this.realtimeSubscriber.unsubscribe();
    this.genesisEnforcer.stop();
    console.log("[BugExecutor] Stopped");
  }

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

  private queueCommand(command: BridgeCommand): void {
    // Only queue pending commands that target this machine or no specific machine
    if (command.status !== 'pending') return;
    if (command.target_machine_id && command.target_machine_id !== this.machineId) return;

    // Check if already in queue
    if (this.processingQueue.some(c => c.id === command.id)) return;

    this.processingQueue.push(command);
    this.processQueue();
  }

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
      await this.genesisEnforcer.loadRules(workspacePath);
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
      // Cleanup worktree (optional - keep for debugging)
      // if (worktreePath) {
      //   await this.worktreeManager.cleanupWorktree(worktreePath);
      // }
    }
  }

  private async claimCommand(commandId: string): Promise<boolean> {
    // Atomic claim using UPDATE...WHERE pattern
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

  private async updateCommandStatus(commandId: string, status: string): Promise<void> {
    const updates: Record<string, any> = { status };

    if (status === 'running') {
      updates.started_at = new Date().toISOString();
    }

    await this.supabase
      .from("bridge_commands")
      .update(updates)
      .eq("id", commandId);
  }

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

  private async runClaudeCommand(
    command: BridgeCommand,
    execDir: string,
    streamer: OutputStreamer
  ): Promise<ExecutionResult> {
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
          } catch (e) {
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
```

**Verification**:
```bash
npx tsc --noEmit src/bug-executor.ts
```

---

### Stage 6: Wire Everything into Daemon

Update the daemon to use the new beacon-parity components.

**File**: `src/daemon.ts`

Add imports at the top:
```typescript
import { BugExecutor } from "./bug-executor";
```

Add class properties:
```typescript
private bugExecutor?: BugExecutor;
```

In the `start()` method, add (using environment variables):
```typescript
// Start bug executor with beacon-parity features
const workspaceId = process.env.MENTU_WORKSPACE_ID;
const machineId = process.env.MENTU_MACHINE_ID || 'vps-mentu-01';

if (workspaceId) {
  this.bugExecutor = new BugExecutor(this.supabase, workspaceId, machineId);
  await this.bugExecutor.start();
  console.log("[Daemon] Bug executor started (beacon-parity mode)");
} else {
  console.warn("[Daemon] MENTU_WORKSPACE_ID not set, bug executor disabled");
}
```

In the `stop()` method:
```typescript
if (this.bugExecutor) {
  await this.bugExecutor.stop();
}
```

**Verification**:
```bash
npm run build
```

---

### Stage 7: VPS systemd Configuration

Create systemd service file for VPS deployment.

**File**: `/etc/systemd/system/mentu-bridge.service` (on VPS)

```ini
[Unit]
Description=Mentu Bridge Daemon (Beacon-Parity)
After=network.target

[Service]
Type=simple
User=mentu
Group=mentu
WorkingDirectory=/home/mentu/Workspaces/mentu-bridge
Environment="NODE_ENV=production"
EnvironmentFile=/home/mentu/.mentu.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**Environment file**: `/home/mentu/.mentu.env`

```bash
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=xxx
MENTU_WORKSPACE_ID=your-workspace-id
MENTU_MACHINE_ID=vps-mentu-01
CLAUDE_CODE_OAUTH_TOKEN=xxx
```

**Deployment commands**:
```bash
# On VPS
sudo systemctl daemon-reload
sudo systemctl enable mentu-bridge
sudo systemctl start mentu-bridge
sudo journalctl -u mentu-bridge -f
```

---

## Before Submitting

Before running `mentu submit`, spawn validators:

1. Use Task tool with `subagent_type="technical-validator"`
2. Use Task tool with `subagent_type="intent-validator"`
3. Use Task tool with `subagent_type="safety-validator"`

All must return verdict: PASS before submitting.

---

## Completion Phase (REQUIRED)

**BEFORE calling `mentu submit`, you MUST create a RESULT document:**

### Step 1: Create RESULT Document

Read the template and create the RESULT document:

```bash
# Read the template structure
cat /Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/TEMPLATE-Result.md

# Create: docs/RESULT-BugExecutionLoop-v1.0.md
```

The RESULT document MUST include:
- Valid YAML front matter with all required fields
- Summary of what was built
- Files created and modified
- Test results (tsc, tests, build)
- Design decisions with rationale

### Step 2: Capture RESULT as Evidence

```bash
# Actor auto-resolved from manifest, author-type declares role
mentu capture "Created RESULT-BugExecutionLoop: Bug executor polling loop implemented" \
  --kind result-document \
  --path docs/RESULT-BugExecutionLoop-v1.0.md \
  --refs cmt_XXXXXXXX \
  --author-type executor
```

### Step 3: Update RESULT Front Matter

Update the YAML front matter with the evidence ID:

```yaml
mentu:
  commitment: cmt_XXXXXXXX
  evidence: mem_YYYYYYYY  # ← The ID from Step 2
  status: in_review
```

### Step 4: Submit with Evidence

```bash
# Actor auto-resolved from manifest (same as claim)
mentu submit cmt_XXXXXXXX \
  --summary "Implemented BugExecutor polling loop with Architect+Auditor crafting and Claude Code execution" \
  --include-files
```

**The RESULT document IS the closure proof. Do not submit without it.**

---

## Verification Checklist

### Files
- [ ] `src/bug-executor.ts` exists
- [ ] `src/daemon.ts` updated with BugExecutor integration

### Checks
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes

### Mentu
- [ ] Commitment created with `mentu commit`
- [ ] Commitment claimed with `mentu claim`
- [ ] Validators passed (technical, intent, safety)
- [ ] If validation failed: checked stance (`mentu stance executor --failure technical`), fixed without arguing
- [ ] **RESULT document created** (`docs/RESULT-BugExecutionLoop-v1.0.md`)
- [ ] **RESULT captured as evidence** with `mentu capture`
- [ ] **RESULT front matter updated** with evidence ID
- [ ] Commitment submitted with `mentu submit`
- [ ] `mentu list commitments --state open` returns []

### Functionality
- [ ] BugExecutor polls every 60 seconds
- [ ] Finds commitments with `tags: ["bug"]`
- [ ] Claims atomically (logs show claim attempt)
- [ ] Crafts instructions via Claude (Architect+Auditor)
- [ ] Spawns executor via Claude Code
- [ ] Captures evidence on completion
- [ ] Closes commitment with evidence
- [ ] Handles failures gracefully (annotate + release)

---

*Automated bug execution: from report to resolution with full audit trail.*
