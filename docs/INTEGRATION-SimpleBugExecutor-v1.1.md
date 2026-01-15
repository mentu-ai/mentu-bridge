# SimpleBugExecutor Integration Guide

**For mentu-web Kanban Integration**

This document articulates what SimpleBugExecutor v1.1 actually implements vs the idealized flow, and provides clear integration points for mentu-web.

---

## What We Actually Built (v1.1)

### Architecture Reality

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SimpleBugExecutor v1.1 - Current Implementation                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  1. POLL: Query bridge_commands WHERE command_type='bug_execution'          │
│           AND status='pending' AND target_machine_id='vps-01'               │
│                                                                             │
│  2. CLAIM: Update bridge_commands.status → 'claimed'                        │
│            Run: mentu claim <cmt_id> --actor agent:claude-vps               │
│            (Commitment moves to 'claimed' state in ledger)                  │
│                                                                             │
│  3. LOG: Create /home/mentu/logs/executions/<command_id>.log                │
│          Write: header, prompt, stream stdout/stderr, footer                │
│                                                                             │
│  4. SPAWN: claude --dangerously-skip-permissions --max-turns 50 "<prompt>"  │
│            Working directory: from workspace settings                       │
│            Environment: MENTU_COMMITMENT, MENTU_ACTOR, etc.                 │
│                                                                             │
│  5. VERIFY: Check git commits, ledger close operations, remote push         │
│                                                                             │
│  6. COMPLETE: Update bridge_commands.status → 'completed'                   │
│               Store result in bridge_commands.result JSONB                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### What's NOT Implemented (v1.1)

| Idealized Flow | v1.1 Reality | Status |
|----------------|--------------|--------|
| `git worktree add` | Direct execution in repo | ❌ Not implemented |
| `tmux new-session` | Spawns claude directly | ❌ Not implemented |
| Session attachment | No interactive access | ❌ Not implemented |
| `/rewind` support | Claude has checkpointing internally | ✅ Available in Claude |
| Worktree merge | No worktree to merge | ❌ Not applicable |
| 30-day retention | N/A | ❌ Not applicable |

---

## Data Flow for mentu-web

### Tables to Query

```sql
-- Active bug executions
SELECT bc.*, c.state as commitment_state, c.body
FROM bridge_commands bc
LEFT JOIN commitments c ON c.id = bc.commitment_id
WHERE bc.command_type = 'bug_execution'
  AND bc.status IN ('pending', 'claimed', 'running')
ORDER BY bc.created_at DESC;

-- Execution results
SELECT bc.id, bc.commitment_id, bc.status, bc.result,
       br.stdout, br.stderr, br.exit_code
FROM bridge_commands bc
LEFT JOIN bridge_results br ON br.command_id = bc.id
WHERE bc.command_type = 'bug_execution';
```

### Real-time Subscriptions

```typescript
// Subscribe to bug execution updates
supabase
  .channel('bug_executions')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'bridge_commands',
    filter: 'command_type=eq.bug_execution'
  }, handleChange)
  .subscribe();
```

---

## Execution Lifecycle (What mentu-web Can Show)

### States & UI Mapping

| bridge_commands.status | commitment.state | Kanban Display | Panel Display |
|------------------------|------------------|----------------|---------------|
| `pending` | `open` | "Queued" badge | "Waiting for executor..." |
| `claimed` | `claimed` | "Starting" spinner | "Executor claimed, starting..." |
| `running` | `claimed` | "Running" spinner | Stream logs, show progress |
| `completed` + success | `claimed`→`closed` | "Done" checkmark | Show result summary |
| `completed` + failed | `claimed` | "Failed" badge | Show error, retry button |
| `timeout` | `claimed` | "Timeout" badge | Show timeout message |

### Execution Log File (NEW in v1.1)

Location: `/home/mentu/logs/executions/<command_id>.log`

