---
description: "Receive strategic intent from a remote Architect agent, audit it, and execute via /craft"
argument-hint: "intent-document-path"
allowed-tools:
  - Read
  - Write
  - Edit
  - Glob
  - Grep
  - Bash
  - Task
  - TodoWrite
---

# Architect Mode Protocol

Receive and process strategic intent from a remote Architect agent that lacks local filesystem access.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  THE ARCHITECT PATTERN                                                      │
│  ═══════════════════                                                        │
│                                                                             │
│  ARCHITECT AGENT (Remote)          LEADING AGENT (You, Local)               │
│  ───────────────────────           ──────────────────────────               │
│  • No filesystem access            • Full filesystem access                 │
│  • Strategic intent only           • Complete MCP tooling                   │
│  • What and Why                    • Audit, validate, implement             │
│  • No paths, schemas, code         • Context, lineage, capabilities         │
│                                                                             │
│  Flow:                                                                      │
│  INTENT ──────> Mentu-Bridge ──────> AUDIT ──────> /craft ──────> EXECUTE   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Workspaces Context

This command is part of the Mentu ecosystem. Templates and full documentation live in:
- **Templates**: `/Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/`
- **Full Guide**: `/Users/rashid/Desktop/Workspaces/claude-code/docs/skills/GUIDE-ArchitectMode.md`

---

## Phase 0: Establish Checkpoint (MANDATORY)

**Before any work begins, establish a recovery point:**

### Git Checkpoint

```bash
# Ensure clean state
git status

# Create checkpoint commit if there are changes
git add -A && git commit -m "checkpoint: before architect-intent processing"

# Record the checkpoint SHA
git rev-parse HEAD
```

### Claude Code Checkpoint

The act of reading this command creates an implicit checkpoint. Document it:

```bash
mentu capture "Checkpoint established for architect-intent processing" \
  --kind checkpoint \
  --actor agent:claude-lead
```

**Save this checkpoint reference. If the audit fails or implementation diverges, you can `/rewind` to this point.**

---

## Phase 1: Parse the Intent Document

Read the INTENT document at: `$ARGUMENTS`

### Expected INTENT Structure

See template: `/Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/TEMPLATE-Intent.md`

```yaml
---
id: INTENT-{Name}-v{X.Y}
type: intent
origin: architect
architect:
  actor: agent:claude-architect
  context: {where this intent originated}
---

# Strategic Intent: {Name}

## What
{WHAT needs to be built - no code, no paths}

## Why
{Business/technical rationale}

## Constraints
{Boundaries and guardrails}

## Expected Outcome
{What success looks like}
```

---

## Phase 2: Audit Protocol

**You are the gatekeeper. Not every intent should become a commitment.**

### 2.1 Philosophy Alignment

```bash
# Read the project's foundational documents
cat CLAUDE.md
cat .mentu/genesis.key 2>/dev/null || echo "No genesis key"
cat .mentu/manifest.yaml
```

**Questions to answer:**
- Does this intent align with the project's stated purpose?
- Does it respect the governance model (genesis.key)?
- Would the project maintainers approve this direction?

### 2.2 Technical Feasibility

Use Task tool with `subagent_type="Explore"` to investigate:
- Can the existing architecture support this intent?
- What components would be affected?
- Are there existing patterns to follow or extend?
- What dependencies or constraints exist?

### 2.3 Risk Assessment

| Risk Category | Evaluation |
|---------------|------------|
| **Scope Creep** | Is the intent bounded? Can it expand indefinitely? |
| **Breaking Changes** | Will this break existing functionality or APIs? |
| **Security** | Does this introduce attack surfaces or vulnerabilities? |
| **Technical Debt** | Will this create debt that must be repaid later? |
| **Reversibility** | Can we undo this if it goes wrong? |

### 2.4 Effort Estimation (Tier)

| Tier | Description |
|------|-------------|
| T1 | Simple change, single file |
| T2 | Feature, multiple files |
| T3 | Multi-part, cross-cutting |
| T4 | Orchestrated, multi-agent |

---

## Phase 3: Capture Audit Evidence

```bash
mentu capture "Audit of INTENT-{Name}: {summary of findings}" \
  --kind audit \
  --actor agent:claude-lead
```

### Audit Document (Create if T2+)

See template: `/Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/TEMPLATE-Audit.md`

Create: `docs/AUDIT-{Name}-v{X.Y}.md`

---

## Phase 4: Decision Gate

### If APPROVE

```bash
mentu capture "Approved INTENT-{Name} for implementation" \
  --kind approval \
  --actor agent:claude-lead

mentu commit "Implement {Name} as specified in INTENT" \
  --source mem_XXXXXXXX \
  --actor agent:claude-lead

mentu claim cmt_XXXXXXXX --actor agent:claude-lead
```

**Then execute the full craft chain:**

```
/craft {Name}-v{X.Y}
```

### If REJECT

```bash
mentu capture "Rejected INTENT-{Name}: {reason}" \
  --kind rejection \
  --actor agent:claude-lead
```

Create rejection notice: `docs/REJECTED-INTENT-{Name}.md`

### If REQUEST_CLARIFICATION

```bash
mentu capture "Clarification needed for INTENT-{Name}" \
  --kind clarification-request \
  --actor agent:claude-lead
```

Create clarification request: `docs/CLARIFY-INTENT-{Name}.md`

---

## Checklist

- [ ] Checkpoint established (git + Claude Code)
- [ ] Intent document parsed and validated
- [ ] Philosophy alignment assessed
- [ ] Technical feasibility explored
- [ ] Risk assessment completed
- [ ] Audit evidence captured
- [ ] Verdict rendered (APPROVE/REJECT/REQUEST_CLARIFICATION)
- [ ] Appropriate action taken

---

## Arguments

Provide the path to the INTENT document (e.g., `docs/INTENT-FeatureName-v1.0.md`).

---

*Universal command - available across all Mentu ecosystem repositories.*
