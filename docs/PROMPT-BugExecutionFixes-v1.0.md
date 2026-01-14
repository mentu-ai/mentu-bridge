---
id: PROMPT-BugExecutionFixes-v1.0
path: docs/PROMPT-BugExecutionFixes-v1.0.md
type: prompt
intent: execute

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

actor: (from manifest)

parent: HANDOFF-BugExecutionFixes-v1.0

mentu:
  commitment: cmt_6ffc4ed3
  source: mem_51580b64
  status: pending
---

# Executable Prompt: BugExecutionFixes v1.0

## Launch Commands

### Option A: Native Claude (NO mentu-enforcer)

Use this when you do NOT need stop-time commitment enforcement:

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 50 \
  "
# IDENTITY
Your actor identity comes from the repository manifest (.mentu/manifest.yaml).
Your role (author_type) comes from the HANDOFF document you are executing.

Read .mentu/manifest.yaml to discover your actor.
Read the HANDOFF to discover your author_type (executor).

# COGNITIVE STANCE
Your domain is TECHNICAL (executor role).
- Technical failure → Own it. Fix it. Don't argue.
- Intent/safety failure → You drifted. Re-read HANDOFF.

# MISSION
Fix four critical bugs in bug-executor.ts: result storage, workspace resolution, stale cleanup, and auth tokens.

# CONTRACT
Done when:
- npm run build passes
- Result storage verified with .select() and logged
- resolveWorkspaceDirectory method added
- cleanupStaleCommands method added and called in start()
- RESULT document created
- Commitment submitted

# PROTOCOL
1. Read .mentu/manifest.yaml for actor identity
2. Read docs/HANDOFF-BugExecutionFixes-v1.0.md (full instructions)
3. Create feature_list.json with provided contract
4. Claim commitment: mentu claim cmt_6ffc4ed3 --author-type executor
5. Follow Build Order (4 stages)
6. Create RESULT document
7. Capture evidence: mentu capture 'RESULT created' --kind result-document
8. Submit: mentu submit cmt_6ffc4ed3 --summary 'Fixed bug execution workflow'

# CONSTRAINTS
- DO NOT change Auditor/Executor prompt structure
- DO NOT break spawn command functionality
- DO NOT expose service role key in logs

# RECOVERY
- If tsc fails: fix type errors before proceeding
- If build fails: check imports and exports
- If validation fails: fix without arguing

# CONTEXT
Read: docs/HANDOFF-BugExecutionFixes-v1.0.md
Reference: docs/PRD-BugExecutionFixes-v1.0.md
Existing code: src/bug-executor.ts

# EVIDENCE
Final message must include:
- All files modified
- Build status (npm run build)
- Commitment ID submitted
"
```

---

### Option B: With Mentu Enforcer (WRAPPER SCRIPT)

Use this when you NEED stop-time commitment enforcement:

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && ~/claude-code-app/run-claude.sh \
  --dangerously-skip-permissions \
  --max-turns 50 \
  --mentu-enforcer \
  "Read .mentu/manifest.yaml for your actor, then read docs/HANDOFF-BugExecutionFixes-v1.0.md and execute."
```

> **IMPORTANT**: `--mentu-enforcer` is a CUSTOM FLAG that ONLY works with the wrapper script.

---

## Minimal Prompts

### Without Enforcer (native claude):

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 50 \
  "Read .mentu/manifest.yaml for your actor identity, then read docs/HANDOFF-BugExecutionFixes-v1.0.md and execute as executor."
```

### With Enforcer (wrapper script):

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && ~/claude-code-app/run-claude.sh \
  --dangerously-skip-permissions \
  --max-turns 50 \
  --mentu-enforcer \
  "Read .mentu/manifest.yaml for your actor identity, then read docs/HANDOFF-BugExecutionFixes-v1.0.md and execute as executor."
```

---

## What This Prompt Delivers

| Deliverable | Description |
|-------------|-------------|
| Fixed `bug-executor.ts` | Result storage, workspace resolution, stale cleanup |
| `RESULT-BugExecutionFixes-v1.0.md` | Completion documentation |

---

## Expected Duration

- **Turns**: 20-40
- **Complexity**: T2 (Feature)
- **Commitments**: 1

---

## Verification After Completion

```bash
# Verify build passes
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && npm run build

# Verify changes
grep -n "Result stored\|resolveWorkspaceDirectory\|cleanupStaleCommands" src/bug-executor.ts

# Verify RESULT document
cat docs/RESULT-BugExecutionFixes-v1.0.md

# Verify commitment
mentu show cmt_6ffc4ed3
```

---

*Fix it right. Ship it fast.*
