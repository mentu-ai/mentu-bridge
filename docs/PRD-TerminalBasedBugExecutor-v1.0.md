---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: PRD-TerminalBasedBugExecutor-v1.0
path: docs/PRD-TerminalBasedBugExecutor-v1.0.md
type: prd
intent: reference

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

children:
  - HANDOFF-TerminalBasedBugExecutor-v1.0
dependencies:
  - CLAUDE.md

mentu:
  commitment: cmt_tbe_c06c29
  status: pending
---

# PRD: TerminalBasedBugExecutor v1.0

## Mission

Replace the headless JSON-prompt approach in bug-executor.ts with terminal-based Claude spawning that aligns with the Dual Triad architecture. Claude becomes the actor (claims/closes commitments), while the bridge becomes pure infrastructure.

---

## Problem Statement

### Current State

```
Bridge daemon (BROKEN)
  ├── claim() ← Bridge is actor in ledger
  ├── craftAudit() → Spawns Claude with JSON prompt
  │   └── Claude returns JSON only (no ledger access)
  ├── spawnExecutor() → Spawns Claude with JSON prompt
  │   └── Claude returns JSON only (no ledger access)
  └── closeCommitment() ← Bridge is actor in ledger

Problems:
- Bridge is the ACTOR (wrong - it's infrastructure)
- Claude is just a JSON generator (wrong - should be actor)
- No visibility into what Claude is doing
- No ledger access for Claude
- Wrong working directory (uses workspace config, not command.working_directory)
```

The bug-executor uses `resolveWorkspaceDirectory()` which returns the workspace root from bridge.yaml, **overriding** the correct `command.working_directory`. This caused the executor to run in `/home/mentu/Workspaces/projects/inline-substitute` instead of `/home/mentu/Workspaces/projects/inline-substitute/vin-to-value-main`, so it couldn't find the files.

### Desired State

```
Bridge daemon (CORRECT - Dual Triad)
  ├── Write bug-context.md to workspace
  └── Spawn Claude in workspace directory
       ↓
  Claude (in workspace)
    ├── mentu claim cmt_xxx ← Claude is actor
    ├── Read, Edit, Bash, Grep (fix the bug)
    ├── mentu capture (evidence)
    └── mentu close cmt_xxx ← Claude closes

Benefits:
- Claude is the ACTOR (correct)
- Bridge is just infrastructure (correct)
- Full visibility (you can watch Claude work)
- Claude has mentu CLI access
- Correct working directory (command.working_directory used directly)
```

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
  "instruction_id": "HANDOFF-TerminalBasedBugExecutor-v1.0",
  "created": "2026-01-13T00:00:00Z",
  "status": "in_progress",
  "tier": "T2",
  "mentu": {
    "commitment": "cmt_XXXXXXXX",
    "source": "mem_XXXXXXXX"
  },
  "features": [
    {
      "id": "F001",
      "description": "bug-executor uses command.working_directory directly (not workspace config)",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "Bug context file written to .mentu/bug-context.md in target workspace",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "Claude spawned in terminal mode with cwd set to command.working_directory",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "Bridge does NOT claim/close - Claude is expected to do so",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F005",
      "description": "TypeScript compiles without errors",
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

### Terminal-Based Execution

Instead of passing large prompts via `claude -p "..."`, spawn Claude in the workspace directory and let it read context from a file. This gives Claude:
- Full tool access (Read, Edit, Bash, Grep, Glob)
- Mentu CLI access for claim/close/capture
- Correct working directory context
- Debuggability (you can watch it work)

### Context File Pattern

Bridge writes a `bug-context.md` file containing:
- Commitment ID
- Bug objective (from Auditor)
- Scope boundaries
- First steps (claim, fix, close)

Claude reads this file on startup and follows the instructions.

### Actor Model Alignment

| Component | Role | Ledger Operations |
|-----------|------|-------------------|
| Bridge | Infrastructure | NONE |
| Auditor (Claude) | Analysis | Optional capture |
| Executor (Claude) | Work | claim, capture, close |

---

## Specification

### Types

```typescript
interface BugContext {
  commitmentId: string;
  objective: string;
  hypothesis: string;
  likelyFiles: string[];
  scope: {
    allowedPatterns: string[];
    forbiddenPatterns: string[];
    maxFileChanges: number;
  };
  constraints: string[];
  successCriteria: string[];
}
```

### Operations

| Operation | Input | Output | Description |
|-----------|-------|--------|-------------|
| `writeBugContext` | BugContext, path | void | Writes context file to workspace |
| `spawnTerminalExecutor` | workingDirectory, timeout | void | Spawns Claude in terminal mode |

### Validation Rules

- command.working_directory MUST be used directly (not overridden by workspace config)
- Context file MUST be written before spawning Claude
- Bridge MUST NOT record claim/close operations in ledger
- Claude MUST be spawned with `--dangerously-skip-permissions`

---

## Implementation

### Deliverables

| File | Purpose |
|------|---------|
| `src/bug-executor.ts` | Modified to use terminal spawning |
| `src/context-writer.ts` | New file for writing bug-context.md |

### Build Order

1. **Create context-writer.ts**: Function to write structured bug context
2. **Modify executeBugCommand()**: Remove direct claim, use command.working_directory
3. **Replace spawnExecutor()**: Terminal spawn instead of headless JSON

### Integration Points

| System | Integration | Notes |
|--------|-------------|-------|
| mentu-proxy | No changes | Bridge command structure unchanged |
| Target workspace | .mentu/bug-context.md | Claude reads this on startup |

---

## Constraints

- MUST NOT change bridge_commands table schema
- MUST maintain backwards compatibility with non-bug commands
- MUST use command.working_directory (not workspace config override)
- Bridge MUST NOT be an actor in the ledger

---

## Success Criteria

### Functional

- [ ] Bug executor uses correct working directory from command
- [ ] Context file is written before Claude spawns
- [ ] Claude spawns in terminal mode with correct cwd
- [ ] Claude can claim/close commitments (not bridge)

### Quality

- [ ] TypeScript compiles without errors
- [ ] npm run build succeeds

### Integration

- [ ] Works with existing bridge_commands from mentu-proxy
- [ ] Tested with real bug report end-to-end

---

## Verification Commands

```bash
# Verify build
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
npm run build

# Verify TypeScript
npx tsc --noEmit

# Test by triggering a bug report
# Then check VPS logs: journalctl -u mentu-bridge -f
```

---

## References

- `docs/DUAL-TRIAD.md`: Actor model specification
- `CLAUDE.md`: Project context and execution modes
- `src/bug-executor.ts`: Current implementation to modify

---

*This PRD fixes the fundamental architectural misalignment where bridge acts as ledger actor instead of Claude.*
