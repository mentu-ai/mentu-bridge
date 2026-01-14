---
id: PROMPT-VPSConnectivityFix-v1.0
path: docs/PROMPT-VPSConnectivityFix-v1.0.md
type: prompt
intent: execute

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T1

parent: HANDOFF-VPSConnectivityFix-v1.0

mentu:
  commitment: cmt_bugfixer01
  source: mem_bugfixer01
  status: pending
---

# Executable Prompt: VPSConnectivityFix v1.0

## Launch Command

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 30 \
  "
# MISSION
Fix two VPS bridge issues:
1. Realtime subscriptions timeout every ~10 seconds (constant reconnect loop)
2. Scheduler 401 error: Failed to fetch commitments: 401

# PROTOCOL
1. Read docs/HANDOFF-VPSConnectivityFix-v1.0.md
2. Find Supabase client initialization in src/daemon.ts
3. Add realtime options: heartbeatIntervalMs, reconnectAfterMs
4. Find scheduler code and fix 401 auth issue
5. npm run build
6. Deploy: ssh mentu@208.167.255.71 'sudo systemctl restart mentu-bridge'
7. Verify: ssh mentu@208.167.255.71 'sleep 30 && tail -100 /home/mentu/logs/bridge.log'

# SUCCESS CRITERIA
- No TIMED_OUT loop in logs
- No 401 errors from Scheduler
- Bridge stays connected 5+ minutes

# CONSTRAINTS
- DO NOT change BugExecutor code
- DO NOT change command execution logic
"
```

---

## Minimal Prompt

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 30 \
  "Read docs/HANDOFF-VPSConnectivityFix-v1.0.md and fix VPS connectivity issues. Build and deploy to VPS."
```

---

## Expected Duration

- **Turns**: 15-30
- **Complexity**: T1 (Configuration fix)

---

## Verification

```bash
# Check stable connection (no timeout loop)
ssh mentu@208.167.255.71 'tail -100 /home/mentu/logs/bridge.log | grep -c TIMED_OUT'
# Should be 0 or very low

# Check no 401 errors
ssh mentu@208.167.255.71 'tail -100 /home/mentu/logs/bridge.log | grep -c "401"'
# Should be 0
```

---

*Fix connectivity. Enable the pipeline.*
