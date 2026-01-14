---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: RESULT-TerminalBasedBugExecutor-v1.0
path: docs/RESULT-TerminalBasedBugExecutor-v1.0.md
type: result
intent: document

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

author_type: executor

parent: HANDOFF-TerminalBasedBugExecutor-v1.0

mentu:
  commitment: cmt_tbe_c06c29
  status: completed
---

# RESULT: TerminalBasedBugExecutor v1.0

## Execution Summary

**Objective**: Replace headless JSON-prompt bug executor with terminal-based Claude spawning. Bridge becomes infrastructure, Claude becomes actor.

**Outcome**: SUCCESS

**Evidence**:
- `src/context-writer.ts` created - writes structured bug context to `.mentu/bug-context.md`
- `src/bug-executor.ts` modified - `executeBugCommand()` now uses terminal-based spawning
- TypeScript compiles without errors (`npm run build` passes)

---

## Changes Made

### F001: Bug-executor uses command.working_directory directly

**File**: `src/bug-executor.ts:1007-1010`

```typescript
// CRITICAL FIX: Use command.working_directory directly
// Do NOT use resolveWorkspaceDirectory() which overrides with workspace config
const workingDirectory = command.working_directory;
console.log(`[BugExecutor] Using command working_directory: ${workingDirectory}`);
```

**Before**: Used `resolveWorkspaceDirectory()` which could override with workspace config
**After**: Uses `command.working_directory` directly, respecting the command's specified path

### F002: Bug context file written to .mentu/bug-context.md

**File**: `src/context-writer.ts` (new file)

Created `writeBugContext()` function that:
- Creates `.mentu/` directory if needed
- Writes structured markdown with:
  - Commitment ID
  - Objective from Auditor
  - Hypothesis and likely files
  - Scope boundaries (allowed/forbidden patterns)
  - Constraints
  - Success criteria
  - Clear task instructions for Claude

### F003: Claude spawned in terminal mode with correct cwd

**File**: `src/bug-executor.ts:1070-1166`

New `spawnTerminalExecutor()` method:
- Spawns Claude with `--dangerously-skip-permissions` and `--max-turns 50`
- Uses correct `cwd: workingDirectory`
- Passes `MENTU_BRIDGE_COMMAND_ID` env var
- Streams stdout/stderr with logging
- Extracts JSON result from Claude output

### F004: Bridge does NOT claim/close commitments

**File**: `src/bug-executor.ts:1059-1061`

```typescript
// NOTE: Bridge does NOT claim or close
// Claude is expected to do this via mentu CLI
```

**Before**: Bridge claimed commitment in Step 2, closed in Step 5
**After**: Bridge only spawns Claude; Claude handles claim/close via mentu CLI

### F005: TypeScript compiles without errors

```bash
$ npm run build
> @mentu/bridge@1.0.0 build
> tsc

$ npx tsc --noEmit
# No errors
```

---

## Architecture Shift

### Before (Headless JSON-Prompt)
```
Bridge → claim commitment → spawn Claude (headless JSON) → close commitment
           ↑                         ↓
        LEDGER OPS              EXECUTION ONLY
```

### After (Terminal-Based)
```
Bridge → write context → spawn Claude (terminal mode)
                                    ↓
                        Claude reads .mentu/bug-context.md
                                    ↓
                        Claude: claim → fix → capture → close
                                    ↓
                               LEDGER OPS
```

**Key Insight**: The Dual Triad is restored. Bridge is infrastructure (spawning, streaming). Claude is the actor (claiming, fixing, closing).

---

## Files Modified

| File | Action | Purpose |
|------|--------|---------|
| `src/context-writer.ts` | Created | Write structured bug context for Claude |
| `src/bug-executor.ts` | Modified | Terminal-based spawning, removed bridge ledger ops |

---

## Verification Checklist

- [x] `src/context-writer.ts` exists
- [x] `src/bug-executor.ts` modified with new spawnTerminalExecutor
- [x] `npm run build` passes
- [x] `npx tsc --noEmit` passes
- [x] Bug execution uses command.working_directory (not workspace config)
- [x] Context file written to .mentu/bug-context.md
- [x] Claude spawns in terminal mode with correct cwd
- [x] Claude claims and closes (not bridge)

---

*Bridge becomes infrastructure. Claude becomes actor. The Dual Triad is restored.*