```
================================================================================
EXECUTION LOG: e8272848-dd4e-4aa4-b81d-499c6293eae9
Commitment: cmt_kzr4z3eo
Started: 2026-01-15T03:43:39.105Z
Working Directory: /home/mentu/Workspaces/projects/inline-substitute/vin-to-value-main
Timeout: 3600s
================================================================================

--- PROMPT ---
Fix this bug (commitment: cmt_kzr4z3eo):
[Bug description from memory]

Full instructions: Read ./BUG-FIX-PROTOCOL.md
Bug details available as memory: mem_9814il05

--- OUTPUT ---
[Streamed stdout from Claude...]

--- END ---
Completed: 2026-01-15T03:46:24.580Z
Exit Code: 0
Status: SUCCESS
================================================================================
```

**For mentu-web**: This file provides full lineage. Consider:
- API endpoint to fetch execution log by command_id
- Display in panel as "Full Execution Log" tab
- Download button for debugging

---

## Integration Points for mentu-web

### 1. Kanban Card Enhancements

**Current**: Shows spinner if `runningCommitmentIds` includes commitment

**Enhanced** (recommended):

```tsx
// CommitmentCard.tsx additions
interface ExecutionStatus {
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'timeout';
  startedAt?: string;
  progress?: number; // Could be computed from log size
  error?: string;
}

// Show on card:
{executionStatus?.status === 'running' && (
  <div className="flex items-center gap-1 text-blue-500">
    <Spinner className="h-3 w-3" />
    <span className="text-xs">
      Running ({formatDuration(Date.now() - new Date(executionStatus.startedAt).getTime())})
    </span>
  </div>
)}

{executionStatus?.status === 'failed' && (
  <Badge variant="destructive" className="text-xs">
    Failed: {executionStatus.error?.slice(0, 30)}
  </Badge>
)}
```

### 2. Commitment Panel Logs Tab

**Current**: BridgeLogsViewer shows stdout/stderr from bridge_results

**Enhanced** (recommended):

```tsx
// Add to CommitmentPanel tabs
<TabsContent value="execution">
  {/* Existing BridgeLogsViewer */}
  <BridgeLogsViewer commandId={activeCommand?.id} />

  {/* NEW: Execution summary */}
  <ExecutionSummary
    commandId={activeCommand?.id}
    result={activeCommand?.result}
  />

  {/* NEW: Full log download */}
  <Button
    variant="outline"
    onClick={() => downloadExecutionLog(activeCommand?.id)}
  >
    Download Full Log
  </Button>
</TabsContent>
```

### 3. Commitment Claim Visibility

**NEW in v1.1**: SimpleBugExecutor now runs `mentu claim` before execution

**What mentu-web sees**:
- Commitment state changes: `open` → `claimed`
- Owner set to: `agent:claude-vps`
- Kanban card moves from "To Do" to "In Progress"

**Timeline shows**:
```
[claim] agent:claude-vps claimed commitment
  └─ ts: 2026-01-15T03:43:39Z
```

### 4. Result Structure (bridge_commands.result)

```typescript
interface BugFixResult {
  success: boolean;
  verified: boolean;
  summary: string;
  files_changed: string[];
  tests_passed: boolean;
  exit_code: number;
  output: string; // Last 10KB of stdout
  blocked_reason?: string;
  verification?: {
    verified: boolean;
    gitCommits: number;
    filesChanged: string[];
    ledgerHasClose: boolean;
    pushedToRemote: boolean;
    headRef: string;
    reason: string;
  };
}
```

**Display in panel**:
```tsx
<div className="space-y-2">
  <div className="flex items-center gap-2">
    {result.verified ? (
      <CheckCircle className="text-green-500" />
    ) : (
      <XCircle className="text-red-500" />
    )}
    <span>{result.verification?.reason}</span>
  </div>

  {result.files_changed.length > 0 && (
    <div>
      <h4>Files Changed ({result.files_changed.length})</h4>
      <ul className="text-sm text-muted-foreground">
        {result.files_changed.map(f => <li key={f}>{f}</li>)}
      </ul>
    </div>
  )}

  {result.verification?.gitCommits > 0 && (
    <Badge variant="outline">
      {result.verification.gitCommits} commit(s)
    </Badge>
  )}

  {result.verification?.pushedToRemote && (
    <Badge variant="outline" className="text-green-500">
      Pushed to remote
    </Badge>
  )}
</div>
```

---

## API Endpoints (Existing + Needed)

### Existing (Working)

