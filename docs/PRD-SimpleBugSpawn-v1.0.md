---
id: PRD-SimpleBugSpawn-v1.0
path: docs/PRD-SimpleBugSpawn-v1.0.md
type: prd
intent: reference
version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14
tier: T2
children:
  - HANDOFF-SimpleBugSpawn-v1.0
dependencies:
  - mentu-bridge/src/simple-bug-executor.ts
  - mentu-proxy/src/handlers/spawn-bug-execution.ts
mentu:
  commitment: cmt_80f13e82
  status: pending
---

# PRD: SimpleBugSpawn v1.0

## Mission

Refactor bug execution spawning to use CLI argument-based prompts with repo-local protocol files, replacing stdin piping with a simple, reliable spawn pattern that delegates bug-fix instructions to each repository's own `BUG-FIX-PROTOCOL.md`.

---

## Problem Statement

### Current State

```
Beacon → /bug-webhook → memory + commitment
                              ↓
                    proxy builds prompt A
                              ↓
                    bridge_commands (prompt A stored)
                              ↓
              SimpleBugExecutor polls, finds command
                              ↓
              SimpleBugExecutor builds prompt B (DIFFERENT!)
                              ↓
              spawn('claude', [...])
              proc.stdin.write(prompt B)
              proc.stdin.end()
                              ↓
              Claude runs (30 turns max)
              References ./BUG-FIX-PROTOCOL.md
              (may not exist in repo)
                              ↓
              "Reached max turns (30)" - TIMEOUT
              No git commits, no ledger close
              FAILED
```

**Issues:**
1. **Double prompt construction** - Proxy builds one prompt, SimpleBugExecutor ignores it and builds another
2. **Stdin piping fragility** - Claude CLI may not reliably read stdin-piped prompts
3. **Insufficient max turns** - 30 turns is not enough for bug investigation + fix + verification
4. **Missing protocol files** - References `BUG-FIX-PROTOCOL.md` that doesn't exist in most repos
5. **Hardcoded paths** - VPS vs Mac path translation logic scattered across files

### Desired State

```
Beacon → /bug-webhook → memory + commitment
                              ↓
                    bridge_commands (minimal metadata only)
                              ↓
              SimpleBugExecutor polls, finds command
                              ↓
              Reads metadata: { working_directory, memory_id, commitment_id }
                              ↓
              cd <working_directory>
              claude --dangerously-skip-permissions --max-turns 50 \
                "Fix this bug (commitment: cmt_xxx):
                 ${bug_description}

                 Full instructions: Read ./BUG-FIX-PROTOCOL.md
                 Bug details available as memory: mem_xxx"
                              ↓
              Claude runs in repo directory
              Reads repo's BUG-FIX-PROTOCOL.md (repo-specific)
              Follows repo-specific instructions
              Closes commitment with evidence
                              ↓
              SimpleBugExecutor verifies: git commits, ledger close
              SUCCESS
```

**Benefits:**
- Single source of truth: repo's `BUG-FIX-PROTOCOL.md` owns all bug-fix instructions
- CLI argument: reliable, no stdin piping issues
- Working directory from metadata: no hardcoded paths
- Higher max turns (50+): enough for investigation + fix + verification

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
  "instruction_id": "HANDOFF-SimpleBugSpawn-v1.0",
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
      "description": "SimpleBugExecutor spawns Claude with prompt as CLI argument (not stdin)",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "Minimal prompt references ./BUG-FIX-PROTOCOL.md for repo-specific instructions",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "Working directory comes from command metadata, not hardcoded",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "Max turns increased to 50 (configurable)",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F005",
      "description": "BUG-FIX-PROTOCOL.md template exists for repos to copy",
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

### Minimal Prompt Pattern

The spawn prompt is intentionally minimal:
```
Fix this bug (commitment: ${commitmentId}):
${bugDescription}

Full instructions: Read ./BUG-FIX-PROTOCOL.md
Bug details available as memory: ${memoryId}
```

