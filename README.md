# Mentu Bridge

Terminal bridge daemon for [Mentu](https://github.com/mentu-ai/mentu). Listens for commands via Supabase Realtime and executes them locally on your machine.

## What is Mentu Bridge?

Mentu Bridge connects your local machine to the Mentu cloud, enabling remote execution of Claude Code and other agents from anywhere — your phone, a web dashboard, or CI/CD pipelines.

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Phone/Web     │────▶│  Supabase Cloud  │────▶│   Your Mac      │
│   "Run task X"  │     │  bridge_commands │     │   mentu-bridge  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                         │
                                                         ▼
                                                 ┌─────────────────┐
                                                 │  Claude Code    │
                                                 │  (or bash, etc) │
                                                 └─────────────────┘
```

## Features

- **Remote Execution** - Trigger Claude Code from anywhere
- **Commitment Scheduling** - Execute Mentu commitments when they're due
- **Approval Flow** - Commands can require human approval before execution
- **Genesis Enforcement** - Validates commands against workspace constitutional rules
- **Mentu Integration** - Auto-captures task/evidence memories to the ledger

## Installation

```bash
git clone https://github.com/mentu-ai/mentu-bridge.git
cd mentu-bridge
npm install
npm run build
```

## Configuration

Create `~/.mentu/bridge.yaml`:

```yaml
machine:
  id: "my-macbook"
  name: "My MacBook Pro"

workspace:
  id: "<your-workspace-id>"

supabase:
  url: "<your-supabase-url>"
  anonKey: "<your-supabase-anon-key>"

mentu:
  proxy_url: "<your-mentu-proxy-url>"
  api_key: "<your-api-key>"

execution:
  allowed_directories:
    - "/path/to/your/workspaces"
    - "/tmp"
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

## Running the Daemon

### Manual Start

```bash
npm start
```

### Auto-Start with launchd (macOS)

```bash
# Copy plist to LaunchAgents
cp launchd/ai.mentu.bridge.plist ~/Library/LaunchAgents/

# Load (starts now and on every login)
launchctl load ~/Library/LaunchAgents/ai.mentu.bridge.plist

# Check status
launchctl list | grep mentu

# View logs
tail -f /tmp/mentu-bridge.log
```

### Manage the Daemon

```bash
launchctl stop ai.mentu.bridge     # Stop
launchctl start ai.mentu.bridge    # Start
launchctl unload ~/Library/LaunchAgents/ai.mentu.bridge.plist  # Disable
```

## Usage

### Submit a Command

```bash
curl -X POST "https://your-proxy/bridge/commands" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workspace_id": "<workspace-id>",
    "prompt": "Your task here",
    "working_directory": "/path/to/project",
    "agent": "claude"
  }'
```

### Check Result

```bash
curl "https://your-proxy/bridge/results?command_id=eq.<ID>" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## macOS Setup

### Full Disk Access (Required)

The daemon needs Full Disk Access to read/write files:

1. **System Settings** → **Privacy & Security** → **Full Disk Access**
2. Click **+** and add `/usr/local/bin/node` (or Terminal.app)
3. Restart the daemon

### Claude CLI

Ensure Claude CLI is available:

```bash
which claude  # Should return a path
```

## Architecture

```
src/
├── daemon.ts           # Main daemon loop
├── scheduler.ts        # Commitment scheduling
├── approval.ts         # Approval flow handler
├── genesis-enforcer.ts # Constitutional rule enforcement
├── config.ts           # Configuration loader
└── types.ts            # TypeScript types
```

## Related Projects

- [mentu-ai/mentu](https://github.com/mentu-ai/mentu) - The Commitment Ledger
- [mentu-ai/mentu-proxy](https://github.com/mentu-ai/mentu-proxy) - Cloudflare Worker gateway
- [mentu-ai/mentu-web](https://github.com/mentu-ai/mentu-web) - Web dashboard

## License

MIT
