# INSTRUCTION: Architecture Completion for mentu-bridge

**Mode:** Executor
**Author:** agent:claude-auditor
**Date:** 2026-01-03
**Audited PRD:** PRD-architecture-completion.md

---

## Audit Summary

✅ **APPROVED** - PRD requirements validated against:
- `/Users/rashid/Desktop/Workspaces/mentu-ai/.mentu/genesis.key` (canonical schema)
- `/Users/rashid/Desktop/Workspaces/claude-code/.mentu/genesis.key` (recent example)
- `/Users/rashid/Desktop/Workspaces/claude-code/.mentu/config.yaml` (config pattern)
- `.mentu/manifest.yaml` (actor identity: `agent:bridge-daemon`)

### Validated Requirements

| Requirement | Validation | Status |
|-------------|------------|--------|
| Actor: `agent:bridge-daemon` | Matches manifest.yaml line 120 | ✅ |
| Operations: capture, commit, claim, close, annotate | Bridge executes commitments—needs full lifecycle | ✅ |
| Trust gradient enabled | Canonical schema requires this | ✅ |
| config.yaml with env vars | Pattern matches claude-code example | ✅ |

### Audit Modifications

1. **Added `release` operation** — Bridge must release claims if execution fails
2. **Added `submit` operation** — Consistency with executor role in trust gradient
3. **Added execution-specific memory kinds** — `execution-start`, `execution-progress`, `result-document`

---

## File 1: genesis.key

**Location:** `.mentu/genesis.key`

```yaml
genesis:
  version: "1.0"
  created: "2026-01-03T00:00:00Z"

identity:
  workspace: "mentu-bridge"
  owner: "Rashid Azarang"
  name: "Mentu Bridge Daemon"
  description: "Local execution daemon for Mentu commitments"

constitution:
  principles:
    - id: "evidence-required"
      statement: "Commitments close with proof, not assertion"
    - id: "lineage-preserved"
      statement: "Every commitment traces to its origin"
    - id: "append-only"
      statement: "Nothing edited, nothing deleted"

permissions:
  actors:
    # Owners - full access
    "Rashid Azarang":
      role: "owner"
      author_types: [architect, auditor, executor]
      operations: [capture, commit, claim, release, close, annotate, submit, approve, reopen, publish]
    "rashid.azarang.e@gmail.com":
      role: "owner"
      author_types: [architect, auditor, executor]
      operations: [capture, commit, claim, release, close, annotate, submit, approve, reopen, publish]

    # Primary actor for this repository - the bridge daemon itself
    "agent:bridge-daemon":
      role: "executor"
      author_types: [executor]
      operations: [capture, commit, claim, release, close, annotate, submit]
      description: "Bridge daemon - claims commitments, executes agents, closes with evidence"

    # Trust Gradient Agents (inherited from ecosystem)
    "agent:claude-architect":
      role: "architect"
      author_type: architect
      operations: [capture, annotate]
      description: "Remote agent producing strategic intent only"
    "agent:claude-auditor":
      role: "auditor"
      author_types: [auditor, executor]
      operations: [capture, commit, claim, release, close, annotate, submit]
      description: "Leading agent that audits and validates intents"
    "agent:claude-executor":
      role: "executor"
      author_type: executor
      operations: [capture, commit, claim, release, close, annotate, submit]
      description: "Agent that implements audited instructions"

    # Services
    "system":
      role: "system"
      operations: [approve]

  defaults:
    authenticated:
      operations: [capture, annotate]

trust_gradient:
  enabled: true

  author_types:
    architect:
      trust_level: untrusted
      allowed_operations: [capture, annotate]
      allowed_kinds:
        - architect-intent
        - strategic-intent
        - clarification
      constraints:
        no_file_paths: true
        no_code_snippets: true
        no_implementation_details: true

    auditor:
      trust_level: trusted
      allowed_operations: [capture, annotate, commit, claim, release, close]
      allowed_kinds:
        - audit-evidence
        - audit-approval
        - audit-rejection
        - audit-modification
        - validated-instruction
        - checkpoint
      can_approve_intents: true
      can_reject_intents: true
      can_transform_to_craft: true

    executor:
      trust_level: authorized
      allowed_operations: [capture, commit, claim, release, close, annotate, submit]
      allowed_kinds:
        - execution-progress
        - result-document
        - implementation-evidence
        - execution-start
        - task
        - evidence
      requires_audit: true
      scope_bounded: true

  constraints:
    - match: { author_type: architect }
      deny: [close, approve, submit, commit]
    - match: { author_type: executor }
      recommend_provenance: true

constraints:
  require_claim:
    - match: all

federation:
  enabled: false

lineage:
  parent: null
  amendments: []
```

---

## File 2: config.yaml

**Location:** `.mentu/config.yaml`

```yaml
# Configuration for mentu-bridge repository
# Environment-specific settings - NO SECRETS

api:
  # Reference environment variables, do not hardcode
  proxy_url: ${MENTU_API_URL}
  workspace_id: ${MENTU_WORKSPACE_ID}

actor:
  default: agent:bridge-daemon

cloud:
  enabled: true
  endpoint: ${MENTU_API_URL}
  workspace_id: ${MENTU_WORKSPACE_ID}

# Bridge-specific: Supabase realtime for command subscription
realtime:
  enabled: true
  channel: bridge_commands

integrations:
  # Bridge is an executor, not an ingestion point
  github:
    enabled: false
  notion:
    enabled: false
```

---

## Execution Checklist

The executor MUST complete these steps in order:

- [ ] **Step 1:** Verify `.mentu/` directory exists
- [ ] **Step 2:** Create `.mentu/genesis.key` with exact content above
- [ ] **Step 3:** Create `.mentu/config.yaml` with exact content above
- [ ] **Step 4:** Verify files were created correctly:
  ```bash
  cat .mentu/genesis.key | head -20
  cat .mentu/config.yaml
  ```
- [ ] **Step 5:** Capture completion as evidence:
  ```bash
  mentu capture "Created genesis.key and config.yaml for mentu-bridge" --kind evidence
  ```

---

## Scope Boundaries

The executor is ONLY authorized to:
1. Create the two files specified above
2. Verify file contents
3. Capture completion evidence

The executor is NOT authorized to:
- Modify any existing files
- Delete any files
- Modify manifest.yaml or ledger.jsonl
- Change any source code

---

*Audited and validated. Ready for execution.*
