# Mentu Bridge

Terminal bridge daemon for Mentu. Executes commands from the cloud on your local machine.

## Identity

```
Location: /Users/rashid/Desktop/Workspaces/mentu-bridge
Role: Local execution daemon
Version: 1.0.0
Actor: agent:bridge-daemon
```

## What This Repo Does

The bridge daemon:
1. Registers your machine with Supabase (`bridge_machines` table)
2. Subscribes to Supabase Realtime for incoming commands (`bridge_commands` table)
3. Executes agent commands (Claude, bash) in allowed directories
4. Reports results back (`bridge_results` table)
5. Captures Mentu memories for task/evidence tracking
6. Polls for due commitments and executes them on schedule

## Execution Mode: Persistent

This daemon provides **persistent execution** - work that survives terminal closure.

**Full specification**: `mentu-ai/docs/Execution-Modes.md`

```
Session-Bound (Task tool)     vs     Persistent (mentu-bridge)
─────────────────────────────────────────────────────────────────
Child of terminal                    Separate daemon (launchd)
Dies when parent exits               Runs 24/7, survives exit
Synchronous result                   Async (poll for status)
Use for: research, exploration       Use for: screenshots, long tasks
```

**When agents should use me**:
- Screenshot capture (visual verification)
- Long-running test suites (>2 minutes)
- Deployments and builds
- Any work that must complete after executor exits
- Scheduled/recurring tasks

**API**: `POST https://mentu-proxy.affihub.workers.dev/bridge/spawn`

## Architecture

```
src/
├── index.ts         # Entry point - loads config, starts daemon
├── daemon.ts        # Core daemon - realtime subscription, command execution
├── config.ts        # Config loader (~/.mentu/bridge.yaml)
├── scheduler.ts     # Commitment polling and scheduled execution
├── approval.ts      # Approval workflow handler
├── prompt-builder.ts # Prompt construction for commitment execution
└── types.ts         # TypeScript interfaces
```

## Commands

```bash
# Development
npm run dev          # Run with ts-node
npm run build        # Compile TypeScript

# Production
npm start            # Run compiled daemon

# Daemon management (launchd)
launchctl load ~/Library/LaunchAgents/ai.mentu.bridge.plist
launchctl unload ~/Library/LaunchAgents/ai.mentu.bridge.plist
launchctl list | grep mentu

# Logs
tail -f /tmp/mentu-bridge.log
```

## Authentication

### Claude Spawning

The daemon spawns Claude CLI processes with environment inheritance:

```typescript
const env = {
  ...process.env,
  // OAuth token passed to spawned Claude processes
  ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  }),
};
```

**Required environment**:
- `CLAUDE_CODE_OAUTH_TOKEN` - For spawned Claude CLI processes
- Token set in `/home/mentu/.mentu.env` on VPS (systemd EnvironmentFile)
- Token set in `~/.zshrc` on Mac (launchd inherits from shell)

**Convention**: Never hardcode tokens. Always pass from environment.

See `Workspaces/CLAUDE.md` for the full authentication convention.

---

## Configuration

Config lives at `~/.mentu/bridge.yaml`:

```yaml
machine:
  id: "macbook-rashid"
  name: "MacBook Pro"

workspace:
  id: "<workspace-uuid>"

execution:
  allowed_directories:
    - "/Users/rashid/Desktop/Workspaces"
  default_timeout_seconds: 3600
  max_output_bytes: 10485760

agents:
  claude:
    path: "/usr/local/bin/claude"
    default_flags:
      - "--dangerously-skip-permissions"
  bash:
    path: "/bin/bash"
    default_flags:
      - "-c"
```

## Ecosystem Context

