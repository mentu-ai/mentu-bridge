---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: HANDOFF-BugExecutorLedgerParity-v1.0
path: docs/HANDOFF-BugExecutorLedgerParity-v1.0.md
type: handoff
intent: execute

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

author_type: executor

parent: PRD-BugExecutorLedgerParity-v1.0
children:
  - PROMPT-BugExecutorLedgerParity-v1.0

mentu:
  commitment: cmt_fc576be2
  status: pending

validation:
  required: true
  tier: T2
---

# HANDOFF: BugExecutorLedgerParity v1.0

## For the Coding Agent

Fix the bug executor to pass Mentu environment variables so Claude can properly claim/capture/close commitments via the ledger API.

**Read the full PRD**: `docs/PRD-BugExecutorLedgerParity-v1.0.md`

---

## Your Identity

You are operating as **executor** (from this HANDOFF's `author_type` field).

| Dimension | Source | Value |
|-----------|--------|-------|
| **Actor** | Repository manifest | agent:claude-bridge |
| **Author Type** | This HANDOFF | executor |
| **Context** | Working directory | mentu-bridge |

**Your domain**: technical

**The Rule**:
- Failure in YOUR domain → Own it. Fix it. Don't explain.
- Failure in ANOTHER domain → You drifted. Re-read this HANDOFF.

---

## Completion Contract

**Path**: `.mentu/feature_lists/cmt_fc576be2.json`

```json
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-BugExecutorLedgerParity-v1.0",
  "created": "2026-01-13T08:42:00Z",
  "status": "in_progress",
  "tier": "T2",
  "mentu": {
    "commitment": "cmt_fc576be2",
    "source": "mem_924568d2"
  },
  "features": [
    {
      "id": "F001",
      "description": "spawnTerminalExecutor passes MENTU_* env vars to Claude",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "Prompt instructs Claude to use curl for mentu API calls",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "TypeScript compiles without errors",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "npm run build succeeds",
      "passes": false,
      "evidence": null
    }
  ],
  "checks": {
    "tsc": true,
    "build": true,
    "test": false
  }
}
```

---

## The Problem

Currently in `src/bug-executor.ts` line ~1100:

```typescript
const proc = spawn("claude", [...], {
  cwd: workingDirectory,
  timeout: timeoutSeconds * 1000,
  env: {
    ...process.env,
    MENTU_BRIDGE_COMMAND_ID: commandId,
    // MISSING: No MENTU_API_URL, MENTU_PROXY_TOKEN, etc.
  }
});
```

The prompt tells Claude to run `mentu claim cmt_xxx` but:
1. The working directory (e.g., WarrantyOS project) has no `.mentu` folder
2. No environment variables for the mentu CLI to reach the API
3. The mentu CLI may not even be installed globally

---

## The Solution

### Approach A: Pass Mentu Env Vars (Preferred)

Pass the Mentu API configuration as environment variables that the mentu CLI reads:

```typescript
env: {
  ...process.env,
  MENTU_BRIDGE_COMMAND_ID: commandId,
  // ADD THESE:
  MENTU_API_URL: 'https://mentu-proxy.affihub.workers.dev',
  MENTU_PROXY_TOKEN: this.getWorkspaceToken(command.workspace_id),
  MENTU_WORKSPACE_ID: command.workspace_id,
  MENTU_ACTOR: 'agent:claude-vps',
}
```

### Approach B: Use curl in Prompt (Fallback)

If mentu CLI isn't available, instruct Claude to use curl directly:

```
## Mentu API (Use These curl Commands)

**Base URL**: https://mentu-proxy.affihub.workers.dev
**Auth Header**: X-Proxy-Token: {token}

### Claim Commitment
curl -X POST "{base}/ops" -H "X-Proxy-Token: {token}" -H "Content-Type: application/json" \
  -d '{"op": "claim", "commitment": "cmt_xxx"}'

### Capture Evidence
curl -X POST "{base}/ops" -H "X-Proxy-Token: {token}" -H "Content-Type: application/json" \
  -d '{"op": "capture", "body": "Fixed the bug...", "kind": "evidence"}'

### Close Commitment
curl -X POST "{base}/ops" -H "X-Proxy-Token: {token}" -H "Content-Type: application/json" \
  -d '{"op": "close", "commitment": "cmt_xxx", "evidence": "mem_xxx"}'
```

**Use BOTH approaches**: Pass env vars AND include curl commands in prompt for robustness.

---

## Build Order

### Stage 1: Update spawnTerminalExecutor Environment

**File**: `src/bug-executor.ts`

Find the `spawnTerminalExecutor` method (around line 1070) and update the `env` object:

```typescript
private async spawnTerminalExecutor(
  workingDirectory: string,
  commitmentId: string,
  timeoutSeconds: number,
  commandId: string,
  workspaceId: string,  // ADD THIS PARAMETER
  apiConfig: { proxyUrl: string; apiKey: string }  // ADD THIS PARAMETER
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const prompt = this.buildExecutorPrompt(commitmentId, apiConfig);

    console.log(`[BugExecutor] Spawning Claude in: ${workingDirectory}`);

    const proc = spawn("claude", [
      "--dangerously-skip-permissions",
      "--max-turns", "50",
      "-p", prompt
    ], {
      cwd: workingDirectory,
      timeout: timeoutSeconds * 1000,
      env: {
        ...process.env,
        MENTU_BRIDGE_COMMAND_ID: commandId,
        // Mentu API configuration for CLI
        MENTU_API_URL: apiConfig.proxyUrl,
        MENTU_PROXY_TOKEN: apiConfig.apiKey,
        MENTU_WORKSPACE_ID: workspaceId,
        MENTU_ACTOR: 'agent:claude-vps',
      }
    });

    // ... rest of method
  });
}
```

**Verification**:
```bash
grep -A20 "spawnTerminalExecutor" src/bug-executor.ts | grep MENTU
```

---

### Stage 2: Update the Prompt with API Instructions

**File**: `src/bug-executor.ts`

Add a new method to build the prompt with API instructions:

```typescript
private buildExecutorPrompt(
  commitmentId: string,
  apiConfig: { proxyUrl: string; apiKey: string }
): string {
  return `You are fixing a bug for commitment ${commitmentId}.

Read .mentu/bug-context.md for full instructions.

## Mentu API

**Base URL**: ${apiConfig.proxyUrl}
**Auth Header**: X-Proxy-Token: ${apiConfig.apiKey}

### 1. Claim Commitment (FIRST)
\`\`\`bash
curl -X POST "${apiConfig.proxyUrl}/ops" \\
  -H "X-Proxy-Token: ${apiConfig.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"op": "claim", "commitment": "${commitmentId}"}'
\`\`\`

### 2. Fix the Bug
Use Read, Edit, Bash, Grep, Glob tools as needed.

### 3. Capture Evidence (After Fixing)
\`\`\`bash
curl -X POST "${apiConfig.proxyUrl}/ops" \\
  -H "X-Proxy-Token: ${apiConfig.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"op": "capture", "body": "Fixed: <summary of what you fixed>", "kind": "evidence"}'
\`\`\`
Returns: {"id": "mem_XXXXXXXX", ...}

### 4. Close Commitment (LAST)
\`\`\`bash
curl -X POST "${apiConfig.proxyUrl}/ops" \\
  -H "X-Proxy-Token: ${apiConfig.apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"op": "close", "commitment": "${commitmentId}", "evidence": "mem_XXXXXXXX"}'
\`\`\`

**Important**: You MUST capture evidence first, then use the returned mem_ID to close.

When complete, output JSON:
{"success": true, "summary": "what you did", "files_changed": ["file.ts"]}`;
}
```

**Verification**:
```bash
grep -A5 "buildExecutorPrompt" src/bug-executor.ts
```

---

### Stage 3: Update executeBugCommand to Pass Config

**File**: `src/bug-executor.ts`

Find the `executeBugCommand` method and update the call to `spawnTerminalExecutor`:

```typescript
// Around line 1040, where spawnTerminalExecutor is called:

