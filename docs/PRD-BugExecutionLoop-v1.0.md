---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: PRD-BugExecutionLoop-v1.0
path: docs/PRD-BugExecutionLoop-v1.0.md
type: prd
intent: reference

version: "1.1"
created: 2026-01-11
last_updated: 2026-01-11

tier: T2

children:
  - HANDOFF-BugExecutionLoop-v1.0
dependencies:
  - PRD-BugInvestigationWorkflow-v2.1
  - PRD-BugReporterIntegration-v1.0

mentu:
  commitment: cmt_6c8e6d56
  status: pending
---

# PRD: Bug Execution Loop v1.0

## Mission

Close the automation gap between bug report ingestion and execution. When a bug webhook creates `mem_bug` + `cmt_xxx`, the mentu-bridge daemon automatically picks it up via **WebSocket realtime subscription** (not polling), crafts scoped instructions via Architect+Auditor reasoning, spawns a Claude Code executor in an **isolated worktree**, captures evidence with **real-time log streaming**, and closes the commitment with proof.

**Target Environment**: VPS (208.167.255.71) running as systemd service.

---

## Problem Statement

### Current State

```
Bug Report (WarrantyOS webhook)
    ↓
POST /bug-webhook (mentu-proxy)
    ↓
Gateway creates mem_bug + cmt_xxx
    ↓
Commitment sits in ledger with state: "open"
    ↓
??? ← NOTHING PICKS IT UP (mentu-bridge polls every 60s, misses urgency)
    ↓
Bug remains unfixed until human intervention
```

Current mentu-bridge limitations:
- **60-second polling** introduces latency
- **No output streaming** - logs only visible after completion
- **No worktree isolation** - parallel execution risks conflicts
- **No genesis enforcement** - no pre-execution validation

### Desired State (Beacon-Parity)

```
Bug Report (WarrantyOS webhook)
    ↓
POST /bug-webhook (mentu-proxy)
    ↓
Gateway creates mem_bug + cmt_xxx (with tags: ["bug"])
    ↓
Commitment sits in Supabase
    ↓
Bridge daemon (VPS) receives INSTANT WebSocket notification
    ↓
Atomic claim (prevents duplicate execution)
    ↓
Genesis enforcement (pre-execution validation)
    ↓
Worktree isolation (safe parallel execution)
    ↓
ARCHITECT + AUDITOR PHASE: Single LLM call
    ↓
EXECUTOR PHASE: Claude Code in worktree
    ↓
Real-time output streaming to spawn_logs
    ↓
Captures evidence, closes commitment with proof
```

---

## Architecture (Beacon-Parity)

### Component Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MENTU-BRIDGE DAEMON (VPS: 208.167.255.71)                                  │
│  systemd: mentu-bridge.service                                               │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  SUPABASE REALTIME SUBSCRIPTION (from beacon/supabase.rs)              │ │
│  │                                                                         │ │
│  │  WebSocket Channel: bridge_commands                                     │ │
│  │  Events: INSERT, UPDATE                                                 │ │
│  │  Filter: workspace_id = $WORKSPACE_ID                                   │ │
│  │           │                                                             │ │
│  │           ▼                                                             │ │
│  │  ┌─────────────────┐   ┌─────────────────┐                             │ │
│  │  │ CommandInserted │   │ CommandUpdated  │                             │ │
│  │  └────────┬────────┘   └────────┬────────┘                             │ │
│  │           │                      │                                      │ │
│  │           ▼                      ▼                                      │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│  │  │  BUG EXECUTOR (new component)                                    │   │ │
│  │  │                                                                   │   │ │
│  │  │  1. Atomic Claim                                                 │   │ │
│  │  │     UPDATE bridge_commands SET status='claimed',                 │   │ │
│  │  │       claimed_by_machine_id=$MACHINE_ID                          │   │ │
│  │  │     WHERE id=$CMD_ID AND status='pending'                        │   │ │
│  │  │           │                                                       │   │ │
│  │  │           ▼                                                       │   │ │
│  │  │  2. Genesis Enforcement (from beacon/genesis.rs)                 │   │ │
│  │  │     - Load .mentu/genesis.key                                    │   │ │
│  │  │     - Check permissions for actor + operation                    │   │ │
│  │  │     - Reject if PermissionDenied or ConstraintViolated           │   │ │
│  │  │           │                                                       │   │ │
│  │  │           ▼                                                       │   │ │
│  │  │  3. Worktree Isolation (from beacon/worktree.rs)                 │   │ │
│  │  │     cd $REPO                                                     │   │ │
│  │  │     git worktree add .worktrees/cmt_xxx -b cmt_xxx               │   │ │
│  │  │     ln -s ../../.mentu .worktrees/cmt_xxx/.mentu                 │   │ │
│  │  │           │                                                       │   │ │
│  │  │           ▼                                                       │   │ │
│  │  │  4. Architect+Auditor Phase (single LLM call)                    │   │ │
│  │  │     Input: Bug memory content                                    │   │ │
│  │  │     Output: Scoped execution instructions JSON                   │   │ │
│  │  │           │                                                       │   │ │
│  │  │           ▼                                                       │   │ │
│  │  │  5. Executor Phase (spawned Claude Code)                         │   │ │
│  │  │     claude --dangerously-skip-permissions -p "..."               │   │ │
│  │  │     cwd: .worktrees/cmt_xxx                                      │   │ │
│  │  │           │                                                       │   │ │
│  │  │           ├──────────────────────────────────────┐               │   │ │
│  │  │           │ stdout/stderr streaming (100ms)       │               │   │ │
│  │  │           ▼                                       ▼               │   │ │
│  │  │     ┌──────────┐                          ┌────────────┐         │   │ │
│  │  │     │ Terminal │                          │ spawn_logs │         │   │ │
│  │  │     │  Output  │                          │   Table    │         │   │ │
│  │  │     └──────────┘                          └────────────┘         │   │ │
│  │  │           │                                                       │   │ │
│  │  │           ▼                                                       │   │ │
│  │  │  6. Evidence Capture + Commitment Closure                        │   │ │
│  │  │                                                                   │   │ │
│  │  └───────────────────────────────────────────────────────────────────┘   │ │
│  │                                                                         │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  HEARTBEAT (from beacon/heartbeat.rs)                                   │ │
│  │  Every 60s: UPDATE bridge_machines SET last_heartbeat=now()            │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Completion Contract