I am one of three siblings in the Mentu infrastructure:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         MENTU ECOSYSTEM                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  mentu-ai (The Core)                                                │
│  ├── The Commitment Ledger - accountability for autonomous agents   │
│  ├── CLI: mentu capture/commit/claim/close/submit/approve           │
│  ├── 12 Operations, 2 Objects (Memory, Commitment), 3 Rules         │
│  ├── Supabase Edge Function: /ops endpoint                          │
│  └── Schema owner: memories, commitments, operations tables         │
│                                                                      │
│  mentu-proxy (The Gateway)                                          │
│  ├── Cloudflare Worker at mentu-proxy.affihub.workers.dev           │
│  ├── Routes /ops → Mentu API (edge function)                        │
│  ├── Routes /bridge/* → Supabase (bridge_commands, bridge_results)  │
│  ├── Routes /rest/* → Supabase PostgREST                            │
│  ├── Routes /signals/* → GitHub/Notion webhooks                     │
│  └── Auth: X-Proxy-Token header                                     │
│                                                                      │
│  mentu-bridge (Me - The Executor)                                   │
│  ├── Mac daemon running 24/7 via launchd                            │
│  ├── Listens: Supabase Realtime → bridge_commands                   │
│  ├── Executes: Claude/bash agents in allowed directories            │
│  ├── Reports: bridge_results + Mentu memory captures                │
│  └── Schedules: Due commitment execution via scheduler.ts           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### The Data Flow

```
[Mobile/Claude/Web]
        │
        ▼
┌───────────────────┐
│   mentu-proxy     │  POST /bridge/commands
│   (Cloudflare)    │  X-Proxy-Token auth
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│     Supabase      │  bridge_commands table
│   (PostgreSQL)    │  Realtime broadcast
└─────────┬─────────┘
          │ Realtime subscription
          ▼
┌───────────────────┐
│   mentu-bridge    │  BridgeDaemon.handleCommand()
│   (This daemon)   │  spawn(agent, prompt)
└─────────┬─────────┘
          │
          ├──► Execute agent (Claude/bash)
          │
          ├──► POST /bridge/results (via proxy)
          │
          └──► POST /ops (Mentu capture)
                    │
                    ▼
              ┌───────────┐
              │ mentu-ai  │  Edge function creates memory
              │   (API)   │  Ledger updated
              └───────────┘
```

### Mentu Protocol Summary

From mentu-ai, the core concepts I work with:

| Concept | Description |
|---------|-------------|
| **Memory** | Something observed (`mem_XXXXXXXX`) - created by `capture` |
| **Commitment** | Something owed (`cmt_XXXXXXXX`) - created by `commit`, requires evidence to close |
| **Operation** | Any action on the ledger (`op_XXXXXXXX`) |

**The Three Rules:**
1. Commitments trace to memories (every obligation has an origin)
2. Closure requires evidence (proving done, not marking done)
3. Append-only (nothing edited, nothing deleted)

**Commitment States:** `open → claimed → in_review → closed` (or `reopened`)

### How I Use Mentu

When I execute a command, I:
1. **Capture task** - Record what I'm about to do as a `task` memory
2. **Execute** - Run the agent (Claude/bash)
3. **Capture evidence** - Record the result as `evidence` memory

```typescript
// From daemon.ts:288
await this.captureMemory(
  `Bridge Task [${command.agent}]: ${command.prompt}`,
  'task'
);

// ... execute command ...

// From daemon.ts:566
await this.captureMemory(evidenceBody, 'evidence');
```

## Dependencies

| Repo | Relationship | What I Use |
|------|--------------|------------|
| mentu-ai | API client | `POST /ops` for memory capture, commitment queries |
| mentu-proxy | Gateway | All API calls route through proxy with X-Proxy-Token |

## Key Concepts

### Command Flow

```
[Phone/Web] → POST /bridge/commands → [Supabase] → [Realtime] → [Bridge Daemon]
                                                                      ↓
                                                              Execute agent
                                                                      ↓
                                                              POST /bridge/results
```

### Commitment Scheduling

The `scheduler.ts` polls for due commitments and triggers execution. Commitments with `rrule` recurrence patterns are automatically rescheduled.

### Approval Flow

Commands with `approval_required: true` pause after Claude execution and wait for user approval via the `bridge_approvals` table before running `on_approve` actions.

## Agent Entry Protocol

When entering this repo:
1. Read this file first
2. Check `.mentu/manifest.yaml` for capabilities
3. Understand the daemon is likely running - changes require restart
4. All Mentu commands should run FROM this directory to use local ledger

## Rules

1. **Security**: Never expose Supabase keys or proxy tokens in logs/code
2. **Allowed Directories**: Respect the `allowed_directories` config - never bypass
3. **Output Limits**: Keep stdout/stderr under `max_output_bytes`
4. **Graceful Shutdown**: Always handle SIGTERM/SIGINT properly
5. **Mentu Captures**: Use appropriate kinds (`task`, `evidence`, `observation`)

## Mentu Integration

```bash
# All captures go to local ledger when run from this directory
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
mentu capture "Bridge work in progress" --kind task
mentu capture "Completed daemon update" --kind evidence
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Daemon not receiving commands | Check `launchctl list \| grep mentu`, verify Realtime subscription in logs |
| Command stays pending | Ensure `working_directory` is in `allowed_directories` |
| Permission errors | Add Node to Full Disk Access (System Settings → Privacy) |
| Claude agent not found | `ln -sf /usr/local/Cellar/node/*/bin/claude /usr/local/bin/claude` |
