---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: PRD-SimpleBugExecutorVerification-v1.0
path: docs/PRD-SimpleBugExecutorVerification-v1.0.md
type: prd
intent: reference

version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14

tier: T2

children:
  - HANDOFF-SimpleBugExecutorVerification-v1.0

dependencies:
  - docs/plans/noble-riding-anchor.md

mentu:
  commitment: pending
  status: pending
---

# PRD: SimpleBugExecutor Verification v1.0

## Mission

Fix SimpleBugExecutor to verify actual outcomes before reporting success. Currently the executor trusts exit code 0 blindly and reports "success" without confirming that work was done, code was committed, or the local ledger was updated.

---

## Problem Statement

### Current State

```
┌──────────────────────┐     ┌─────────────────────┐     ┌────────────────┐
│  SimpleBugExecutor   │     │    Claude Agent     │     │    Supabase    │
│                      │     │                     │     │                │
│  spawn claude ──────>│     │  curl proxyUrl/ops ─┼────>│  writes ops    │
│                      │     │  (bypasses ledger)  │     │                │
│  exitCode === 0? ───>│ YES │                     │     │                │
│                      │     │  "already fixed"    │     │                │
│  report SUCCESS      │<────│  exit 0             │     │                │
└──────────────────────┘     └─────────────────────┘     └────────────────┘
                                      │
                                      │  LOCAL LEDGER: UNTOUCHED
                                      │  GIT COMMITS: NONE
                                      │  GITHUB PUSH: NONE
                                      ▼
                               FALSE SUCCESS
```

**Problems identified:**

1. **Blind exit code trust**: `exitCode === 0` → `success: true` without verification
2. **Proxy API bypasses local ledger**: `curl proxyUrl/ops` writes to Supabase only, `.mentu/ledger.jsonl` remains unchanged
3. **No git verification**: Agent can claim "already fixed" without making any commits
4. **No outcome parsing**: Claude's output is only searched for JSON, no verification of actual work
5. **Claude can lie**: "Fixed" → exit 0 → marked successful, but nothing actually changed

### Desired State

```
┌──────────────────────┐     ┌─────────────────────┐     ┌────────────────┐
│  SimpleBugExecutor   │     │    Claude Agent     │     │  Local Ledger  │
│                      │     │                     │     │                │
│  spawn claude ──────>│     │  mentu capture      │────>│  appends op    │
│                      │     │  mentu close        │     │                │
│  VERIFY:             │     │  git commit         │     │                │
│  - git diff HEAD~1   │<────│  git push           │     │                │
│  - ledger has close  │     │                     │     │                │
│  - files changed?    │     │                     │     │                │
│                      │     │                     │     │                │
│  VERIFIED SUCCESS    │     │                     │     │                │
└──────────────────────┘     └─────────────────────┘     └────────────────┘
```

**Fixes:**

1. **Use local `mentu` CLI** in the prompt instead of `curl proxyUrl/ops`
2. **Verify git state**: Check `git diff`, `git log`, `git status` after execution
3. **Verify ledger state**: Check `.mentu/ledger.jsonl` for close operation
4. **Parse actual outcomes**: Extract files changed from git, not just Claude's word
5. **Require evidence**: Success requires either verified fix OR verified "blocked" status

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

## Core Concepts

### Trust Gradient

The executor has different trust levels for different signals:

| Signal | Trust Level | Verification |
|--------|-------------|--------------|
| Exit code 0 | LOW | Only means "didn't crash" |
| Claude's JSON output | LOW | Claude can claim anything |
| Git commit exists | HIGH | Verifiable artifact |
| Ledger has close op | HIGH | Append-only proof |
| Tests pass | MEDIUM | Can be skipped/faked |

### Outcome Verification

After Claude exits, run verification checks:

```typescript
interface VerificationResult {
  gitVerified: boolean;      // Has commits on HEAD since start
  ledgerVerified: boolean;   // Has close op for commitment
  filesFromGit: string[];    // Files changed (from git, not Claude)
  commitMessages: string[];  // Commit messages made
  pushedToRemote: boolean;   // Whether pushed
}
```

### Local vs Proxy Operations

| Operation | Local (`mentu` CLI) | Proxy (`curl`) |
|-----------|---------------------|----------------|
| Writes to | `.mentu/ledger.jsonl` AND Supabase | Supabase only |
| Verifiable | Yes (read local file) | No (need API call) |
| Git integration | Yes (same machine) | No |
| Use for | Bug fix agents | Remote triggers |