**First action**: Update `.claude/completion.json`:

```json
{
  "version": "2.0",
  "name": "Bug Execution Loop v1.0 (Beacon-Parity)",
  "tier": "T2",
  "required_files": [
    "src/bug-executor.ts",
    "src/realtime-subscriber.ts",
    "src/genesis-enforcer.ts",
    "src/worktree-manager.ts",
    "src/output-streamer.ts",
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
      "require_evidence": true
    }
  },
  "max_iterations": 75
}
```

---

## Core Concepts (Beacon-Ported)

### Realtime Subscription (beacon/supabase.rs)

WebSocket-based subscription to `bridge_commands` table. Fires immediately on INSERT/UPDATE, no polling delay.

```typescript
// Subscribe to bridge_commands changes
const channel = supabase.channel('bridge_commands')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'bridge_commands',
    filter: `workspace_id=eq.${workspaceId}`
  }, (payload) => {
    handleCommandInserted(payload.new);
  })
  .subscribe();
```

### Atomic Claiming (beacon/supabase.rs)

Prevents duplicate execution across multiple bridge instances.

```sql
UPDATE bridge_commands
SET status = 'claimed',
    claimed_by_machine_id = $1,
    claimed_at = now()
WHERE id = $2
  AND status = 'pending'
RETURNING *
```

If another machine claimed first, this returns 0 rows.

### Genesis Enforcement (beacon/genesis.rs)

Pre-execution validation against `.mentu/genesis.key` rules.

```typescript
interface EnforcementResult {
  allowed: boolean;
  violation?: {
    code: 'PermissionDenied' | 'ConstraintViolated' | 'AuthorTypeDenied';
    message: string;
    actor: string;
    operation: string;
  };
}

// Enforcement check before execution
const result = await enforcer.check('agent:bridge-executor', 'execute');
if (!result.allowed) {
  throw new GenesisViolationError(result.violation);
}
```

### Worktree Isolation (beacon/worktree.rs)

Each commitment executes in its own git branch/worktree.

```
repo/
├── .git/
├── .mentu/
│   ├── genesis.key
│   └── ledger.jsonl
└── .worktrees/
    └── cmt_6c8e6d56/           # Isolated working directory
        ├── .mentu → ../../.mentu  # Symlink to main .mentu
        ├── src/
        └── (working files)
```

### Output Streaming (beacon/output.rs)

Real-time log streaming to `spawn_logs` table.

```typescript
// Stream every 100ms during execution
const streamInterval = setInterval(async () => {
  const chunk = buffer.flush();
  if (chunk) {
    await supabase.from('spawn_logs').insert({
      command_id: commandId,
      stream: 'stdout',
      message: chunk,
      ts: new Date().toISOString()
    });
  }
}, 100);
```

---

## Specification

### Types

