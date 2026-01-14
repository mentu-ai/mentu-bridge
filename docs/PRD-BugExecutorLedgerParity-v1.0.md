---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: PRD-BugExecutorLedgerParity-v1.0
path: docs/PRD-BugExecutorLedgerParity-v1.0.md
type: prd
intent: reference

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

children:
  - HANDOFF-BugExecutorLedgerParity-v1.0
dependencies:
  - PRD-TerminalBasedBugExecutor-v1.0

mentu:
  commitment: cmt_fc576be2
  status: pending
---

# PRD: BugExecutorLedgerParity v1.0

## Mission

Fix the mentu-bridge bug executor so that Claude Code properly updates the **Mentu ledger** (via CLI commands) rather than just database fields. The commitment lifecycle (claim → evidence → close) must flow through the actual Mentu protocol, making the ledger the source of truth.

---

## Problem Statement

### Current State

```
┌────────────────────────────────────────────────────────────────────────┐
│  BROKEN FLOW                                                           │
│                                                                        │
│  WarrantyOS Bug Report                                                 │
│         │                                                              │
│         ▼                                                              │
│  mentu-proxy creates: mem_xxx + cmt_xxx in Supabase                   │
│         │                                                              │
│         ▼                                                              │
│  bridge_commands.status = 'pending' → 'claimed' → 'completed'         │
│         │                        ↑                                     │
│         │              Bridge updates DB field only                    │
│         ▼                                                              │
│  Claude spawns, prompt says "mentu claim cmt_xxx"                     │
│         │                                                              │
│         ▼                                                              │
│  ❌ mentu claim FAILS - no .mentu folder, no API config               │
│  ❌ Commitment state in ledger NEVER CHANGES (stays 'open')           │
│  ❌ Bridge marks DB as 'completed' but ledger disagrees               │
└────────────────────────────────────────────────────────────────────────┘
```

**Issues identified:**

1. **bridge_commands.status** is updated but **commitments.state** is not
2. Claude is told to run `mentu claim` but has no configuration to reach the API
3. Working directory (WarrantyOS project) has no `.mentu` folder or config
4. The "claim" in bridge_commands table is NOT a real Mentu claim
5. Evidence is never captured in the ledger
6. Commitment is never properly closed

### Desired State

```
┌────────────────────────────────────────────────────────────────────────┐
│  CORRECT FLOW                                                          │
│                                                                        │
│  WarrantyOS Bug Report                                                 │
│         │                                                              │
│         ▼                                                              │
│  mentu-proxy creates: mem_xxx + cmt_xxx in Supabase ledger            │
│         │                                                              │
│         ▼                                                              │
│  bridge_commands.status = 'pending' (execution tracking only)          │
│         │                                                              │
│         ▼                                                              │
│  Claude spawns with MENTU_* env vars configured                        │
│         │                                                              │
│         ▼                                                              │
│  ✅ Claude runs: mentu claim cmt_xxx → commitments.state = 'claimed'  │
│         │                                                              │
│         ▼                                                              │
│  ✅ Claude fixes bug, runs: mentu capture "Fixed..." --kind evidence  │
│         │                                                              │
│         ▼                                                              │
│  ✅ Claude runs: mentu close cmt_xxx --evidence mem_yyy               │
│         │                              → commitments.state = 'closed'  │
│         ▼                                                              │
│  bridge_commands.status = 'completed' (mirrors ledger truth)           │
└────────────────────────────────────────────────────────────────────────┘
```

**The ledger is the source of truth. bridge_commands tracks execution, not commitment state.**

---

## Completion Contract

**First action**: Create the feature list at the commitment-scoped path:

```bash
mkdir -p .mentu/feature_lists
# Create: .mentu/feature_lists/cmt_XXXXXXXX.json
```

**Path**: `.mentu/feature_lists/cmt_fc576be2.json`

```json
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-BugExecutorLedgerParity-v1.0",
  "created": "2026-01-13T08:42:00Z",
  "status": "in_progress",
  "tier": "T2",
  "mentu": {
    "commitment": "cmt_fc576be2",
    "source": "mem_924568d2"
  },
  "features": [
    {
      "id": "F001",
      "description": "Claude spawns with MENTU_* environment variables configured",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "mentu claim cmt_xxx updates commitments.state in Supabase",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "mentu capture creates operation in Supabase ledger",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "mentu close cmt_xxx updates commitments.state to closed",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F005",
      "description": "bridge_commands.status reflects execution state only (not commitment state)",
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

### Ledger vs Execution Tracking

| Concept | Table | Purpose | Who Updates |
|---------|-------|---------|-------------|
| **Commitment State** | `commitments` (via ledger ops) | Track obligation lifecycle | Claude via `mentu` CLI |
| **Execution Status** | `bridge_commands` | Track spawn/run/complete | Bridge daemon |

These are SEPARATE concerns. The bridge should NEVER update commitment state directly.

### Environment Variables for CLI

The mentu CLI needs these to reach the API:

```bash
MENTU_API_URL=https://mentu-proxy.affihub.workers.dev
MENTU_PROXY_TOKEN=<workspace-token>
MENTU_WORKSPACE_ID=<workspace-uuid>
MENTU_ACTOR=agent:claude-vps
```

### Claim Semantics

| Type | What It Does | Who Does It |
|------|--------------|-------------|
| **Bridge Claim** | Sets `bridge_commands.status = 'claimed'` | Bridge daemon (machine-level) |
| **Mentu Claim** | Creates `claim` op in ledger, updates `commitments.state` | Claude via CLI |

**Only Mentu Claim matters for accountability.**

---

## Specification

### Types

```typescript
// Environment variables passed to Claude process
interface MentuEnvConfig {
  MENTU_API_URL: string;       // https://mentu-proxy.affihub.workers.dev
  MENTU_PROXY_TOKEN: string;   // Workspace API token
  MENTU_WORKSPACE_ID: string;  // Workspace UUID
  MENTU_ACTOR: string;         // agent:claude-vps or similar
}

