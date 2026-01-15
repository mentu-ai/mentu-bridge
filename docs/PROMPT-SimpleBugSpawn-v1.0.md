---
id: PROMPT-SimpleBugSpawn-v1.0
path: docs/PROMPT-SimpleBugSpawn-v1.0.md
type: prompt
intent: execute
version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14
tier: T2
actor: (from manifest)
parent: HANDOFF-SimpleBugSpawn-v1.0
mentu:
  commitment: cmt_80f13e82
  status: pending
---

# Executable Prompt: SimpleBugSpawn v1.0

## Launch Commands

### Option A: VPS Execution (Recommended)

```bash
ssh mentu@208.167.255.71 'cd /home/mentu/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 100 \
  "Read docs/HANDOFF-SimpleBugSpawn-v1.0.md and execute. You are refactoring SimpleBugExecutor to use CLI argument spawn instead of stdin piping."'
```

### Option B: Local Mac Execution

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 100 \
  "Read docs/HANDOFF-SimpleBugSpawn-v1.0.md and execute. You are refactoring SimpleBugExecutor to use CLI argument spawn instead of stdin piping."
```

---

## Minimal Prompt

For quick execution with full context in HANDOFF:

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 100 \
  "Read docs/HANDOFF-SimpleBugSpawn-v1.0.md and execute."
```

---

## What This Prompt Delivers

| Deliverable | Description |
|-------------|-------------|
| `src/simple-bug-executor.ts` | Refactored with CLI arg spawn |
| `docs/BUG-FIX-PROTOCOL-TEMPLATE.md` | Template for repos to copy |

---

## Expected Duration

- **Turns**: 30-60
- **Complexity**: T2 (Feature refactor)
- **Commitments**: 1

---

## Verification After Completion

```bash
# Verify build passes
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && npm run build

# Verify protocol template exists
ls docs/BUG-FIX-PROTOCOL-TEMPLATE.md

# Check spawn pattern in code
grep -n "CLI arg" src/simple-bug-executor.ts

# Check max turns default
grep -n "maxTurns" src/simple-bug-executor.ts

# Verify commitment closed
mentu show cmt_XXXXXXXX
```

---

## VPS Log Monitoring

While the executor runs, monitor progress:

```bash
# Watch bridge logs for spawn activity
ssh mentu@208.167.255.71 'tail -f /home/mentu/logs/bridge.log | grep -i "spawn\|claude\|bug"'
```

---

*This prompt launches an executor to refactor bug execution spawning to use CLI arguments.*
