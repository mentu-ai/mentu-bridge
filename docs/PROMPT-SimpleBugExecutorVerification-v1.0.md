---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: PROMPT-SimpleBugExecutorVerification-v1.0
path: docs/PROMPT-SimpleBugExecutorVerification-v1.0.md
type: prompt
intent: execute

version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14

tier: T2

actor: (from manifest)

parent: HANDOFF-SimpleBugExecutorVerification-v1.0

mentu:
  commitment: pending
  status: pending
---

# Executable Prompt: SimpleBugExecutor Verification v1.0

## Launch Commands

### Option A: Native Claude (NO mentu-enforcer)

Use this when you do NOT need stop-time commitment enforcement:

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

claude \
  --dangerously-skip-permissions \
  --max-turns 50 \
  "
# IDENTITY
Your actor identity comes from the repository manifest (.mentu/manifest.yaml).
Your role (author_type) comes from the HANDOFF document you are executing: executor.

Read .mentu/manifest.yaml to discover your actor.

# COGNITIVE STANCE
Your domain is TECHNICAL.
- Technical failures: Own it. Fix it. Don't explain.
- Other failures: You drifted. Re-read the HANDOFF.

# MISSION
Fix SimpleBugExecutor to verify actual outcomes (git commits, ledger updates) before reporting success.

# CONTRACT
Done when:
- buildUnifiedBugPrompt() uses mentu CLI (not curl proxyUrl/ops)
- verifyOutcome() method checks git commits and ledger state
- handleResult() uses verification status, not just exit code
- Files changed come from git diff, not Claude's JSON
- npm run build passes
- Commitment submitted with evidence

# PROTOCOL
1. Read docs/HANDOFF-SimpleBugExecutorVerification-v1.0.md (complete instructions)
2. Create .mentu/feature_lists/cmt_XXX.json with the completion contract
3. Claim commitment: mentu claim cmt_XXX --author-type executor
4. Follow Build Order (7 stages)
5. Run: npm run build
6. If errors: fix them, don't explain
7. Capture evidence: mentu capture 'Implemented verification' --kind evidence
8. Submit: mentu submit cmt_XXX --summary 'Verification system implemented' --include-files

# CONSTRAINTS
- DO NOT break daemon.ts lifecycle
- DO NOT add new dependencies
- DO NOT modify database schema
- DO NOT change BugCommand interface
- DO NOT remove retry logic

# RECOVERY
- If tsc fails: fix type errors before proceeding
- If build fails: check imports (exec, fs)
- If mentu commands fail: verify .mentu/ exists
- If verification fails: check stance, fix, don't argue

# CONTEXT
Read: docs/HANDOFF-SimpleBugExecutorVerification-v1.0.md (build instructions)
Reference: docs/PRD-SimpleBugExecutorVerification-v1.0.md (full specification)
Reference: src/simple-bug-executor.ts (current implementation)

# EVIDENCE
Final message must include:
- All files modified
- Build status (npm run build)
- Commitment ID submitted
- Verification that curl commands are gone
- Verification that mentu CLI commands are in prompt
"
```

---

### Option B: VPS Deployment (Production)

For running on the VPS after local development:

```bash
# SSH to VPS
ssh mentu@208.167.255.71

# Navigate to bridge repo
cd /home/mentu/Workspaces/mentu-bridge

# Pull latest changes (from local development)
git pull

# Build
npm run build

# Restart service
sudo systemctl restart mentu-bridge

# Watch logs
journalctl -u mentu-bridge -f
```

---

### Option C: Manual Execution (Step by Step)

If you prefer to execute stages manually:

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

# Read the HANDOFF
cat docs/HANDOFF-SimpleBugExecutorVerification-v1.0.md

# Open editor
code src/simple-bug-executor.ts

# Make changes per Build Order stages 1-7

# Build
npm run build

# If successful, deploy to VPS
git add -A
git commit -m "fix: SimpleBugExecutor verification system

- Use local mentu CLI instead of curl proxyUrl/ops
- Add verifyOutcome() to check git and ledger state
- Update handleResult() to use verification status
- Extract files changed from git diff

PRD: PRD-SimpleBugExecutorVerification-v1.0"

git push origin HEAD
```

---

## Minimal Prompts

### Quick Launch (native claude):

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

claude \
  --dangerously-skip-permissions \
  --max-turns 50 \
  "Read docs/HANDOFF-SimpleBugExecutorVerification-v1.0.md and execute as executor."
```

### With Enforcer (wrapper script):

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

~/claude-code-app/run-claude.sh \
  --dangerously-skip-permissions \
  --max-turns 50 \
  --mentu-enforcer \
  "Read docs/HANDOFF-SimpleBugExecutorVerification-v1.0.md and execute as executor."
```

---

## What This Prompt Delivers

| Deliverable | Description |
|-------------|-------------|
| Updated buildUnifiedBugPrompt() | Uses mentu CLI instead of curl |
| verifyOutcome() method | Checks git commits and ledger state |
| Git helper methods | getHeadRef, getCommitsSince, getFilesChangedSince |
| checkLedgerClose() method | Reads local ledger for close operation |
| Updated handleResult() | Uses verification status for success |
| Updated BugFixResult interface | Includes verified and verification fields |

---

## Expected Duration

- **Turns**: 20-40
- **Complexity**: T2 (feature implementation)
- **Commitments**: 1

---

## Verification After Completion

```bash
# Verify build passes
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
npm run build

# Verify curl commands removed
grep -n "curl.*proxyUrl.*ops" src/simple-bug-executor.ts
# Should return nothing

# Verify mentu CLI in prompt
grep -n "mentu capture" src/simple-bug-executor.ts
# Should find the instruction

# Verify verifyOutcome exists
grep -n "verifyOutcome" src/simple-bug-executor.ts
# Should find the method

# Verify commitment closed
mentu show cmt_XXX
```

---

## Testing the Fix

After deployment, submit a test bug:

```bash
# 1. Submit bug via WarrantyOS or direct API
curl -X POST "https://mentu-proxy.affihub.workers.dev/bug-webhook" \
  -H "X-API-Key: $BUG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Test verification",
    "description": "Testing SimpleBugExecutor verification system"
  }'

# 2. Watch VPS logs
ssh mentu@208.167.255.71 'journalctl -u mentu-bridge -f'

# 3. Look for:
# - "Starting ref: abc123..."
# - "Verifying outcome..."
# - "Git commits since start: N"
# - "Files changed: ..."
# - "Ledger has close: true/false"
# - "Verification reason: ..."
```

---

*Exit code 0 means "didn't crash". Verification means "actually worked".*
