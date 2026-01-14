---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: PROMPT-BugExecutionLoop-v1.0
path: docs/PROMPT-BugExecutionLoop-v1.0.md
type: prompt
intent: execute

version: "1.1"
created: 2026-01-11
last_updated: 2026-01-11

tier: T2
actor: (from manifest)

parent: HANDOFF-BugExecutionLoop-v1.0

mentu:
  commitment: cmt_6c8e6d56
  status: pending

vps:
  target: true
  host: 208.167.255.71
  user: mentu
  path: /home/mentu/Workspaces/mentu-bridge
---

# Executable Prompt: Bug Execution Loop v1.1 (Beacon-Parity)

## VPS Execution (Primary)

This implementation is designed for VPS deployment at `208.167.255.71`. Execute directly on VPS via SSH.

### Environment Setup (VPS)

```bash
# SSH to VPS
ssh mentu@208.167.255.71

# Navigate to workspace
cd /home/mentu/Workspaces/mentu-bridge

# Verify environment variables
cat /home/mentu/.mentu.env
# Required:
#   SUPABASE_URL
#   SUPABASE_SERVICE_KEY
#   MENTU_WORKSPACE_ID
#   MENTU_MACHINE_ID
#   CLAUDE_CODE_OAUTH_TOKEN
```

### Option A: VPS Direct Execution (RECOMMENDED)

Execute on VPS with full beacon-parity implementation:

```bash
ssh mentu@208.167.255.71 'cd /home/mentu/Workspaces/mentu-bridge && claude \
  --dangerously-skip-permissions \
  --max-turns 100 \
  "
# IDENTITY
Your actor identity comes from the repository manifest (.mentu/manifest.yaml).
Your role (author_type) comes from the HANDOFF document you are executing.

Read .mentu/manifest.yaml to discover your actor.
Read the HANDOFF to discover your author_type (executor/auditor/architect).

# COGNITIVE STANCE
Your domain depends on your author_type:
- executor: TECHNICAL domain. Fix technical failures, defer on intent/safety.
- auditor: SAFETY domain. Fix safety failures, defer on technical/intent.
- architect: INTENT domain. Fix intent failures, defer on technical/safety.

The Rule: Failure in YOUR domain → own and fix. Failure elsewhere → you drifted.

# MISSION
Build a beacon-parity BugExecutor system in mentu-bridge with:
- WebSocket Realtime Subscription (instant notification, not polling)
- Atomic Claiming (UPDATE...WHERE status=pending)
- Genesis Enforcement (pre-execution validation)
- Worktree Isolation (parallel execution safety)
- Output Streaming (100ms real-time logs)

Target: VPS deployment at 208.167.255.71 as systemd service.

# CONTRACT
Done when:
- completion.json checks pass (tsc, build)
- src/realtime-subscriber.ts exists
- src/genesis-enforcer.ts exists
- src/worktree-manager.ts exists
- src/output-streamer.ts exists
- src/bug-executor.ts exists with full BugExecutor class
- src/daemon.ts wires BugExecutor into startup
- systemd service configuration created
- Commitment submitted with RESULT document as evidence

# PROTOCOL
1. Read .mentu/manifest.yaml to discover your actor identity
2. Read /home/mentu/Workspaces/mentu-bridge/docs/HANDOFF-BugExecutionLoop-v1.0.md
3. Update .claude/completion.json with provided contract
4. Check commitment status - if already claimed, proceed. If not:
   mentu claim cmt_6c8e6d56 --author-type executor
5. Add commitment ID to completion.json mentu.commitments.ids
6. Follow Build Order in HANDOFF (7 stages)
7. Capture evidence:
   mentu capture 'BugExecutor beacon-parity implemented' --kind execution-progress --author-type executor
8. On completion: mentu submit cmt_6c8e6d56 --summary 'Beacon-parity BugExecutor for VPS' --include-files

# IDENTITY MODEL
- Actor: auto-resolved from .mentu/manifest.yaml (WHO)
- Author Type: from HANDOFF author_type field (ROLE)
- Context: added to operations via meta.context (WHERE)

# CONSTRAINTS
- DO NOT modify ledger schema or create new Supabase tables
- DO NOT change mentu-proxy authentication
- DO use existing bridge_commands table for state
- DO use WebSocket realtime (not polling)
- DO implement atomic claiming (UPDATE...WHERE)
- DO enforce genesis rules before execution
- DO isolate executions in git worktrees
- DO stream output to spawn_logs table
- DO follow existing patterns in daemon.ts

# RECOVERY
- If tsc fails: fix type errors before proceeding
- If build fails: check imports and exports
- If mentu commands fail: verify .mentu/ exists
- If validation fails: check stance (mentu stance executor --failure technical), fix, dont argue
- If WebSocket fails: check SUPABASE_URL and SERVICE_KEY
- If worktree fails: check git status and permissions

# CONTEXT
Read: /home/mentu/Workspaces/mentu-bridge/docs/HANDOFF-BugExecutionLoop-v1.0.md (build instructions)
Reference: /home/mentu/Workspaces/mentu-bridge/docs/PRD-BugExecutionLoop-v1.0.md (full specification)
Reference: /home/mentu/Workspaces/mentu-bridge/src/daemon.ts (daemon integration)

# EVIDENCE
Final message must include:
- All 6 files created/modified
- Build status (npm run build)
- systemd service configuration
- Commitment ID submitted
"'
```