All detailed instructions live in the repo's `BUG-FIX-PROTOCOL.md` file.

### Repo-Local Protocol

Each repository contains its own `BUG-FIX-PROTOCOL.md` with:
- Tech stack specifics (React, Vue, Node, etc.)
- Build and test commands
- Mentu CLI usage for this repo
- Constraints and coding standards
- Evidence capture patterns

### Trigger Metadata

The `bridge_commands` record contains all routing information:
- `working_directory`: absolute path (already translated for VPS/Mac)
- `commitment_id`: the commitment to close
- `payload.memory_id`: the bug report memory

---

## Integration Architecture

### Current Implementation: Workspace Settings

Path resolution currently lives in `workspaces.settings.bug_reports.sources`:

```json
{
  "bug_reports": {
    "approval_mode": "autonomous",
    "sources": {
      "warrantyos": {
        "working_directory": "/Users/rashid/.../inline-substitute",
        "vps_directory": "/home/mentu/.../inline-substitute",
        "target_machine_id": "vps-01",
        "timeout_seconds": 3600
      }
    }
  }
}
```

### Path Resolution Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     BUG WEBHOOK FLOW                                 │
│                                                                      │
│  WarrantyOS → POST /bug-webhook                                     │
│                    ↓                                                 │
│  1. Extract workspace_id from request body                          │
│                    ↓                                                 │
│  2. Query: SELECT settings FROM workspaces WHERE id = workspace_id  │
│                    ↓                                                 │
│  3. Get source config: settings.bug_reports.sources['warrantyos']   │
│                    ↓                                                 │
│  4. Determine target: target_machine_id || default_machine_id       │
│                    ↓                                                 │
│  5. Select path based on target:                                    │
│     IF target.startsWith('vps') AND vps_directory EXISTS:           │
│       working_directory = vps_directory                             │
│     ELSE:                                                           │
│       working_directory = working_directory                         │
│                    ↓                                                 │
│  6. Insert bridge_commands with resolved working_directory          │
└─────────────────────────────────────────────────────────────────────┘
```

### Proxy Code Reference

From `mentu-proxy/src/handlers/spawn-bug-execution.ts` (lines 177-180):

```typescript
// Use VPS directory when targeting a VPS machine
const workingDirectory = (targetMachine?.startsWith('vps') && sourceConfig.vps_directory)
  ? sourceConfig.vps_directory
  : sourceConfig.working_directory;
```

### Integration Registration

External services map to workspaces via `workspaces.settings.bug_reports.sources`:

| Source | Workspace | VPS Directory | Mac Directory |
|--------|-----------|---------------|---------------|
| `warrantyos` | `inline-substitute` | `/home/mentu/.../vin-to-value-main` | `/Users/rashid/.../vin-to-value-main` |

### Future Direction: Genesis Key Integration

The canonical schema should be extended to include path mappings:

```yaml
# Future: .mentu/genesis.key
identity:
  workspace: inline-substitute
  paths:
    local: "/Users/rashid/.../inline-substitute"
    vps: "/home/mentu/.../inline-substitute"
  machines:
    - id: "vps-01"
      role: "executor"
```

**Migration path**: Once genesis.key includes paths, proxy can read from genesis.key instead of workspace settings. This keeps directory mappings closer to the repository (self-describing).

---

## Specification

### Types

```typescript
// Simplified - metadata-driven
interface BugExecutionCommand {
  id: string;
  workspace_id: string;
  command_type: 'bug_execution';
  working_directory: string;  // Already translated for target machine
  commitment_id: string;
  payload: {
    memory_id: string;
    bug_title?: string;
    timeout_seconds?: number;
  };
}