```typescript
// Realtime events (from beacon/supabase.rs)
type RealtimeEvent =
  | { type: 'CommandInserted'; command: BridgeCommand }
  | { type: 'CommandUpdated'; command: BridgeCommand }
  | { type: 'Connected' }
  | { type: 'Disconnected' }
  | { type: 'Error'; message: string };

// Bridge command structure
interface BridgeCommand {
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

// Genesis enforcement (from beacon/genesis.rs)
interface GenesisEnforcer {
  loadRules(genesisPath: string): Promise<void>;
  check(actor: string, operation: string): Promise<EnforcementResult>;
  watchForChanges(genesisPath: string): void;
}

interface EnforcementResult {
  allowed: boolean;
  violation?: GenesisViolation;
}

interface GenesisViolation {
  code: 'PermissionDenied' | 'ConstraintViolated' | 'AuthorTypeDenied';
  message: string;
  actor: string;
  operation: string;
}

// Worktree manager (from beacon/worktree.rs)
interface WorktreeManager {
  createWorktree(repoPath: string, commitmentId: string): Promise<WorktreeResult>;
  cleanupWorktree(worktreePath: string): Promise<void>;
  getWorktreePath(repoPath: string, commitmentId: string): string;
}

interface WorktreeResult {
  success: boolean;
  worktreePath?: string;
  branchName?: string;
  error?: string;
}

// Output streamer (from beacon/output.rs)
interface OutputStreamer {
  start(commandId: string): void;
  write(stream: 'stdout' | 'stderr', data: string): void;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

// Bug executor (main orchestrator)
interface BugExecutor {
  onCommandInserted(command: BridgeCommand): Promise<void>;
  claimCommand(commandId: string): Promise<boolean>;
  enforceGenesis(workspacePath: string, actor: string): Promise<void>;
  createWorktree(workspacePath: string, commitmentId: string): Promise<string>;
  craftInstructions(bugMemory: Memory, commitment: Commitment): Promise<string>;
  spawnExecutor(instructions: string, execDir: string, commandId: string): Promise<ExecutionResult>;
  captureEvidence(commitmentId: string, result: ExecutionResult): Promise<string>;
  closeCommitment(commitmentId: string, evidenceId: string, success: boolean): Promise<void>;
}

interface ExecutionResult {
  success: boolean;
  summary: string;
  files_changed: string[];
  tests_passed: boolean;
  pr_url?: string;
  exit_code: number;
  output: string;
}
```

### Operations

| Operation | Input | Output | Description |
|-----------|-------|--------|-------------|
| `subscribe` | workspaceId | Channel | WebSocket subscription to bridge_commands |
| `claimCommand` | commandId, machineId | boolean | Atomic claim via UPDATE...WHERE |
| `enforceGenesis` | genesisPath, actor, op | EnforcementResult | Pre-execution validation |
| `createWorktree` | repoPath, commitmentId | WorktreeResult | Git worktree setup |
| `streamOutput` | commandId, stream, data | void | Real-time log to spawn_logs |
| `craftInstructions` | bugMemory | JSON string | Architect+Auditor reasoning |
| `spawnExecutor` | instructions, execDir | ExecutionResult | Claude Code execution |
| `captureEvidence` | commitmentId, result | memoryId | Create evidence memory |
| `closeCommitment` | commitmentId, evidenceId | void | Close with proof |

### State Machine

```
┌─────────────────┐
│   SUBSCRIBING   │
└────────┬────────┘
         │ Connected
         ▼
┌─────────────────┐
│    LISTENING    │◄────────────────────────────────────┐
└────────┬────────┘                                      │
         │ CommandInserted                               │
         ▼                                               │
┌─────────────────┐                                      │
│    CLAIMING     │                                      │
└────────┬────────┘                                      │
         │                                               │
    ┌────┴────┐                                          │
    │ claimed │ not claimed                              │
    ▼         └──────────────────────────────────────────┤
┌─────────────────┐                                      │
│    ENFORCING    │ (genesis check)                      │
└────────┬────────┘                                      │
         │                                               │
    ┌────┴────┐                                          │
    │ allowed │ denied                                   │
    ▼         └─────────────────► fail + release ────────┤
┌─────────────────┐                                      │
│   ISOLATING     │ (worktree)                           │
└────────┬────────┘                                      │
         │                                               │
         ▼                                               │
┌─────────────────┐                                      │
│    CRAFTING     │ (architect+auditor)                  │
└────────┬────────┘                                      │
         │                                               │
         ▼                                               │
┌─────────────────┐                                      │
│    EXECUTING    │ (with streaming)                     │
└────────┬────────┘                                      │
         │                                               │
    ┌────┴────┐                                          │
    │ success │ failure                                  │
    ▼         ▼                                          │
┌─────────────────┐  ┌─────────────────┐                 │
│    CAPTURING    │  │    HANDLING     │                 │
│    EVIDENCE     │  │    FAILURE      │                 │
└────────┬────────┘  └────────┬────────┘                 │
         │                    │                          │
         ▼                    ▼                          │
┌─────────────────┐  ┌─────────────────┐                 │
│    CLOSING      │  │   RELEASING     │                 │
└────────┬────────┘  └────────┬────────┘                 │
         │                    │                          │
         └────────────────────┴──────────────────────────┘
```