---

## Specification

### Types

```typescript
interface VerificationConfig {
  checkGit: boolean;        // Verify git commits exist
  checkLedger: boolean;     // Verify ledger has close op
  checkPush: boolean;       // Verify pushed to remote
  trustClaudeJson: boolean; // Trust Claude's output JSON
}

interface VerificationResult {
  verified: boolean;
  gitCommits: number;
  filesChanged: string[];
  ledgerHasClose: boolean;
  pushedToRemote: boolean;
  reason: string;
}

interface BugFixResult {
  success: boolean;
  verified: boolean;        // NEW: verification passed
  summary: string;
  files_changed: string[];  // From git, not Claude
  tests_passed: boolean;
  exit_code: number;
  output: string;
  verification: VerificationResult;  // NEW
  blocked_reason?: string;
}
```

### Operations

| Operation | Input | Output | Description |
|-----------|-------|--------|-------------|
| `verifyGitChanges()` | cwd, startRef | VerificationResult | Check if commits exist since start |
| `verifyLedgerClose()` | cwd, commitmentId | boolean | Check ledger for close operation |
| `extractFilesFromGit()` | cwd, startRef | string[] | Get changed files from git diff |
| `buildVerifiedPrompt()` | bugMemory, commitmentId | string | Build prompt using local CLI |

### Validation Rules

- Exit code 0 DOES NOT mean success (only "didn't crash")
- Success requires EITHER verified git commits OR verified blocked status with evidence
- Files changed MUST come from `git diff`, not Claude's JSON
- Ledger close operation MUST exist for verified success
- If no commits AND no blocked evidence → FAILED (not successful)

---

## Implementation

### Deliverables

| File | Purpose |
|------|---------|
| `src/simple-bug-executor.ts` | Modify buildUnifiedBugPrompt(), add verifyOutcome(), update handleResult() |

### Build Order

1. **Update buildUnifiedBugPrompt()**: Replace `curl proxyUrl/ops` with `mentu capture` and `mentu close` commands
2. **Add verifyOutcome()**: New method to check git and ledger state
3. **Add git helpers**: getHeadRef(), getCommitsSince(), getFilesChanged()
4. **Update handleResult()**: Run verification before marking success
5. **Update BugFixResult**: Add verified and verification fields

### Integration Points

| System | Integration | Notes |
|--------|-------------|-------|
| Git | Exec `git` commands | Use child_process.exec, parse output |
| Ledger | Read `.mentu/ledger.jsonl` | Parse JSONL, search for close op |
| mentu CLI | Agent runs `mentu` | CLI must be in PATH on VPS |

---

## Constraints

- DO NOT break existing daemon lifecycle (start/stop)
- DO NOT change database schema
- DO NOT add new dependencies
- MAINTAIN backwards compatibility with existing commands
- DO NOT require git push (some repos may not have remote configured)

---

## Success Criteria

### Functional

- [ ] Agent prompt uses `mentu capture` and `mentu close` (not curl)
- [ ] After execution, verifyOutcome() runs and checks git/ledger
- [ ] Success requires verification OR explicit blocked status
- [ ] Files changed in result come from git diff, not Claude JSON

### Quality

- [ ] TypeScript compiles without errors
- [ ] npm run build succeeds
- [ ] Existing tests still pass

### Integration

- [ ] Works with existing daemon.ts lifecycle
- [ ] Works with existing Supabase bridge_commands schema
- [ ] Works on VPS with mentu CLI installed

---

## Verification Commands

```bash
# Build
npm run build

# Check TypeScript
npx tsc --noEmit

# Test manually (after deployment)
# 1. Submit bug via WarrantyOS
# 2. Watch logs: journalctl -u mentu-bridge -f
# 3. Verify git log shows commits
# 4. Verify .mentu/ledger.jsonl has close op
```

---

## References

- `docs/plans/noble-riding-anchor.md`: Original rebuild plan
- `mentu-ai/CLAUDE.md`: Mentu protocol and CLI documentation
- `src/simple-bug-executor.ts:381-503`: Current buildUnifiedBugPrompt()
- `src/simple-bug-executor.ts:659-689`: Current handleResult()

---

*SimpleBugExecutor should verify outcomes, not trust Claude's word. Trust but verify.*