| Endpoint | Purpose | Used By |
|----------|---------|---------|
| `POST /api/bridge/spawn` | Spawn agent | SpawnAgentButton |
| `POST /api/bridge/stop` | Stop execution | SpawnAgentButton |
| `GET /api/bridge/logs` | Get stdout/stderr | BridgeLogsViewer |

### Needed (For Full Integration)

| Endpoint | Purpose | Implementation |
|----------|---------|----------------|
| `GET /api/bridge/execution-log/:commandId` | Fetch full execution log file | Read from `/home/mentu/logs/executions/<id>.log` |
| `GET /api/bridge/execution-status/:commitmentId` | Get current execution status | Query bridge_commands + result |
| `POST /api/bridge/retry/:commandId` | Retry failed execution | Reset status to pending |

---

## What's Coming (v2.0 Roadmap)

### Worktree Support

```
v2.0 Flow:
├─ Create worktree: git worktree add --detach ./work/{cmt_id} main
├─ Execution happens in worktree (isolated)
├─ Changes preserved even if execution fails
├─ Merge via: git merge --no-ff work/{cmt_id}
└─ Cleanup after 30 days
```

**mentu-web prep**:
- Add `worktree_path` field to execution display
- Add "Browse Worktree" button (file tree viewer)
- Add "Diff from Main" view
- Add "Merge" and "Discard" actions

### Tmux Session Support

```
v2.0 Flow:
├─ Spawn: tmux new-session -d -s bug_{cmt_id}
├─ In session: claude --max-turns 50 "..."
├─ User can attach: tmux attach -t bug_{cmt_id}
└─ Session persists for review
```

**mentu-web prep**:
- Add "Attach to Session" button (opens terminal in browser?)
- Add session status indicator
- Add "Kill Session" action

### Approval Workflow

```
v2.0 Flow:
├─ Execution completes
├─ on_approve action defined
├─ Commitment enters in_review
├─ Human reviews, approves
├─ on_approve action executes (e.g., merge + deploy)
└─ Commitment closes
```

**mentu-web prep**:
- Approval queue view (filter: state='in_review')
- Approve/Reject with reason
- Show on_approve action that will execute
- Post-approval status tracking

---

## Quick Reference

### Environment Variables (Passed to Claude)

| Variable | Value | Purpose |
|----------|-------|---------|
| `MENTU_COMMITMENT` | `cmt_xxx` | Commitment being fixed |
| `MENTU_BRIDGE_COMMAND_ID` | UUID | Bridge command for tracking |
| `MENTU_API_URL` | Proxy URL | For API calls |
| `MENTU_PROXY_TOKEN` | Auth token | For authenticated calls |
| `MENTU_ACTOR` | `agent:claude-vps` | Actor identity |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token | Claude auth |

### Prompt Structure (Minimal)

```
Fix this bug (commitment: cmt_xxx):
[Bug description extracted from memory]

Full instructions: Read ./BUG-FIX-PROTOCOL.md
Bug details available as memory: mem_xxx
```

### Verification Criteria

Execution is considered **verified** if ANY of:
1. Ledger has `close` operation for commitment
2. Git has commits since start AND pushed to remote
3. Claude exited with code 0 AND files changed

---

## Summary for mentu-web Team

### What Works NOW (v1.1)

1. **Spawn bug execution** → Creates bridge_command, executor picks it up
2. **Track execution** → Subscribe to bridge_commands, see status changes
3. **View logs** → BridgeLogsViewer shows stdout/stderr
4. **See commitment claim** → Commitment moves to 'claimed' when execution starts
5. **View results** → bridge_commands.result has full verification details
6. **Full lineage** → `/home/mentu/logs/executions/<id>.log` has everything

### What to Add to Kanban

1. **Execution status on card** - Show running/failed/timeout with duration
2. **Result summary in panel** - Show files changed, commits, verification status
3. **Retry button** - For failed executions
4. **Download log button** - For debugging
5. **Claim visibility** - Show "Claimed by agent:claude-vps" in timeline

### What's NOT Available Yet

1. Worktree browsing (no worktrees in v1.1)
2. Session attachment (no tmux in v1.1)
3. Approval workflow UI (commitment goes open→claimed→closed directly)
4. Scheduled execution countdown

---

*This document reflects SimpleBugExecutor v1.1 as deployed 2026-01-15.*
