---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: RESULT-BugExecutionLoop-v1.0
path: docs/RESULT-BugExecutionLoop-v1.0.md
type: result
intent: reference

version: "1.0"
created: 2026-01-11
last_updated: 2026-01-11

actor: agent:bridge-daemon

parent: HANDOFF-BugExecutionLoop-v1.0

mentu:
  commitment: cmt_7685ff1e
  evidence: mem_8459d421
  status: in_review
---

# RESULT: Bug Execution Loop v1.0

**Completed:** 2026-01-11

---

## Summary

Implemented beacon-parity bug execution system in mentu-bridge with WebSocket realtime subscription, atomic claiming, genesis enforcement, worktree isolation, and output streaming. The daemon now instantly responds to incoming bridge commands via Supabase Realtime instead of polling, executes in isolated git worktrees, streams output in real-time to spawn_logs, and captures evidence for commitment closure.

---

## Activation

```bash
# Set required environment variables
export MENTU_WORKSPACE_ID="your-workspace-uuid"
export MENTU_MACHINE_ID="vps-mentu-01"

# Build and start
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
npm run build
npm start

# On VPS (systemd)
sudo systemctl restart mentu-bridge
sudo journalctl -u mentu-bridge -f
```

---

## How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MENTU-BRIDGE DAEMON (VPS or Mac)                                           │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │  REALTIME SUBSCRIBER (WebSocket)                                       │ │
│  │    ↓ CommandInserted                                                   │ │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │ │
│  │  │  BUG EXECUTOR                                                   │   │ │
│  │  │                                                                 │   │ │
│  │  │  1. Atomic Claim (UPDATE...WHERE status='pending')              │   │ │
│  │  │           ↓                                                     │   │ │
│  │  │  2. Genesis Enforcement (check agent:bridge-executor, execute)  │   │ │
│  │  │           ↓                                                     │   │ │
│  │  │  3. Worktree Isolation (git worktree add .worktrees/cmt_xxx)   │   │ │
│  │  │           ↓                                                     │   │ │
│  │  │  4. Execute Claude (spawn with streaming)                       │   │ │
│  │  │           ↓                                                     │   │ │
│  │  │  5. Output Streaming → spawn_logs (100ms flush)                │   │ │
│  │  │           ↓                                                     │   │ │
│  │  │  6. Evidence Capture + Commitment Closure                       │   │ │
│  │  └─────────────────────────────────────────────────────────────────┘   │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Files Created

### src/realtime-subscriber.ts

WebSocket subscription module ported from beacon/supabase.rs. Subscribes to `bridge_commands` table via Supabase Realtime and emits typed events (CommandInserted, CommandUpdated, Connected, Disconnected, Error).

### src/output-streamer.ts

Real-time log streaming module ported from beacon/output.rs. Buffers stdout/stderr and flushes to `spawn_logs` table every 100ms during execution.

### src/worktree-manager.ts

Git worktree isolation module ported from beacon/worktree.rs. Creates per-commitment worktrees in `.worktrees/` with symlinked `.mentu` directory.

### src/bug-executor.ts

Main orchestrator integrating all beacon-parity components. Handles the full lifecycle: realtime subscription → atomic claim → genesis check → worktree isolation → streaming execution → evidence capture → commitment closure.

### .claude/completion.json

Completion contract for T2 tier validation with required files and mentu integration.

---

## Files Modified

| File | Change |
|------|--------|
| `src/daemon.ts` | Added BugExecutor import and integration in start() and shutdown() methods |

---

## Test Results

| Test | Command | Result |
|------|---------|--------|
| TypeScript Compilation | `npx tsc --noEmit` | Pass |
| Build | `npm run build` | Pass |

---

## Design Decisions

### 1. Realtime Over Polling

**Rationale:** The existing daemon used 60-second polling which introduced latency for urgent bug fixes. WebSocket subscription via Supabase Realtime provides instant command pickup, reducing response time from up to 60 seconds to near-instant.

### 2. Class-Based WorktreeManager

**Rationale:** The HANDOFF specified `worktree-manager.ts` as a class-based API. While `worktree.ts` already existed with utility functions, creating a dedicated WorktreeManager class provides a cleaner interface for the BugExecutor and matches the beacon/worktree.rs pattern.

### 3. Parallel Integration with Existing Daemon

**Rationale:** The BugExecutor runs alongside the existing daemon functionality rather than replacing it. The daemon's existing realtime subscription and command handling remain intact for backwards compatibility, while BugExecutor provides the enhanced beacon-parity features for new commands.

---

## Mentu Ledger Entry

```
Commitment: cmt_7685ff1e
Status: closed
Evidence: mem_8459d421
Actor: agent:bridge-daemon
Body: "Implement Bug Execution Loop v1.0 with beacon-parity features"
```

---

## Usage Examples

### Example 1: Spawn Bug Fix via API

```bash
# Create a bridge command with worktree isolation
curl -X POST "https://mentu-proxy.affihub.workers.dev/bridge/commands" \
  -H "X-Proxy-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Fix the authentication bug in src/auth.ts",
    "working_directory": "/home/mentu/Workspaces/mentu-ai",
    "agent": "claude",
    "with_worktree": true,
    "commitment_id": "cmt_12345678"
  }'
```

The daemon will:
1. Receive instantly via WebSocket
2. Claim atomically
3. Create worktree at `.worktrees/cmt_12345678`
4. Execute with streaming output
5. Close commitment with evidence

### Example 2: Monitor Execution Logs

```bash
# Subscribe to spawn_logs for real-time output
# (via Supabase Realtime or dashboard)

# Or query after execution
curl "https://xxx.supabase.co/rest/v1/spawn_logs?command_id=eq.{uuid}&order=ts.asc" \
  -H "apikey: $SUPABASE_KEY"
```

---

## Constraints and Limitations

- Output streaming requires `spawn_logs` table in Supabase schema
- Worktree isolation only works for git repositories
- Genesis enforcement requires `.mentu/genesis.key` (optional - allows all if missing)
- BugExecutor runs in parallel with existing daemon, both handle commands

---

## Future Considerations

1. **Architect+Auditor Phase**: Add pre-execution LLM call to analyze bug and produce scoped instructions
2. **PR Auto-Creation**: Automatically create PRs from worktree branches after successful fix
3. **Metrics Dashboard**: Track bug fix success rates, execution times, and failure patterns

---

*Beacon-parity bug execution: instant response, isolated execution, real-time visibility.*