// Simplified spawn config
interface SpawnConfig {
  maxTurns: number;         // Default: 50
  timeoutSeconds: number;   // Default: 3600
  claudePath?: string;      // Default: 'claude'
}
```

### Operations

| Operation | Input | Output | Description |
|-----------|-------|--------|-------------|
| `fetchBugDescription` | `memory_id` | `string` | Extract description from bug memory |
| `buildMinimalPrompt` | `command, description` | `string` | Build 4-line minimal prompt |
| `spawnClaudeWithArg` | `workingDir, prompt, config` | `BugFixResult` | Spawn Claude with prompt as CLI arg |

### Spawn Pattern

```typescript
// NEW: CLI argument spawn
spawn('claude', [
  '--dangerously-skip-permissions',
  '--max-turns', config.maxTurns.toString(),
  prompt,  // ← Prompt as positional argument
], {
  cwd: workingDirectory,
  env: {
    ...process.env,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    MENTU_COMMITMENT: commitmentId,
  },
})
```

### Validation Rules

- **MUST** pass prompt as CLI argument, not stdin
- **MUST** read working_directory from command metadata
- **MUST** reference `./BUG-FIX-PROTOCOL.md` (relative path)
- **MUST NOT** build detailed prompts in SimpleBugExecutor
- **MUST NOT** hardcode VPS/Mac paths

---

## Implementation

### Deliverables

| File | Purpose |
|------|---------|
| `src/simple-bug-executor.ts` | Refactor spawn logic to use CLI arg |
| `docs/BUG-FIX-PROTOCOL-TEMPLATE.md` | Template for repos to copy |
| `mentu-proxy/src/handlers/spawn-bug-execution.ts` | Remove prompt building (metadata only) |

### Build Order

1. **Refactor SimpleBugExecutor**: Replace stdin piping with CLI arg spawn
2. **Create Protocol Template**: `docs/BUG-FIX-PROTOCOL-TEMPLATE.md`
3. **Simplify Proxy Handler**: Remove `buildBugFixPrompt`, store metadata only
4. **Verify End-to-End**: Trigger bug, watch spawn, confirm protocol read

### Integration Points

| System | Integration | Notes |
|--------|-------------|-------|
| `mentu-proxy` | Simplified payload | Remove prompt construction |
| `mentu-bridge` | CLI arg spawn | New spawn pattern |
| Target repos | Protocol file | Each repo needs `BUG-FIX-PROTOCOL.md` |

---

## Constraints

- **MUST NOT** break existing `bridge_commands` schema
- **MUST** maintain backwards compatibility with existing commands
- **MUST** preserve verification logic (git commits, ledger close)
- **MUST** handle missing `BUG-FIX-PROTOCOL.md` gracefully (log warning, continue)

---

## Success Criteria

### Functional

- [ ] Bug execution spawns with prompt as CLI argument
- [ ] Claude reads `./BUG-FIX-PROTOCOL.md` from working directory
- [ ] Max turns configurable (default 50)
- [ ] Working directory from command metadata

### Quality

- [ ] `npm run build` passes
- [ ] No TypeScript errors
- [ ] Logs show CLI arg spawn (not stdin)

### Integration

- [ ] End-to-end test: beacon → bridge → Claude → commit closed
- [ ] VPS and Mac paths both work
- [ ] Protocol template available for repos

---

## Verification Commands

```bash
# Build
npm run build

# Check spawn logs on VPS
ssh mentu@208.167.255.71 'grep "Spawning claude" /home/mentu/logs/bridge.log | tail -5'

# Verify protocol template exists
ls docs/BUG-FIX-PROTOCOL-TEMPLATE.md

# Test spawn pattern locally
cd /path/to/repo && claude --max-turns 5 "Read ./BUG-FIX-PROTOCOL.md and summarize"
```

---

## References

- `mentu-bridge/src/simple-bug-executor.ts`: Current stdin-based spawn
- `mentu-proxy/src/handlers/spawn-bug-execution.ts`: Prompt builder to simplify
- `mentu-proxy/src/handlers/bug-webhook.ts`: Entry point from beacon

---

*This PRD delivers a cleaner, more reliable bug execution spawn pattern where repositories own their own bug-fix instructions.*
