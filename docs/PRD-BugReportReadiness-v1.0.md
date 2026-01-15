---
id: PRD-BugReportReadiness-v1.0
path: docs/PRD-BugReportReadiness-v1.0.md
type: prd
intent: reference
version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14
tier: T2
children:
  - HANDOFF-BugReportReadiness-v1.0
dependencies:
  - HANDOFF-SimpleBugSpawn-v1.0
  - BUG-FIX-PROTOCOL-TEMPLATE
mentu:
  commitment: cmt_e408fec6
  status: pending
---

# PRD: BugReportReadiness v1.0

## Mission

Audit and configure the inline-substitute repository so WarrantyOS bug reports can be automatically dispatched to SimpleBugExecutor for resolution.

---

## Problem Statement

### Current State

```
WarrantyOS Bug Report → mentu-proxy → ??? → inline-substitute
                                       ↑
                              Not configured!
```

The inline-substitute repository may be missing:
- `genesis.key` with execution configuration
- `BUG-FIX-PROTOCOL.md` for Claude to read
- Proxy routing configuration in workspace settings
- Proper directory paths for Mac/VPS dispatch

### Desired State

```
WarrantyOS Bug Report → mentu-proxy → Supabase commitment
                                              ↓
                        SimpleBugExecutor polls (queries ledger)
                                              ↓
                        Spawns Claude in inline-substitute/
                                              ↓
                        Claude reads BUG-FIX-PROTOCOL.md
                                              ↓
                        Fix → Commit → Close commitment
```

---

## Completion Contract

**Path**: `.mentu/feature_lists/cmt_e408fec6.json`

```json
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-BugReportReadiness-v1.0",
  "created": "2026-01-14T00:00:00Z",
  "status": "in_progress",
  "tier": "T2",
  "mentu": {
    "commitment": "cmt_e408fec6",
    "source": "mem_18e975a6"
  },
  "features": [
    {
      "id": "F001",
      "description": "inline-substitute has .mentu/genesis.key with identity.paths (local + vps)",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "inline-substitute has BUG-FIX-PROTOCOL.md customized for the project",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "Workspace settings in Supabase have bug_reports.sources.warrantyos configured",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "SimpleBugExecutor environment variables documented (MENTU_COMMITMENT, etc.)",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F005",
      "description": "End-to-end test: mock bug report → commitment created → executor claims",
      "passes": false,
      "evidence": null
    }
  ],
  "checks": {
    "tsc": false,
    "build": false,
    "test": false
  }
}
```

---

## Core Concepts

### genesis.key

The constitutional governance file for a repository. Contains:
- `identity.paths.local` - Mac path (e.g., `/Users/rashid/Desktop/Workspaces/projects/inline-substitute`)
- `identity.paths.vps` - VPS path (e.g., `/home/mentu/Workspaces/projects/inline-substitute`)
- `identity.machines` - Which machines can execute in this repo

### BUG-FIX-PROTOCOL.md

The protocol file Claude reads when fixing bugs. Contains:
- Tech stack (React, TypeScript, Supabase, etc.)
- Codebase structure
- Investigation steps
- Fix guidelines
- Verification commands
- Mentu protocol (capture, close)

### Workspace Settings

Supabase `workspaces` table contains settings for bug report routing:
```json
{
  "bug_reports": {
    "sources": {
      "warrantyos": {
        "working_directory": "/Users/rashid/...",
        "vps_directory": "/home/mentu/...",
        "target_machine_id": "macbook-rashid"
      }
    }
  }
}
```

---

## Specification

### Files to Create/Verify

| File | Location | Purpose |
|------|----------|---------|
| `genesis.key` | `inline-substitute/.mentu/genesis.key` | Execution paths and machine affinity |
| `BUG-FIX-PROTOCOL.md` | `inline-substitute/BUG-FIX-PROTOCOL.md` | Claude's bug fix instructions |
| `manifest.yaml` | `inline-substitute/.mentu/manifest.yaml` | Repository identity |

### Proxy Routing

The proxy already handles path resolution. Verify:
1. `workspaces.settings.bug_reports.sources.warrantyos` exists in Supabase
2. `working_directory` points to Mac path
3. `vps_directory` points to VPS path
4. `target_machine_id` matches SimpleBugExecutor's machine ID

### Environment Variables

SimpleBugExecutor sets these when spawning Claude:
- `MENTU_COMMITMENT` - The commitment ID being fixed
- `MENTU_BRIDGE_COMMAND_ID` - The bridge command ID
- `MENTU_API_URL` - Proxy URL for mentu commands
- `MENTU_PROXY_TOKEN` - Auth token for proxy
- `MENTU_ACTOR` - Actor identity (agent:claude-vps)

---

## Implementation

### Deliverables

| File | Purpose |
|------|---------|
| `inline-substitute/.mentu/genesis.key` | Execution configuration |
| `inline-substitute/BUG-FIX-PROTOCOL.md` | Bug fix protocol for Claude |
| Supabase workspace settings update | Proxy routing configuration |

### Build Order

1. **Audit inline-substitute**: Check existing .mentu folder, genesis.key, manifest.yaml
2. **Create/Update genesis.key**: Add identity.paths for Mac/VPS
3. **Create BUG-FIX-PROTOCOL.md**: Customize from template
4. **Verify/Update Supabase settings**: Ensure workspace has bug_reports.sources.warrantyos
5. **Test dispatch**: Create mock bug report, verify commitment creation and executor claim

---

## Constraints

- DO NOT modify inline-substitute application code
- DO NOT break existing .mentu structure if present
- DO NOT hardcode paths - use genesis.key pattern
- Workspace settings must use correct machine IDs

---

## Success Criteria

### Configuration
- [ ] genesis.key exists with identity.paths.local and identity.paths.vps
- [ ] BUG-FIX-PROTOCOL.md exists and is project-specific
- [ ] manifest.yaml exists with actor identity

### Routing
- [ ] Supabase workspace settings have bug_reports.sources.warrantyos
- [ ] working_directory and vps_directory are correct
- [ ] target_machine_id matches executor

### Integration
- [ ] SimpleBugExecutor can find inline-substitute in allowed_directories
- [ ] Claude can read BUG-FIX-PROTOCOL.md from working directory
- [ ] Environment variables are documented

---

## Verification Commands

```bash
# Verify genesis.key exists
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/.mentu/genesis.key

# Verify BUG-FIX-PROTOCOL.md exists
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/BUG-FIX-PROTOCOL.md

# Verify workspace settings (via Supabase)
# Query workspaces table for settings.bug_reports

# Verify SimpleBugExecutor config
cat ~/.mentu/bridge.yaml
```

---

## References

- `docs/BUG-FIX-PROTOCOL-TEMPLATE.md`: Template for BUG-FIX-PROTOCOL.md
- `docs/HANDOFF-SimpleBugSpawn-v1.0.md`: SimpleBugExecutor implementation details
- `docs/INTENT-SimpleBugSpawnv2-Architecture.md`: v2.0 architecture direction

---

*This PRD ensures inline-substitute is ready to receive and process WarrantyOS bug reports through the Mentu ecosystem.*
