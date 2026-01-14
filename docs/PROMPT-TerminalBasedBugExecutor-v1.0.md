---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: PROMPT-TerminalBasedBugExecutor-v1.0
path: docs/PROMPT-TerminalBasedBugExecutor-v1.0.md
type: prompt
intent: execute

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

actor: (from manifest)

parent: HANDOFF-TerminalBasedBugExecutor-v1.0

mentu:
  commitment: cmt_tbe_c06c29
  status: pending
---

# Executable Prompt: TerminalBasedBugExecutor v1.0

## Launch Commands

### Option A: Native Claude (NO mentu-enforcer)

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

claude \
  --dangerously-skip-permissions \
  --max-turns 100 \
  "
# IDENTITY
Your actor identity comes from the repository manifest (.mentu/manifest.yaml).
Your role (author_type) comes from the HANDOFF document you are executing.

# MISSION
Replace the headless JSON-prompt bug executor with terminal-based Claude spawning.
Bridge becomes infrastructure, Claude becomes actor.

# CONTRACT
Done when:
- src/context-writer.ts created
- src/bug-executor.ts modified with spawnTerminalExecutor
- npm run build passes
- Commitment submitted with evidence

# PROTOCOL
1. Read docs/HANDOFF-TerminalBasedBugExecutor-v1.0.md (complete instructions)
2. Claim commitment: mentu claim cmt_XXX
3. Create src/context-writer.ts
4. Modify src/bug-executor.ts
5. Run npm run build
6. Capture evidence: mentu capture 'Implemented terminal executor' --kind evidence
7. Submit: mentu submit cmt_XXX --summary 'Terminal executor implemented'

# CONSTRAINTS
- DO NOT change bridge_commands table schema
- DO NOT break non-bug execution paths
- Use command.working_directory directly (not workspace config)
- Bridge MUST NOT claim/close (Claude does this)

# CONTEXT
Read: docs/HANDOFF-TerminalBasedBugExecutor-v1.0.md
Reference: docs/PRD-TerminalBasedBugExecutor-v1.0.md
"
```

---

### Option B: With Mentu Enforcer (WRAPPER SCRIPT)

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

~/claude-code-app/run-claude.sh \
  --dangerously-skip-permissions \
  --max-turns 100 \
  --mentu-enforcer \
  "Read docs/HANDOFF-TerminalBasedBugExecutor-v1.0.md and execute."
```

> **IMPORTANT**: `--mentu-enforcer` is a CUSTOM FLAG that ONLY works with the wrapper script.

---

## Minimal Prompts

### Without Enforcer (native claude):

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

claude \
  --dangerously-skip-permissions \
  --max-turns 100 \
  "Read docs/HANDOFF-TerminalBasedBugExecutor-v1.0.md and execute."
```

### With Enforcer (wrapper script):

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

~/claude-code-app/run-claude.sh \
  --dangerously-skip-permissions \
  --max-turns 100 \
  --mentu-enforcer \
  "Read docs/HANDOFF-TerminalBasedBugExecutor-v1.0.md and execute."
```

---

## What This Prompt Delivers

| Deliverable | Description |
|-------------|-------------|
| `src/context-writer.ts` | Writes bug context file for Claude to read |
| `src/bug-executor.ts` (modified) | Terminal-based spawning, correct working directory |

---

## Expected Duration

- **Turns**: 30-60
- **Complexity**: T2 (feature)
- **Commitments**: 1

---

## Verification After Completion

```bash
# Verify files exist
ls -la src/context-writer.ts

# Verify build passes
npm run build

# Verify TypeScript
npx tsc --noEmit

# Verify commitment closed
mentu show cmt_XXX
```

---

*Bridge becomes infrastructure. Claude becomes actor.*
