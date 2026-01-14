---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: HANDOFF-SimpleBugExecutorVerification-v1.0
path: docs/HANDOFF-SimpleBugExecutorVerification-v1.0.md
type: handoff
intent: execute

version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14

tier: T2

author_type: executor

parent: PRD-SimpleBugExecutorVerification-v1.0
children:
  - PROMPT-SimpleBugExecutorVerification-v1.0

mentu:
  commitment: pending
  status: pending

validation:
  required: true
  tier: T2
---

# HANDOFF: SimpleBugExecutor Verification v1.0

## For the Coding Agent

Fix SimpleBugExecutor to verify actual outcomes (git commits, ledger updates) before reporting success, instead of blindly trusting exit code 0.

**Read the full PRD**: `docs/PRD-SimpleBugExecutorVerification-v1.0.md`

---

## Your Identity

You are operating as **executor** (from this HANDOFF's `author_type` field).

Your actor identity comes from the repository manifest (`.mentu/manifest.yaml`).

| Dimension | Source | Value |
|-----------|--------|-------|
| **Actor** | Repository manifest | agent:claude-vps |
| **Author Type** | This HANDOFF | executor |
| **Context** | Working directory | mentu-bridge |

**Your domain**: technical

**The Rule**:
- Failure in YOUR domain → Own it. Fix it. Don't explain.
- Failure in ANOTHER domain → You drifted. Re-read this HANDOFF.

---

## Completion Contract

**First action**: Create the feature list at the commitment-scoped path:

```bash
mkdir -p .mentu/feature_lists
# Create: .mentu/feature_lists/cmt_XXXXXXXX.json
```

**Path**: `.mentu/feature_lists/cmt_XXXXXXXX.json`

```json
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-SimpleBugExecutorVerification-v1.0",
  "created": "2026-01-14T00:00:00Z",
  "status": "in_progress",
  "tier": "T2",
  "mentu": {
    "commitment": "cmt_XXXXXXXX",
    "source": "mem_XXXXXXXX"
  },
  "features": [
    {
      "id": "F001",
      "description": "Prompt uses local mentu CLI instead of curl proxyUrl/ops",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "verifyOutcome() checks git status for actual commits",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "verifyOutcome() checks ledger for close operation",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "Success requires verified evidence OR verified blocked status",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F005",
      "description": "Files changed extracted from git diff, not Claude's JSON",
      "passes": false,
      "evidence": null
    }
  ],
  "checks": {
    "tsc": true,
    "build": true,
    "test": false
  }
}
```

---

## Build Order

### Stage 1: Update buildUnifiedBugPrompt()

Replace the curl-based closure commands with local mentu CLI commands.

**File**: `src/simple-bug-executor.ts`

**Current** (lines 449-461):
```typescript
curl -X POST "${proxyUrl}/ops" \\
  -H "X-Proxy-Token: ${proxyToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"op": "capture", "body": "Fixed: <your summary here>", "kind": "evidence", "workspace_id": "${workspaceId}", "actor": "agent:claude-vps"}'
```

**Replace with**:
```typescript
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
```

**Verification**:
```bash
grep -n "curl.*proxyUrl.*ops" src/simple-bug-executor.ts
# Should return empty (no more curl commands)

grep -n "mentu capture" src/simple-bug-executor.ts
# Should find the new mentu capture instruction
```

---

### Stage 2: Add VerificationResult Interface

Add new types for verification results.

**File**: `src/simple-bug-executor.ts`

**Add after BugFixResult interface** (around line 78):

```typescript
interface VerificationResult {
  verified: boolean;
  gitCommits: number;
  filesChanged: string[];
  ledgerHasClose: boolean;
  pushedToRemote: boolean;
  headRef: string;
  reason: string;
}
```

**Update BugFixResult** to include verification:

```typescript
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
```

---

### Stage 3: Add Git Helper Methods

Add methods to query git state.

**File**: `src/simple-bug-executor.ts`

**Add to the class** (after the utilities section, around line 830):

```typescript
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
```

**Add import at top of file**:
```typescript
import { exec } from "child_process";
```

---

### Stage 4: Add Ledger Verification Method

Add method to check if ledger has the close operation.

**File**: `src/simple-bug-executor.ts`

**Add to the class** (after git helpers):

```typescript
private async checkLedgerClose(cwd: string, commitmentId: string): Promise<boolean> {
  const ledgerPath = `${cwd}/.mentu/ledger.jsonl`;

  return new Promise((resolve) => {
    fs.readFile(ledgerPath, 'utf-8', (error, data) => {
      if (error) {
        this.log(`Ledger read error: ${error.message}`);
        resolve(false);
        return;
      }

      // Parse JSONL and look for close operation on this commitment
      const lines = data.trim().split('\n');
      for (const line of lines.reverse()) { // Check recent ops first
        try {
          const op = JSON.parse(line);
          if (op.op === 'close' && op.payload?.commitment === commitmentId) {
            return resolve(true);
          }
        } catch {
          // Skip invalid JSON lines
        }
      }

      resolve(false);
    });
  });
}
```

**Add import at top of file** (if not already present):
```typescript
import * as fs from "fs";
```

---

### Stage 5: Add verifyOutcome() Method

The main verification method that checks all outcomes.

**File**: `src/simple-bug-executor.ts`

**Add to the class** (after ledger verification):

```typescript
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
```

---

### Stage 6: Update executeBugFix() to Capture Start Ref

Modify executeBugFix() to record git HEAD before spawning Claude.

**File**: `src/simple-bug-executor.ts`

**In executeBugFix()** (around line 325, after status update to 'running'):

**Add**:
```typescript
// Capture starting git ref for verification
const startRef = await this.getHeadRef(workingDirectory);
this.log(`Starting ref: ${startRef}`);
```

**Modify the return** to pass startRef to verification:
```typescript
// After spawnTerminalClaude returns, add verification
const claudeResult = await this.spawnTerminalClaude(...);

// Verify outcomes
const verification = await this.verifyOutcome(
  workingDirectory,
  commitmentId,
  startRef,
  { success: claudeResult.success, blocked_reason: claudeResult.blocked_reason }
);

return {
  ...claudeResult,
  verified: verification.verified,
  files_changed: verification.filesChanged.length > 0
    ? verification.filesChanged
    : claudeResult.files_changed,
  verification,
};
```

---

### Stage 7: Update handleResult() to Use Verification

Modify handleResult() to check verification status.

**File**: `src/simple-bug-executor.ts`

**In handleResult()** (around line 669):

**Update the success determination**:
```typescript
private async handleResult(command: BugCommand, result: BugFixResult): Promise<void> {
  const commandId = command.id;
  const commitmentId = command.commitment_id || command.payload?.commitment_id;

  // Success requires verification, not just exit code
  const actualSuccess = result.verified ?? result.success;

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
        output: result.output?.slice(-5000),
      },
    })
    .eq('id', commandId);

  this.log(`Completed ${commandId} - verified: ${result.verified}, success: ${actualSuccess}`);
  this.log(`Verification reason: ${result.verification?.reason}`);

  // ... rest of callback handling
}
```

---

## Verification Checklist

### Files
- [ ] `src/simple-bug-executor.ts` modified with all stages

### Checks
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes
- [ ] No runtime errors on import

### Functionality
- [ ] Prompt uses `mentu capture` and `mentu close` (not curl)
- [ ] verifyOutcome() checks git commits
- [ ] verifyOutcome() checks ledger for close op
- [ ] Files changed come from git diff
- [ ] Success = verified, not just exitCode === 0

### Integration
- [ ] Works with existing daemon.ts lifecycle
- [ ] Result includes verification details in Supabase

---

## Completion Phase (REQUIRED)

**BEFORE calling `mentu submit`, you MUST create a RESULT document:**

### Step 1: Create RESULT Document

Read the template and create the RESULT document:

```bash
cat docs/templates/TEMPLATE-Result.md
# Create: docs/RESULT-SimpleBugExecutorVerification-v1.0.md
```

### Step 2: Capture RESULT as Evidence

```bash
mentu capture "Created RESULT-SimpleBugExecutorVerification: Verification system implemented" \
  --kind result-document \
  --path docs/RESULT-SimpleBugExecutorVerification-v1.0.md \
  --refs cmt_XXXXXXXX \
  --author-type executor
```

### Step 3: Submit with Evidence

```bash
mentu submit cmt_XXXXXXXX \
  --summary "SimpleBugExecutor now verifies git commits and ledger state" \
  --include-files
```

---

*Trust but verify. Exit code 0 means "didn't crash", not "succeeded".*
