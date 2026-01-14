---
id: HANDOFF-BugExecutionFixes-v1.0
path: docs/HANDOFF-BugExecutionFixes-v1.0.md
type: handoff
intent: execute

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

author_type: executor

parent: PRD-BugExecutionFixes-v1.0
children:
  - PROMPT-BugExecutionFixes-v1.0

mentu:
  commitment: cmt_6ffc4ed3
  source: mem_51580b64
  status: pending

validation:
  required: true
  tier: T2
---

# HANDOFF: BugExecutionFixes v1.0

## For the Coding Agent

Fix four critical bugs preventing the bug execution workflow from completing: result storage, workspace resolution, stale cleanup, and auth tokens.

**Read the full PRD**: `docs/PRD-BugExecutionFixes-v1.0.md`

---

## Your Identity

You are operating as **executor** (from this HANDOFF's `author_type` field).

Your actor identity comes from the repository manifest (`.mentu/manifest.yaml`).

| Dimension | Source | Value |
|-----------|--------|-------|
| **Actor** | Repository manifest | agent:claude-bridge |
| **Author Type** | This HANDOFF | executor |
| **Context** | Working directory | mentu-bridge |

**Your domain**: technical

**The Rule**:
- Failure in YOUR domain → Own it. Fix it. Don't explain.
- Failure in ANOTHER domain → You drifted. Re-read this HANDOFF.

---

## Completion Contract

**First action**: Create `feature_list.json` in the working directory:

```json
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-BugExecutionFixes-v1.0",
  "created": "2026-01-13T04:30:00Z",
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

## Mentu Protocol

### Identity Resolution

```
┌───────────────────────────────────────────────────────────────────────────┐
│  ACTOR (WHO)              AUTHOR TYPE (ROLE)          CONTEXT (WHERE)     │
│  ─────────────            ──────────────────          ───────────────     │
│  From manifest            From this HANDOFF           From working dir    │
│  .mentu/manifest.yaml     author_type: executor       mentu-bridge        │
└───────────────────────────────────────────────────────────────────────────┘
```

### Operations

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

# Claim commitment (actor auto-resolved)
mentu claim cmt_6ffc4ed3 --author-type executor

# Capture progress (actor auto-resolved, role declared)
mentu capture "{Progress}" --kind execution-progress --author-type executor
```

---

## Build Order

### Stage 1: Fix Result Storage

**Problem**: The result update at `bug-executor.ts:958-961` doesn't verify success.

**File**: `src/bug-executor.ts`

**Changes**:

1. Add error handling and verification to result storage:

```typescript
// At line ~958, replace:
await this.supabase
  .from("bridge_commands")
  .update({ result: { audit, execution: result } })
  .eq("id", command.id);

// With:
const { error: updateError } = await this.supabase
  .from("bridge_commands")
  .update({ result: { audit, execution: result } })
  .eq("id", command.id)
  .select();

if (updateError) {
  console.error(`[BugExecutor] Failed to store result for ${command.id}:`, updateError);
  // Still return result, but log the failure
}
console.log(`[BugExecutor] Result stored for ${command.id}`);
```

**Verification**:
```bash
grep -A 5 "result: { audit" src/bug-executor.ts
```

---

### Stage 2: Fix Working Directory Resolution

**Problem**: Bug execution uses hardcoded `mentu-ai` directory instead of the source workspace directory.

**File**: `src/bug-executor.ts`

**Changes**:

1. Add method to resolve workspace directory:

```typescript
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
```

2. In `executeBugCommand`, resolve directory from workspace:

```typescript
// Before Step 1 (Fetch bug memory), add:
const resolvedDirectory = this.resolveWorkspaceDirectory(command.workspace_id);
if (resolvedDirectory) {
  console.log(`[BugExecutor] Using workspace directory: ${resolvedDirectory}`);
  // Override working_directory if workspace has a specific directory
  command.working_directory = resolvedDirectory;
}
```

3. Ensure workspace config includes directory. Check `src/config.ts` or wherever workspaces are loaded.

**Verification**:
```bash
grep -n "resolveWorkspaceDirectory" src/bug-executor.ts
```

---

### Stage 3: Add Stale Command Cleanup

**Problem**: Commands pending for hours accumulate and waste resources.

**File**: `src/daemon.ts` (or `src/bug-executor.ts`)

**Changes**:

1. Add cleanup method to BugExecutor:

```typescript
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
```

2. Call cleanup in `start()` method:

```typescript
async start(): Promise<void> {
  console.log(`[BugExecutor] Starting with machineId: ${this.machineId}`);

  // Clean up stale commands before starting
  await this.cleanupStaleCommands();

  // ... rest of start() method
}
```

**Verification**:
```bash
grep -n "cleanupStaleCommands" src/bug-executor.ts
```

---

### Stage 4: Fix Ledger Auth (Investigation Required)

**Problem**: `mentu capture` fails with unauthorized errors.

**Investigation Steps**:

1. Check if `MENTU_PROXY_TOKEN` or `SUPABASE_SERVICE_ROLE_KEY` is set in the daemon environment:
```bash
ssh mentu@208.167.255.71 'grep -E "PROXY_TOKEN|SERVICE_ROLE" /home/mentu/.mentu.env'
```

2. The ledger operations in `bug-executor.ts` use `this.supabase` which should already be authenticated. Check if the operations table has RLS policies blocking writes.

3. If using `mentu` CLI from within the executor:
   - The CLI needs `MENTU_PROXY_TOKEN` in environment
   - Pass it via spawn env

**Likely Fix**: The direct Supabase operations (like `captureEvidence` at line 512) should work if using service role key. The issue may be with CLI calls. Check if any code spawns `mentu` CLI commands.

**Verification**:
```bash
grep -n "mentu capture\|mentu annotate\|mentu close" src/bug-executor.ts
```

---

## Before Submitting

Before running `mentu submit`, spawn validators:

1. Use Task tool with `subagent_type="technical-validator"`
2. Check that `npm run build` passes
3. Verify no TypeScript errors

---

## Completion Phase (REQUIRED)

**BEFORE calling `mentu submit`, you MUST create a RESULT document:**

### Step 1: Create RESULT Document

Read the template and create the RESULT document:

```bash
cat /Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/TEMPLATE-Result.md

# Create: docs/RESULT-BugExecutionFixes-v1.0.md
```

### Step 2: Capture RESULT as Evidence

```bash
mentu capture "Created RESULT-BugExecutionFixes: Fixed result storage, workspace resolution, stale cleanup" \
  --kind result-document \
  --path docs/RESULT-BugExecutionFixes-v1.0.md \
  --refs cmt_6ffc4ed3 \
  --author-type executor
```

### Step 3: Update RESULT Front Matter

Update the YAML front matter with the evidence ID:

```yaml
mentu:
  commitment: cmt_6ffc4ed3
  evidence: mem_YYYYYYYY  # ← The ID from Step 2
  status: in_review
```

### Step 4: Submit with Evidence

```bash
mentu submit cmt_6ffc4ed3 \
  --summary "Fixed bug execution: result storage, workspace resolution, stale cleanup" \
  --include-files
```

---

## Verification Checklist

### Files
- [ ] `src/bug-executor.ts` - result storage fixed
- [ ] `src/bug-executor.ts` - workspace resolution added
- [ ] `src/bug-executor.ts` - stale cleanup added

### Checks
- [ ] `npm run build` passes
- [ ] `tsc --noEmit` passes

### Mentu
- [ ] Commitment claimed
- [ ] RESULT document created
- [ ] RESULT captured as evidence
- [ ] Commitment submitted

### Functionality
- [ ] Insert bug_execution command → result stored in DB
- [ ] Stale commands cleaned on startup
- [ ] Build and deploy to VPS

---

## Deploy to VPS

After local verification:

```bash
# Build locally (SyncThing will sync)
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
npm run build

# Restart daemon on VPS
ssh mentu@208.167.255.71 'sudo systemctl restart mentu-bridge'

# Watch logs
ssh mentu@208.167.255.71 'tail -f /home/mentu/logs/bridge.log' | grep -E "BugExecutor|Result stored|Stale cleanup"
```

---

*Fix the plumbing. Let the water flow.*
