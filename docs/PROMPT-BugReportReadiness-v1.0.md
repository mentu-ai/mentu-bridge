---
id: PROMPT-BugReportReadiness-v1.0
path: docs/PROMPT-BugReportReadiness-v1.0.md
type: prompt
intent: execute
version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14
tier: T2
actor: (from manifest)
parent: HANDOFF-BugReportReadiness-v1.0
mentu:
  commitment: cmt_e408fec6
  status: pending
---

# Executable Prompt: BugReportReadiness v1.0

## Launch Command

```bash
claude \
  --dangerously-skip-permissions \
  --max-turns 50 \
  "Read docs/HANDOFF-BugReportReadiness-v1.0.md and execute."
```

---

## What This Prompt Delivers

| Deliverable | Description |
|-------------|-------------|
| `inline-substitute/.mentu/genesis.key` | Execution paths and machine config |
| `inline-substitute/BUG-FIX-PROTOCOL.md` | Bug fix protocol for Claude |
| Supabase settings audit | Workspace bug_reports configuration |
| Bridge config audit | SimpleBugExecutor allowed_directories |

---

## Expected Duration

- **Turns**: 20-40
- **Complexity**: T2 (configuration + audit)
- **Commitments**: 1

---

## Verification After Completion

```bash
# Verify genesis.key
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/.mentu/genesis.key

# Verify protocol
cat /Users/rashid/Desktop/Workspaces/projects/inline-substitute/BUG-FIX-PROTOCOL.md

# Verify commitment closed
mentu show cmt_e408fec6
```

---

*This prompt configures inline-substitute for WarrantyOS bug report integration.*