// What bridge tracks (execution only)
interface BridgeCommandStatus {
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed';
  started_at: string | null;
  completed_at: string | null;
  exit_code: number | null;
}

// What ledger tracks (commitment lifecycle)
interface CommitmentState {
  state: 'open' | 'claimed' | 'in_review' | 'closed' | 'reopened';
  claimed_by: string | null;
  closed_at: string | null;
  evidence: string | null;
}
```

### Operations

| Operation | Input | Output | Description |
|-----------|-------|--------|-------------|
| `spawnTerminalExecutor` | command, envConfig | ExecutionResult | Spawns Claude with Mentu env vars |
| `buildMentuEnv` | workspaceId | MentuEnvConfig | Builds env vars from workspace config |

### State Machine

```
Bridge Status:        pending → claimed → running → completed/failed
                         ↑         ↑         ↑           ↑
                      (INSERT)  (atomic)  (spawn)    (exit code)

Commitment State:     open → claimed → in_review → closed
                        ↑       ↑           ↑          ↑
                     (commit) (mentu     (mentu     (mentu
                              claim)     submit)    close/approve)
```

These state machines are INDEPENDENT. Bridge tracks execution. Ledger tracks accountability.

### Validation Rules

- Claude MUST have MENTU_* env vars to run mentu commands
- Bridge MUST NOT update `commitments` table directly
- Commitment state changes MUST go through mentu CLI → proxy → ledger
- Bridge status can be 'completed' even if commitment is still 'open' (execution finished, but work incomplete)

---

## Implementation

### Deliverables

| File | Purpose |
|------|---------|
| `src/bug-executor.ts` | Update spawnTerminalExecutor to pass MENTU_* env vars |
| `src/env-builder.ts` | New utility to build Mentu CLI environment config |
| `src/daemon.ts` | Ensure workspace token is available for env building |

### Build Order

1. **Create env-builder.ts**: Utility to construct MENTU_* environment variables from workspace config
2. **Update bug-executor.ts**: Pass Mentu env vars when spawning Claude
3. **Verify daemon.ts**: Ensure workspace tokens are loaded from config/discovery

### Integration Points

| System | Integration | Notes |
|--------|-------------|-------|
| `mentu-proxy` | CLI calls proxy API endpoints | /ops for capture/claim/close |
| `workspaces table` | Get API token per workspace | Need token in discovery |
| `mentu CLI` | Uses MENTU_* env vars | Standard CLI behavior |

---

## Constraints

- MUST NOT modify commitment state from bridge code
- MUST NOT require .mentu folder in project (use env vars instead)
- MUST support multiple workspaces with different tokens
- MUST work on VPS where Claude runs headlessly
- MUST maintain backwards compatibility with existing bridge_commands flow

---

## Success Criteria

### Functional

- [ ] Claude can run `mentu claim cmt_xxx` and commitment state changes in Supabase
- [ ] Claude can run `mentu capture "..." --kind evidence` and operation appears in ledger
- [ ] Claude can run `mentu close cmt_xxx --evidence mem_xxx` and commitment closes
- [ ] Full bug lifecycle works: open → claimed → closed (in ledger, not just DB fields)

### Quality

- [ ] TypeScript compiles without errors
- [ ] npm run build succeeds
- [ ] No hardcoded tokens (read from workspace config)

### Integration

- [ ] Works with existing WarrantyOS bug flow
- [ ] Works with multiple workspaces (inline-substitute, mentu-ai, etc.)
- [ ] Bridge daemon logs show mentu commands being executed

---

## Verification Commands

```bash
# On VPS after fix is deployed

# 1. Check daemon logs show Mentu env vars being set
ssh mentu@208.167.255.71 'tail -100 /home/mentu/logs/mentu-bridge.log | grep MENTU'

# 2. Submit a test bug and watch commitment state
# Before: cmt_xxx state = 'open'
# During: cmt_xxx state = 'claimed' (after Claude runs mentu claim)
# After: cmt_xxx state = 'closed' (after Claude runs mentu close)

# Query Supabase directly
SELECT id, state, claimed_by, closed_at FROM commitments WHERE id = 'cmt_xxx';
```

---

## References

- `PRD-TerminalBasedBugExecutor-v1.0`: Previous executor design
- `mentu-ai/CLAUDE.md`: Mentu CLI environment variables documentation
- `mentu-proxy/src/routes/ops.ts`: API endpoints for capture/claim/close

---

*The ledger is truth. The bridge executes. Claude owns the commitment lifecycle.*