---

## Implementation

### Deliverables

| File | Purpose | Beacon Source |
|------|---------|---------------|
| `src/realtime-subscriber.ts` | WebSocket subscription to bridge_commands | supabase.rs |
| `src/genesis-enforcer.ts` | Pre-execution rule validation | genesis.rs |
| `src/worktree-manager.ts` | Git worktree isolation | worktree.rs |
| `src/output-streamer.ts` | Real-time log streaming | output.rs |
| `src/bug-executor.ts` | Main orchestrator | executor.rs |
| `src/daemon.ts` | Wire everything together | mod.rs |

### VPS Configuration

**systemd service**: `/etc/systemd/system/mentu-bridge.service`

```ini
[Unit]
Description=Mentu Bridge Daemon
After=network.target

[Service]
Type=simple
User=mentu
Group=mentu
WorkingDirectory=/home/mentu/Workspaces/mentu-bridge
Environment="NODE_ENV=production"
Environment="SUPABASE_URL=https://xxx.supabase.co"
Environment="SUPABASE_SERVICE_KEY=xxx"
Environment="MENTU_WORKSPACE_ID=xxx"
Environment="MENTU_MACHINE_ID=vps-mentu-01"
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### Build Order

1. **Realtime Subscriber**: WebSocket channel subscription
2. **Genesis Enforcer**: YAML parsing + rule matching
3. **Worktree Manager**: Git commands wrapper
4. **Output Streamer**: Buffered log streaming
5. **Bug Executor**: Main orchestration logic
6. **Daemon Integration**: Wire into startup

---

## Constraints

- DO NOT modify Supabase schema
- DO NOT create new tables (use existing: bridge_commands, spawn_logs, operations)
- DO use atomic claiming to prevent race conditions
- DO stream output in real-time (100ms intervals)
- DO enforce genesis rules before execution
- DO isolate execution in worktrees
- DO capture failures visibly (annotate + release)
- DO work on VPS (no GUI dependencies)

---

## Success Criteria

### Functional

- [ ] WebSocket subscription receives commands instantly
- [ ] Atomic claiming prevents duplicate execution
- [ ] Genesis enforcement validates before execution
- [ ] Worktree isolation creates per-commitment branches
- [ ] Output streams to spawn_logs in real-time
- [ ] Architect+Auditor phase produces scoped instructions
- [ ] Executor spawns Claude Code in worktree
- [ ] Evidence captured and commitment closed

### Quality

- [ ] TypeScript compiles without errors
- [ ] Build passes (`npm run build`)
- [ ] Runs on VPS as systemd service

### VPS Integration

- [ ] Syncs via SyncThing to VPS
- [ ] systemd service starts/stops cleanly
- [ ] Logs visible via `journalctl -u mentu-bridge`
- [ ] Heartbeat updates bridge_machines table

---

## Verification Commands

```bash
# On Mac: Build and sync
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
npm run build

# On VPS: Deploy and start
ssh mentu@208.167.255.71
cd ~/Workspaces/mentu-bridge
sudo systemctl restart mentu-bridge
sudo journalctl -u mentu-bridge -f

# Test bug webhook
curl -X POST "https://mentu-proxy.affihub.workers.dev/bug-webhook" \
  -H "X-API-Key: $BUG_REPORTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test bug",
    "description": "Test description",
    "severity": "low",
    "workspace_id": "...",
    "workspace_path": "/home/mentu/Workspaces/mentu-ai"
  }'

# Watch execution in real-time
# (spawn_logs table will show output streaming)
```

---

## References

- `mentu-beacon/src-tauri/src/engine/supabase.rs`: WebSocket subscription pattern
- `mentu-beacon/src-tauri/src/engine/genesis.rs`: Genesis enforcement logic
- `mentu-beacon/src-tauri/src/engine/worktree.rs`: Git worktree management
- `mentu-beacon/src-tauri/src/engine/output.rs`: Output streaming pattern
- `mentu-beacon/src-tauri/src/engine/executor.rs`: Execution orchestration

---

*Beacon-parity bug execution: instant response, isolated execution, real-time visibility.*