// BEFORE:
const result = await this.spawnTerminalExecutor(workingDirectory, commitmentId, timeoutSeconds, command.id);

// AFTER:
const apiConfig = {
  proxyUrl: process.env.MENTU_API_URL || 'https://mentu-proxy.affihub.workers.dev',
  apiKey: process.env.MENTU_PROXY_TOKEN || '',
};

if (!apiConfig.apiKey) {
  console.warn(`[BugExecutor] Warning: MENTU_PROXY_TOKEN not set, API calls may fail`);
}

const result = await this.spawnTerminalExecutor(
  workingDirectory,
  commitmentId,
  timeoutSeconds,
  command.id,
  command.workspace_id,
  apiConfig
);
```

**Verification**:
```bash
grep -B5 -A10 "spawnTerminalExecutor(" src/bug-executor.ts | grep -E "apiConfig|workspace_id"
```

---

### Stage 4: Build and Deploy

```bash
# In mentu-bridge directory
npm run build

# Verify no TypeScript errors
# Output should be clean, just "tsc"

# Deploy to VPS via SyncThing (automatic) or manual:
# scp dist/* mentu@208.167.255.71:/home/mentu/Workspaces/mentu-bridge/dist/

# Restart daemon on VPS
ssh mentu@208.167.255.71 'systemctl --user restart mentu-bridge'
```

---

## Testing the Fix

After deploying, submit a test bug from WarrantyOS and verify:

```bash
# 1. Check daemon logs show env vars
ssh mentu@208.167.255.71 'tail -50 /home/mentu/logs/mentu-bridge.log | grep -E "MENTU|proxyUrl|apiKey"'

