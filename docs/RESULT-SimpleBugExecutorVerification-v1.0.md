---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: RESULT-SimpleBugExecutorVerification-v1.0
path: docs/RESULT-SimpleBugExecutorVerification-v1.0.md
type: result
intent: document

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

author_type: executor

parent: HANDOFF-SimpleBugExecutorVerification-v1.0

mentu:
  commitment: pending
  status: completed
---

# RESULT: SimpleBugExecutorVerification v1.0

## Execution Summary

**Objective**: Fix SimpleBugExecutor to verify actual outcomes (git commits, ledger updates) before reporting success, instead of blindly trusting exit code 0.

**Outcome**: SUCCESS

**Evidence**:
- `src/simple-bug-executor.ts` modified with verification system
- TypeScript compiles without errors (`npm run build` passes)
- All 5 features verified via grep

---

## Changes Made

### F001: Prompt uses local mentu CLI instead of curl proxyUrl/ops

**File**: `src/simple-bug-executor.ts:449-500`

```typescript
1. **Commit your changes** (if any files were modified):
\`\`\`bash
git add -A
git commit -m "fix: <brief description of fix>..."
git push origin HEAD
\`\`\`

2. **Capture evidence** (run from ${workingDirectory}):
\`\`\`bash
mentu capture "Fixed: <your summary here>" --kind evidence --actor agent:claude-vps
\`\`\`

3. **Close commitment** (use the mem_ID from above):
\`\`\`bash
mentu close ${commitmentId} --evidence mem_XXXXXXXX --actor agent:claude-vps
\`\`\`
```

**Before**: Used curl to POST to proxyUrl/ops
**After**: Uses local mentu CLI which writes to .mentu/ledger.jsonl

### F002: verifyOutcome() checks git status for actual commits

**File**: `src/simple-bug-executor.ts:906-916`

```typescript
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
```

**How it works**: Captures HEAD ref before spawning Claude, then counts commits since that ref after execution.

### F003: verifyOutcome() checks ledger for close operation

**File**: `src/simple-bug-executor.ts:947-973`

```typescript
private async checkLedgerClose(cwd: string, commitmentId: string): Promise<boolean> {
  const ledgerPath = `${cwd}/.mentu/ledger.jsonl`;
  // Parse JSONL and look for close operation on this commitment
  for (const line of lines.reverse()) {
    const op = JSON.parse(line);
    if (op.op === 'close' && op.payload?.commitment === commitmentId) {
      return resolve(true);
    }
  }
  resolve(false);
}
```

**How it works**: Reads .mentu/ledger.jsonl and searches for a close operation matching the commitment ID.

### F004: Success requires verified evidence OR verified blocked status

**File**: `src/simple-bug-executor.ts:703-704`

```typescript
// Success requires verification, not just exit code
const actualSuccess = result.verified ?? result.success;
```

**Before**: `result.success` (just exit code 0)
**After**: `result.verified` takes precedence - requires git commits or ledger close

### F005: Files changed extracted from git diff, not Claude's JSON

**File**: `src/simple-bug-executor.ts:387-389`

```typescript
files_changed: verification.filesChanged.length > 0
  ? verification.filesChanged
  : claudeResult.files_changed,
```

**How it works**: `getFilesChangedSince()` uses `git diff --name-only` to get actual changed files, which overrides Claude's self-reported list.

---

## New Types Added

### VerificationResult Interface

**File**: `src/simple-bug-executor.ts:69-77`

```typescript
export interface VerificationResult {
  verified: boolean;
  gitCommits: number;
  filesChanged: string[];
  ledgerHasClose: boolean;
  pushedToRemote: boolean;
  headRef: string;
  reason: string;
}
```

### Updated BugFixResult

**File**: `src/simple-bug-executor.ts:79-89`

Added `verified: boolean` and `verification?: VerificationResult` fields.

---

## Verification Logic

**File**: `src/simple-bug-executor.ts:980-1041`

The `verifyOutcome()` method implements this logic:

| Claude Says | Git Commits | Ledger Close | Verified? | Reason |
|------------|-------------|--------------|-----------|--------|
| success | > 0 | yes | ✅ | Verified: N commits, ledger closed |
| success | > 0 | no | ✅ | Verified: N commits (ledger close pending sync) |
| success | 0 | yes | ❌ | Ledger closed but no git commits - unverified |
| success | 0 | no | ❌ | No git commits and no ledger close |
| blocked | - | yes | ✅ | Blocked with documented reason |
| blocked | - | no | ⚠️ | Only if blocked_reason > 20 chars |
| failure | - | - | ❌ | Claude reported failure |

---

## Files Modified

| File | Action | Purpose |
|------|--------|---------|
| `src/simple-bug-executor.ts` | Modified | Added verification system |

---

## Verification Checklist

- [x] Prompt uses `mentu capture` and `mentu close` (not curl)
- [x] verifyOutcome() checks git commits via `getCommitsSince()`
- [x] verifyOutcome() checks ledger via `checkLedgerClose()`
- [x] Files changed come from git diff via `getFilesChangedSince()`
- [x] Success = verified, not just exitCode === 0
- [x] `npm run build` passes
- [x] `npx tsc --noEmit` passes
- [x] Result includes verification details in Supabase

---

*Trust but verify. Exit code 0 means "didn't crash", not "succeeded".*
