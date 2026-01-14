---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: PROMPT-BugExecutorLedgerParity-v1.0
path: docs/PROMPT-BugExecutorLedgerParity-v1.0.md
type: prompt
intent: execute

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

actor: (from manifest)

parent: HANDOFF-BugExecutorLedgerParity-v1.0

mentu:
  commitment: cmt_fc576be2
  status: pending
---

# Executable Prompt: BugExecutorLedgerParity v1.0

## Launch Commands

### Execute on VPS (Recommended)

Run directly on VPS where mentu-bridge is deployed:

```bash
ssh mentu@208.167.255.71 'cd /home/mentu/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 50 \
  "Read docs/HANDOFF-BugExecutorLedgerParity-v1.0.md and execute. Your actor is agent:claude-bridge (executor role). Fix the bug executor to pass MENTU_* env vars so Claude can claim/capture/close commitments via the ledger API."'
```

### Execute Locally (Alternative)

If SyncThing keeps files in sync, run locally:

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

claude \
  --dangerously-skip-permissions \
  --max-turns 50 \
  "Read docs/HANDOFF-BugExecutorLedgerParity-v1.0.md and execute. Your actor is agent:claude-bridge (executor role). Fix the bug executor to pass MENTU_* env vars so Claude can claim/capture/close commitments via the ledger API."
```

---

## Minimal Prompt

```bash
claude \
  --dangerously-skip-permissions \
  --max-turns 50 \
  "Read docs/HANDOFF-BugExecutorLedgerParity-v1.0.md and execute as executor."
```

---

## What This Prompt Delivers

| Deliverable | Description |
|-------------|-------------|
| `src/bug-executor.ts` | Updated with MENTU_* env vars in spawnTerminalExecutor |
| `src/bug-executor.ts` | New buildExecutorPrompt method with API instructions |
| `dist/bug-executor.js` | Compiled JavaScript for daemon |

---

## Expected Duration

- **Turns**: 20-40
- **Complexity**: T2 (single file modification)
- **Commitments**: 1

---

## Verification After Completion

```bash
# Verify TypeScript compiles
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
npm run build

# Verify the changes exist
grep -n "MENTU_API_URL\|MENTU_PROXY_TOKEN" src/bug-executor.ts

# Verify the buildExecutorPrompt method exists
grep -n "buildExecutorPrompt" src/bug-executor.ts

# On VPS: Restart daemon and check logs
ssh mentu@208.167.255.71 'systemctl --user restart mentu-bridge && sleep 3 && tail -20 /home/mentu/logs/mentu-bridge.log'

# Verify commitment state after test
mentu show cmt_XXXXXXXX
```

---

## Post-Execution: Test the Fix

After the code is deployed, test with a real bug:

1. **Submit a bug from WarrantyOS** (or use an existing pending one)

2. **Watch the daemon logs**:
   ```bash
   ssh mentu@208.167.255.71 'tail -f /home/mentu/logs/mentu-bridge.log'
   ```

3. **Verify commitment state changes**:
   ```sql
   -- In Supabase
   SELECT id, state, claimed_by, closed_at
   FROM commitments
   WHERE id = 'cmt_xxx';
   ```

4. **Expected state flow**:
   - Before: `state = 'open'`
   - After Claude claims: `state = 'claimed'`
   - After Claude closes: `state = 'closed'`

---

*Fix the bridge. Pass the config. Let the ledger be truth.*