# 2. Query commitment state in Supabase
# Should show state = 'claimed' after Claude claims
# Should show state = 'closed' after Claude closes
```

---

## Verification Checklist

### Files
- [ ] `src/bug-executor.ts` updated with MENTU_* env vars
- [ ] `src/bug-executor.ts` has buildExecutorPrompt method
- [ ] `dist/bug-executor.js` exists after build

### Checks
- [ ] `npm run build` passes
- [ ] `tsc --noEmit` passes

### Mentu
- [ ] Commitment claimed with `mentu claim`
- [ ] RESULT document created
- [ ] RESULT captured as evidence
- [ ] Commitment submitted with `mentu submit`

### Functionality
- [ ] Test bug from WarrantyOS triggers Claude with correct env vars
- [ ] Claude successfully runs claim via curl/CLI
- [ ] Commitment state in Supabase changes to 'claimed' then 'closed'
- [ ] bridge_commands.status reflects execution completion

---

## Completion Phase (REQUIRED)

**BEFORE calling `mentu submit`, you MUST create a RESULT document:**

### Step 1: Create RESULT Document

Read the template and create:
```bash
cat /Users/rashid/Desktop/Workspaces/mentu-ai/docs/templates/TEMPLATE-Result.md
# Create: docs/RESULT-BugExecutorLedgerParity-v1.0.md
```

### Step 2: Capture RESULT as Evidence

```bash
mentu capture "Created RESULT-BugExecutorLedgerParity: Fixed bug executor to pass MENTU_* env vars" \
  --kind result-document \
  --path docs/RESULT-BugExecutorLedgerParity-v1.0.md \
  --refs cmt_XXXXXXXX \
  --author-type executor
```

### Step 3: Update RESULT Front Matter

```yaml
mentu:
  commitment: cmt_XXXXXXXX
  evidence: mem_YYYYYYYY
  status: in_review
```

### Step 4: Submit with Evidence

```bash
mentu submit cmt_XXXXXXXX \
  --summary "Fixed bug executor ledger parity: Claude now passes MENTU_* env vars and API instructions in prompt" \
  --include-files
```

---

*The ledger is truth. Pass the config. Let Claude own the commitment lifecycle.*
