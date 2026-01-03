---
description: "Create PRD → HANDOFF → PROMPT → RESULT document chain with Mentu commitments"
argument-hint: "FeatureName-vX.Y"
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

# Craft Command

Create a complete document chain (PRD → HANDOFF → PROMPT → RESULT) for a feature using the mentu-craft skill.

## Document Lifecycle

```
┌─────────────────────────────────────────────────────────────────────────┐
│  PLANNING PHASE (This command creates these)                           │
│  ───────────────────────────────────────────                            │
│  PRD → HANDOFF → PROMPT → Commitment Created                           │
│                                                                         │
│  EXECUTION PHASE (Agent reads HANDOFF and follows it)                   │
│  ─────────────────────────────────────────────────────                  │
│  Claim → Work → Validate → Create RESULT → Capture Evidence → Submit   │
│                                                                         │
│  ⚠️  RESULT creation is embedded in HANDOFF template, not separate.     │
│      The agent sees "Completion Phase (REQUIRED)" in their HANDOFF.    │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Workspaces Context

Templates and skills live in mentu-ai:
- **Templates**: `/Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/`
- **Skill**: `/Users/rashid/Desktop/Workspaces/mentu-ai/.claude/skills/mentu-craft/SKILL.md`

---

## SACRED RULE: Ledger-First Pattern

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ⚠️  THE LEDGER IS THE ONLY SOURCE OF TRUTH                            │
│                                                                         │
│  YAML front matter `mentu:` fields are WRITE-ONCE, then READ-ONLY.     │
│  NEVER manually edit the mentu: block after initial creation.          │
│  State changes happen through CLI commands, NOT document edits.        │
└─────────────────────────────────────────────────────────────────────────┘
```

### The Pattern

| Phase | Action | Document `mentu:` field |
|-------|--------|------------------------|
| CREATE | Write document | `commitment: pending`, `status: pending` |
| COMMIT | Run `mentu commit` | Update `commitment: cmt_xxx` (ONE TIME) |
| AFTER | Any CLI operation | **NEVER TOUCH** - query ledger instead |

### Querying State

```bash
# Get current state
mentu show cmt_xxx --json | jq -r '.state'

# Full status
mentu status
```

---

## Instructions

Create a full documentation chain for the feature: **$ARGUMENTS**

### Phase 1: PRD (Requirements)

1. Read template:
   ```bash
   cat /Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/TEMPLATE-PRD.md
   ```
2. Create `docs/PRD-$ARGUMENTS.md` with:
   ```yaml
   mentu:
     commitment: pending
     status: pending
   ```
3. Capture evidence: `mentu capture "Created PRD-{name}: {summary}" --kind document`

### Phase 2: HANDOFF (Build Instructions)

1. Read template:
   ```bash
   cat /Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/TEMPLATE-Handoff.md
   ```
2. Create `docs/HANDOFF-$ARGUMENTS.md` referencing the PRD
3. Include completion contract with `required_files`, `checks`
4. Set initial front matter with `status: pending`
5. Capture evidence: `mentu capture "Created HANDOFF-{name}: {summary}" --kind document`

### Phase 3: PROMPT (Agent Launch Command)

1. Read template:
   ```bash
   cat /Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/TEMPLATE-Prompt.md
   ```
2. Create `docs/PROMPT-$ARGUMENTS.md` with the exact command to launch the coding agent
3. Include reference to HANDOFF and mentu-enforcer flag
4. Capture evidence: `mentu capture "Created PROMPT-{name}: {summary}" --kind document`

### Phase 4: Commit to Mentu

1. Capture the specification:
   ```bash
   mentu capture "Feature specification complete for $ARGUMENTS" --kind specification
   ```

2. Create commitment:
   ```bash
   mentu commit "Implement $ARGUMENTS as specified in HANDOFF" --source mem_XXXXXXXX
   ```

3. **ONE-TIME UPDATE**: Update all three documents with the returned commitment ID:
   ```yaml
   mentu:
     commitment: cmt_XXXXXXXX  # ← Write this ONCE
     status: pending           # ← NEVER change manually after this
   ```

---

## Executing Agent Requirements

The HANDOFF template includes a **"Completion Phase (REQUIRED)"** section.

### What Agents Must Do

1. **Create RESULT document** with initial state
2. **Capture RESULT as evidence**: `mentu capture "Created RESULT-{name}" --kind document`
3. **ONE-TIME UPDATE** of evidence ID
4. **Submit through CLI**: `mentu submit cmt_XXXXXXXX --summary "..."`

### What Agents Must NEVER Do

```
❌ Edit mentu.status in YAML
❌ Edit mentu.evidence after initial write
❌ Edit mentu.commitment after initial write
❌ Trust document YAML for current state
```

---

## Front Matter Freeze Points

| Document | mentu.commitment | mentu.evidence | mentu.status |
|----------|------------------|----------------|--------------|
| PRD | Set once at Phase 4 | Optional | FROZEN at pending |
| HANDOFF | Set once at Phase 4 | Optional | FROZEN at pending |
| PROMPT | Set once at Phase 4 | Optional | FROZEN at pending |
| RESULT | Set at creation | Set once after capture | FROZEN at pending |

---

## Output

After creating planning documents (Phases 1-4), provide:

1. **Summary Table**: List of documents created with their evidence IDs
2. **Launch Command**:
   ```bash
   ~/run-claude.sh \
       --dangerously-skip-permissions \
       --max-turns 100 \
       --mentu-enforcer \
       "Read docs/HANDOFF-$ARGUMENTS.md and execute."
   ```
3. **Mentu State**: The commitment ID that tracks this work
4. **Completion Reminder**: Executing agent MUST create RESULT-$ARGUMENTS.md
5. **Ledger-First Reminder**: `mentu:` fields are frozen after creation

## Arguments

Provide the feature name in PascalCase with version (e.g., `UserAuth-v1.0`, `DataExport-v2.0`).

---

*Universal command - available across all Mentu ecosystem repositories.*
