---
id: PRD-BugExecutionFixes-v1.0
path: docs/PRD-BugExecutionFixes-v1.0.md
type: prd
intent: reference

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

children:
  - HANDOFF-BugExecutionFixes-v1.0
dependencies:
  - RESULT-ProgrammaticBugExecution-v1.0

mentu:
  commitment: cmt_6ffc4ed3
  source: mem_51580b64
  status: pending
---

# PRD: BugExecutionFixes v1.0

## Mission

Fix critical bugs in the bug execution workflow that prevent the Auditor+Executor pattern from completing successfully: result storage failures, working directory mismatches, and stale command accumulation.

---

## Problem Statement

### Current State

```
Bug Report → bridge_commands → BugExecutor.executeBugCommand()
                                      │
                  ┌───────────────────┼───────────────────┐
                  │                   │                   │
            craftAudit()        spawnExecutor()     result storage
                  │                   │                   │
            ✅ Works            ✅ Works            ❌ FAILS
            (193s)              (completes)         (not saved to DB)
```

**Issues Identified:**

1. **Result Not Stored**: Command `33960340-3a01-4522-8aba-88290b972d69` shows `hypothesis: null` in DB despite logs showing Auditor completed successfully. The `await this.supabase.update({ result: { audit, execution: result } })` at line 958-961 is not persisting.

2. **Working Directory Mismatch**: Bug execution for WarrantyOS bugs uses `working_directory: /home/mentu/Workspaces/mentu-ai` instead of the correct WarrantyOS path. The Executor cannot find WarrantyOS files.

3. **Stale Commands**: Commands pending for 6-32 hours accumulate in the queue, wasting resources and blocking the workflow.

4. **Ledger Recording Failures**: `mentu capture` operations fail with `{"error":"unauthorized","message":"Invalid or missing X-Proxy-Token"}`, preventing progress tracking.

### Desired State

```
Bug Report → bridge_commands → BugExecutor.executeBugCommand()
                                      │
                  ┌───────────────────┼───────────────────┐
                  │                   │                   │
            craftAudit()        spawnExecutor()     result storage
                  │                   │                   │
            ✅ Works            ✅ Works            ✅ Works
            (hypothesis)        (fix applied)       (persisted)
                  │                   │                   │
                  └───────────────────┴───────────────────┘
                                      │
                              Commitment closed
                              Next bug starts
```

---

## Completion Contract

**First action**: Create `feature_list.json` in the working directory:

```json
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-BugExecutionFixes-v1.0",
  "created": "2026-01-13T04:15:00Z",
  "status": "in_progress",
  "tier": "T2",
  "mentu": {
    "commitment": "cmt_6ffc4ed3",
    "source": "mem_51580b64"
  },
  "features": [
    {
      "id": "F001",
      "description": "Result storage persists audit and execution data to bridge_commands.result",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "Working directory resolved from workspace config for bug source project",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "Stale command cleanup runs on daemon startup",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "Ledger operations use correct auth token from environment",
      "passes": false,
      "evidence": null
    }
  ],
  "checks": {
    "tsc": true,
    "build": true
  }
}
```

---

## Core Concepts

### Result Persistence

The `executeBugCommand` method must persist results atomically. Current implementation may fail silently if the Supabase update doesn't complete before the function returns.

### Workspace Resolution

Bug memories originate from specific workspaces (e.g., WarrantyOS). The execution must happen in that workspace's directory, not a hardcoded default.

### Command Lifecycle

Commands must transition through states with timeouts: `pending → claimed → running → completed/failed`. Commands stuck in `claimed` or `running` beyond their timeout should be marked `timeout`.

---

## Specification

### Types

```typescript
// Enhanced BridgeCommand with workspace source
interface BridgeCommand {
  id: string;
  workspace_id: string;  // Source workspace (e.g., WarrantyOS)
  working_directory: string;  // Must match workspace directory
  command_type: 'spawn' | 'bug_execution';
  payload?: {
    memory_id?: string;
    commitment_id?: string;
  };
  // ... other fields
}

// Workspace config must be discoverable
interface WorkspaceConfig {
  id: string;
  name: string;
  directory: string;  // VPS path for this workspace
}
```

### Operations

| Operation | Input | Output | Description |
|-----------|-------|--------|-------------|
| `resolveWorkingDirectory` | `workspace_id` | `string` | Get correct directory for workspace |
| `storeResult` | `command_id, result` | `void` | Atomically persist result with retry |
| `cleanupStaleCommands` | `max_age_hours` | `number` | Mark old commands as timeout |
| `captureWithAuth` | `payload` | `memory_id` | Capture using service role key |

### Validation Rules

- Working directory MUST exist on the target machine
- Result storage MUST be awaited before function returns
- Commands older than `timeout_seconds + 60` MUST be marked timeout
- Ledger operations MUST use authenticated Supabase client

---

## Implementation

### Deliverables

| File | Purpose |
|------|---------|
| `src/bug-executor.ts` | Fix result storage, add workspace resolution |
| `src/daemon.ts` | Add stale command cleanup on startup |
| `src/types.ts` | Add workspace directory field if missing |

### Build Order

1. **Fix Result Storage**: Add proper await and error handling for result update
2. **Workspace Resolution**: Map workspace_id to correct directory from config
3. **Stale Cleanup**: Add cleanup function called on daemon startup
4. **Auth Fix**: Ensure ledger operations use service role key

### Integration Points

| System | Integration | Notes |
|--------|-------------|-------|
| Supabase | Result storage | Use `.update().select()` to verify success |
| Workspace Config | Directory lookup | Config already has workspace array |
| Mentu CLI | Ledger operations | May need to pass token via env |

---

## Constraints

- MUST NOT change the Auditor/Executor prompt structure
- MUST NOT break existing spawn command functionality
- MUST maintain backwards compatibility with single-workspace configs
- MUST NOT expose service role key in logs

---

## Success Criteria

### Functional

- [ ] After `executeBugCommand` returns, `bridge_commands.result` contains audit and execution data
- [ ] Bug execution for WarrantyOS bugs uses `/home/mentu/Workspaces/projects/warranty-os`
- [ ] Commands pending > 2x timeout are marked `timeout` on startup
- [ ] Mentu captures succeed (no unauthorized errors)

### Quality

- [ ] `npm run build` passes
- [ ] No unhandled promise rejections in result storage
- [ ] Cleanup logs count of stale commands handled

### Integration

- [ ] End-to-end: Insert bug_execution command, verify result stored, commitment closed
- [ ] Next bug in queue starts automatically after previous completes

---

## Verification Commands

```bash
# Build
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && npm run build

# Check result storage
psql -c "SELECT id, status, result->'audit'->'context'->>'hypothesis' FROM bridge_commands WHERE command_type='bug_execution' LIMIT 5"

# Check for stale commands
psql -c "SELECT id, status, EXTRACT(EPOCH FROM NOW() - created_at)/3600 as hours FROM bridge_commands WHERE status IN ('pending','claimed','running')"

# Verify auth token
ssh mentu@208.167.255.71 'grep SUPABASE_SERVICE_ROLE_KEY /home/mentu/.mentu.env'
```

---

## References

- `RESULT-ProgrammaticBugExecution-v1.0`: Predecessor implementation
- `src/bug-executor.ts:958-961`: Current result storage (needs fix)
- `src/types.ts`: WorkspaceConfig interface

---

*Fix the foundation. Let the bugs flow through.*
