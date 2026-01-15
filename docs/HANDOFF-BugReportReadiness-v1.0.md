---
id: HANDOFF-BugReportReadiness-v1.0
path: docs/HANDOFF-BugReportReadiness-v1.0.md
type: handoff
intent: execute
version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14
tier: T2
author_type: executor
parent: PRD-BugReportReadiness-v1.0
children:
  - PROMPT-BugReportReadiness-v1.0
mentu:
  commitment: cmt_e408fec6
  status: pending
validation:
  required: true
  tier: T2
---

# HANDOFF: BugReportReadiness v1.0

## For the Coding Agent

Audit and configure inline-substitute repo for WarrantyOS bug report pipeline.

**Read the full PRD**: `docs/PRD-BugReportReadiness-v1.0.md`

---

## Your Identity

| Dimension | Source | Value |
|-----------|--------|-------|
| **Actor** | Repository manifest | agent:bridge-daemon |
| **Author Type** | This HANDOFF | executor |
| **Context** | Working directory | mentu-bridge (orchestrating inline-substitute) |

**Your domain**: technical

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
      "description": "Workspace settings in Supabase have bug_reports.sources configured",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "SimpleBugExecutor allowed_directories includes inline-substitute path",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F005",
      "description": "Documentation: environment variables Claude receives",
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

## Key Paths

```bash
# inline-substitute location (Mac)
/Users/rashid/Desktop/Workspaces/projects/inline-substitute

# inline-substitute location (VPS)
/home/mentu/Workspaces/projects/inline-substitute

# Bridge config
~/.mentu/bridge.yaml

# Template to copy
/Users/rashid/Desktop/Workspaces/mentu-bridge/docs/BUG-FIX-PROTOCOL-TEMPLATE.md
```

---

## Build Order

### Stage 1: Audit inline-substitute

**Goal**: Understand current state of .mentu folder in inline-substitute.

```bash
# Check if .mentu exists
ls -la /Users/rashid/Desktop/Workspaces/projects/inline-substitute/.mentu/

# Check for genesis.key
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/.mentu/genesis.key 2>/dev/null || echo "NOT FOUND"

# Check for manifest.yaml
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/.mentu/manifest.yaml 2>/dev/null || echo "NOT FOUND"

# Check for BUG-FIX-PROTOCOL.md
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/BUG-FIX-PROTOCOL.md 2>/dev/null || echo "NOT FOUND"
```

**Output**: Document what exists vs what's missing.

---

### Stage 2: Create/Update genesis.key

**File**: `/Users/rashid/Desktop/Workspaces/projects/inline-substitute/.mentu/genesis.key`

If missing or incomplete, create:

```yaml
# Genesis Key - inline-substitute
# Constitutional governance for this repository

version: "1.0"
created: 2026-01-14

identity:
  name: inline-substitute
  description: Chrome extension for inline text substitution with Supabase sync

  paths:
    local: "/Users/rashid/Desktop/Workspaces/projects/inline-substitute"
    vps: "/home/mentu/Workspaces/projects/inline-substitute"

  machines:
    - id: "macbook-rashid"
      role: "development"
    - id: "vps-01"
      role: "executor"

permissions:
  actors:
    "agent:claude-vps":
      operations: [capture, annotate, close]
      contexts: [bug_fix]
    "agent:bridge-executor":
      operations: [capture, annotate, claim, close, submit]
      contexts: [bug_fix]

execution:
  bug_fix:
    enabled: true
    max_turns: 50
    timeout_seconds: 3600
    protocol_file: "BUG-FIX-PROTOCOL.md"
```

**Verification**:
```bash
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/.mentu/genesis.key
```

---

### Stage 3: Create BUG-FIX-PROTOCOL.md

**File**: `/Users/rashid/Desktop/Workspaces/projects/inline-substitute/BUG-FIX-PROTOCOL.md`

Copy from template and customize:

```bash
# Read the template
cat /Users/rashid/Desktop/Workspaces/mentu-bridge/docs/BUG-FIX-PROTOCOL-TEMPLATE.md
```