### Option B: VPS with Mentu Enforcer

```bash
ssh mentu@208.167.255.71 'cd /home/mentu/Workspaces/mentu-bridge && \
  ~/claude-code-app/run-claude.sh \
  --dangerously-skip-permissions \
  --max-turns 100 \
  --mentu-enforcer \
  "Read .mentu/manifest.yaml for your actor, then read /home/mentu/Workspaces/mentu-bridge/docs/HANDOFF-BugExecutionLoop-v1.0.md and execute."'
```

> **IMPORTANT**: `--mentu-enforcer` is a CUSTOM FLAG that ONLY works with the wrapper script.
> The native `claude` command does NOT recognize this flag and will error.

---

## Local Development (Mac)

For local development/testing before VPS deployment:

### Without Enforcer:

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
claude \
  --dangerously-skip-permissions \
  --max-turns 100 \
  "Read .mentu/manifest.yaml for your actor identity, then read /Users/rashid/Desktop/Workspaces/mentu-bridge/docs/HANDOFF-BugExecutionLoop-v1.0.md and execute as the HANDOFF's author_type."
```

### With Enforcer:

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
~/claude-code-app/run-claude.sh \
  --dangerously-skip-permissions \
  --max-turns 100 \
  --mentu-enforcer \
  "Read .mentu/manifest.yaml for your actor identity, then read /Users/rashid/Desktop/Workspaces/mentu-bridge/docs/HANDOFF-BugExecutionLoop-v1.0.md and execute as the HANDOFF's author_type."
```

---

## What This Prompt Delivers

| Deliverable | Description |
|-------------|-------------|
| `src/realtime-subscriber.ts` | WebSocket subscription to bridge_commands table |
| `src/genesis-enforcer.ts` | Pre-execution validation against genesis.key rules |
| `src/worktree-manager.ts` | Git worktree creation/cleanup for isolation |
| `src/output-streamer.ts` | 100ms buffered log streaming to spawn_logs |
| `src/bug-executor.ts` | Main orchestrator using all beacon-parity modules |
| `src/daemon.ts` (updated) | Wires BugExecutor into daemon startup |
| `mentu-bridge.service` | systemd service configuration for VPS |
| `docs/RESULT-BugExecutionLoop-v1.0.md` | Closure proof with evidence |

---

## Expected Duration

- **Turns**: 50-75
- **Complexity**: T2 (Feature implementation with beacon-parity)
- **Commitments**: 1
- **Target**: VPS systemd service

---

## VPS Verification

```bash
# SSH to VPS
ssh mentu@208.167.255.71

# Navigate to workspace
cd /home/mentu/Workspaces/mentu-bridge

# Verify all deliverables exist
ls -la src/realtime-subscriber.ts \
       src/genesis-enforcer.ts \
       src/worktree-manager.ts \
       src/output-streamer.ts \
       src/bug-executor.ts \
       src/daemon.ts

# Verify build passes
npm run build

# Verify TypeScript compiles
npx tsc --noEmit

# Verify systemd service
cat /etc/systemd/system/mentu-bridge.service

# Test service start
sudo systemctl start mentu-bridge
sudo systemctl status mentu-bridge

# Watch logs
journalctl -u mentu-bridge -f

# Verify commitment closed
mentu show cmt_6c8e6d56
```

---

## Test the Implementation

After deploying to VPS, test with a bug report:

```bash
# 1. Trigger a bug report (watch for instant pickup!)
curl -X POST "https://mentu-proxy.affihub.workers.dev/bug-webhook" \
  -H "X-API-Key: $BUG_REPORTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test: Button does nothing",
    "description": "Click submit, nothing happens. Steps: 1. Go to form, 2. Fill fields, 3. Click submit, 4. Nothing",
    "severity": "low",
    "workspace_id": "YOUR_WORKSPACE_ID",
    "workspace_path": "/home/mentu/Workspaces/mentu-ai"
  }'

# 2. Watch bridge logs (should see INSTANT notification, not 60s polling)
ssh mentu@208.167.255.71 'journalctl -u mentu-bridge -f'

# Expected log output:
# [RealtimeSubscriber] Received: INSERT bridge_commands
# [BugExecutor] Processing command: cmd_xxx
# [GenesisEnforcer] Checking genesis rules...
# [WorktreeManager] Creating worktree: /tmp/mentu-worktrees/cmd_xxx
# [OutputStreamer] Starting stream for cmd_xxx
# [BugExecutor] Spawning Claude executor...
# [OutputStreamer] Flushing 1024 bytes to spawn_logs
# [BugExecutor] Execution complete, capturing evidence
# [WorktreeManager] Cleaning up worktree

# 3. Check spawn_logs for real-time output
ssh mentu@208.167.255.71 'cd /home/mentu/Workspaces/mentu-ai && \
  mentu show <command_id> --logs'

# 4. Check commitment was processed
mentu status --all
```

---

## VPS Service Management

```bash
# Enable on boot
sudo systemctl enable mentu-bridge

# Start/Stop/Restart
sudo systemctl start mentu-bridge
sudo systemctl stop mentu-bridge
sudo systemctl restart mentu-bridge

# View logs
journalctl -u mentu-bridge -f
journalctl -u mentu-bridge --since "1 hour ago"

# Check status
sudo systemctl status mentu-bridge
```

---

*Beacon-parity bug execution: report → realtime notification → atomic claim → genesis check → worktree isolation → execution with streaming → evidence → closure.*