**Customizations needed**:

1. **Tech Stack**:
   - Framework: Chrome Extension (Manifest V3)
   - Language: TypeScript
   - Database: Supabase
   - Build Tool: Vite

2. **Codebase Structure**: Read the actual structure:
   ```bash
   ls -la /Users/rashid/Desktop/Workspaces/projects/inline-substitute/src/
   ```

3. **Verification Commands**: Adjust for the project's actual scripts:
   ```bash
   # Check package.json for available scripts
   cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/package.json | grep -A 20 '"scripts"'
   ```

**Verification**:
```bash
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/BUG-FIX-PROTOCOL.md
```

---

### Stage 4: Verify Supabase Workspace Settings

**Goal**: Ensure workspace settings have bug_reports.sources configured.

```bash
# Query Supabase for workspace settings
# Use the mcp__mentu__execute_sql tool

SELECT id, name, settings->'bug_reports' as bug_reports
FROM workspaces
WHERE settings->'bug_reports' IS NOT NULL;
```

**Expected structure**:
```json
{
  "bug_reports": {
    "sources": {
      "warrantyos": {
        "working_directory": "/Users/rashid/Desktop/Workspaces/projects/inline-substitute",
        "vps_directory": "/home/mentu/Workspaces/projects/inline-substitute",
        "target_machine_id": "macbook-rashid"
      }
    }
  }
}
```

If missing, document what needs to be added (but don't modify Supabase directly - flag for manual action).

---

### Stage 5: Verify SimpleBugExecutor Config

**File**: `~/.mentu/bridge.yaml`

```bash
cat ~/.mentu/bridge.yaml
```

**Check**:
- `execution.allowed_directories` includes the inline-substitute path
- Machine ID matches what's in genesis.key

If not configured, document what needs to be added.

---

### Stage 6: Document Environment Variables

Create/update documentation showing what Claude receives:

| Variable | Description | Example |
|----------|-------------|---------|
| `MENTU_COMMITMENT` | Commitment ID being fixed | `cmt_abc123` |
| `MENTU_BRIDGE_COMMAND_ID` | Bridge command ID | `uuid` |
| `MENTU_API_URL` | Proxy URL | `https://mentu-proxy.affihub.workers.dev` |
| `MENTU_PROXY_TOKEN` | Auth token | `(secret)` |
| `MENTU_ACTOR` | Actor identity | `agent:claude-vps` |

**Verify in SimpleBugExecutor code**:
```bash
grep -n "MENTU_" /Users/rashid/Desktop/Workspaces/mentu-bridge/src/simple-bug-executor.ts
```

---

## Completion Phase (REQUIRED)

**BEFORE calling `mentu submit`, you MUST:**

1. Create RESULT document at `docs/RESULT-BugReportReadiness-v1.0.md`
2. Capture RESULT as evidence:
   ```bash
   mentu capture "Created RESULT-BugReportReadiness: genesis.key + protocol + routing verified" \
     --kind result-document \
     --path docs/RESULT-BugReportReadiness-v1.0.md
   ```
3. Submit with evidence:
   ```bash
   mentu submit cmt_e408fec6 --summary "Configured inline-substitute for WarrantyOS bug reports" --include-files
   ```

---

## Verification Checklist

### Files
- [ ] `inline-substitute/.mentu/genesis.key` exists with paths
- [ ] `inline-substitute/BUG-FIX-PROTOCOL.md` exists and is customized
- [ ] `inline-substitute/.mentu/manifest.yaml` exists

### Configuration
- [ ] Supabase workspace settings have bug_reports.sources
- [ ] SimpleBugExecutor allowed_directories is correct
- [ ] Machine IDs are consistent

### Documentation
- [ ] Environment variables documented
- [ ] Any manual actions needed are flagged

### Mentu
- [ ] Commitment claimed
- [ ] RESULT document created
- [ ] Evidence captured
- [ ] Commitment submitted

---

*This HANDOFF prepares inline-substitute for automated bug fix dispatch from WarrantyOS.*
