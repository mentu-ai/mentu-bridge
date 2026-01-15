---
id: HANDOFF-SimpleBugSpawn-v1.0
path: docs/HANDOFF-SimpleBugSpawn-v1.0.md
type: handoff
intent: execute
version: "1.1"
created: 2026-01-14
last_updated: 2026-01-14
tier: T2
author_type: executor
parent: PRD-SimpleBugSpawn-v1.0
children:
  - PROMPT-SimpleBugSpawn-v1.0
related:
  - INTENT-SimpleBugSpawnv2-Architecture
mentu:
  commitment: cmt_80f13e82
  status: pending
validation:
  required: true
  tier: T2
---

# HANDOFF: SimpleBugSpawn v1.0

## For the Coding Agent

Refactor `SimpleBugExecutor` to:
1. Spawn Claude with prompt as CLI argument (not stdin)
2. Use minimal prompt delegating to repo's `BUG-FIX-PROTOCOL.md`
3. Record execution events to Mentu ledger (preparing for v2.0)

**Read the full PRD**: `docs/PRD-SimpleBugSpawn-v1.0.md`
**Future direction**: `docs/INTENT-SimpleBugSpawnv2-Architecture.md`

---

## Your Identity

| Dimension | Source | Value |
|-----------|--------|-------|
| **Actor** | Repository manifest | agent:bridge-daemon |
| **Author Type** | This HANDOFF | executor |
| **Context** | Working directory | mentu-bridge |

**Your domain**: technical

---

## Architectural Context

### v1.0 Scope (This HANDOFF)

```
┌───────────────────────────────────────────────────────────────────────┐
│                        v1.0 ARCHITECTURE                              │
│                                                                       │
│  Bug Report → Proxy → bridge_commands table                          │
│                              ↓                                        │
│               SimpleBugExecutor polls bridge_commands                 │
│                              ↓                                        │
│               Spawns Claude: claude "prompt" --max-turns 50          │
│                              ↓                                        │
│               Claude reads ./BUG-FIX-PROTOCOL.md                     │
│                              ↓                                        │
│               Claude: mentu capture + mentu close                    │
│                              ↓                                        │
│               Executor verifies: git commits + ledger close          │
└───────────────────────────────────────────────────────────────────────┘
```

**Still uses**: `bridge_commands` table for dispatch
**New**: CLI arg spawn, minimal prompt, ledger recording

### v2.0 Direction (Future - Read Only)

```
┌───────────────────────────────────────────────────────────────────────┐
│                        v2.0 ARCHITECTURE                              │
│                                                                       │
│  Bug Report → Ledger: commit(tags: [bug_fix])                        │
│                              ↓                                        │
│               Executor QUERIES ledger for open bug_fix commitments   │
│                              ↓                                        │
│               Executor: capture(kind: execution_start)               │
│                              ↓                                        │
│               Executor: mentu claim cmt_xxx                          │
│                              ↓                                        │
│               Worktree isolation: ./work/{commitment_id}/            │
│                              ↓                                        │
│               Spawns Claude in worktree                              │
│                              ↓                                        │
│               Conflict detection, parallel execution                 │
└───────────────────────────────────────────────────────────────────────┘
```

**DO NOT implement v2.0**. But structure code for easy migration.

---

## How Mentu Ledger Works

### The Ledger

```
.mentu/ledger.jsonl          # Local append-only ledger
       ↓ mentu sync
Supabase operations table    # Cloud storage
```

Each operation is a JSON line:
```json
{"id":"mem_abc123","op":"capture","actor":"agent:claude","payload":{"body":"...", "kind":"evidence"},"ts":"2026-01-14T..."}
{"id":"cmt_xyz789","op":"commit","actor":"admin:rashid","payload":{"body":"Fix bug","source":"mem_abc123"},"ts":"..."}
{"id":"op_claim01","op":"claim","actor":"agent:bridge","payload":{"commitment":"cmt_xyz789"},"ts":"..."}
{"id":"op_close01","op":"close","actor":"agent:claude","payload":{"commitment":"cmt_xyz789","evidence":"mem_def456"},"ts":"..."}
```

### State Machine

Commitment state is **derived** from operations:
```
commit    → state: open
claim     → state: claimed
submit    → state: in_review
approve   → state: closed (or close directly with evidence)
close     → state: closed
release   → state: open (give up claim)
reopen    → state: reopened
```

### Key Insight for v1.0

**v1.0**: `bridge_commands.status` tracks execution state
**v2.0**: Ledger operations track execution state

For v1.0, we still poll `bridge_commands`, but we **also record to ledger** so that:
- Execution history is auditable
- v2.0 migration has existing patterns
- Verification can query ledger

---

## Completion Contract

**Path**: `.mentu/feature_lists/cmt_80f13e82.json`

```json
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-SimpleBugSpawn-v1.0",
  "created": "2026-01-14T00:00:00Z",
  "status": "in_progress",
  "tier": "T2",
  "mentu": {
    "commitment": "cmt_80f13e82",
    "source": "mem_5aa51994"
  },
  "features": [
    {
      "id": "F001",
      "description": "SimpleBugExecutor spawns Claude with prompt as CLI argument (not stdin)",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "Minimal prompt references ./BUG-FIX-PROTOCOL.md for repo-specific instructions",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "Working directory comes from command metadata, not hardcoded",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "Max turns increased to 50 (configurable)",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F005",
      "description": "Executor records execution_start capture to ledger (v2.0 prep)",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F006",
      "description": "BUG-FIX-PROTOCOL.md template exists for repos to copy",
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

## Important Context: Path Resolution

**You do NOT need to implement path resolution.** The proxy already handles this:

1. Proxy queries `workspaces.settings.bug_reports.sources[source]`
2. Proxy selects `vps_directory` or `working_directory` based on `target_machine_id`
3. Proxy stores the resolved path in `bridge_commands.working_directory`

**SimpleBugExecutor just reads `command.working_directory`** - no path logic needed.

---

## Build Order

### Stage 1: Refactor Spawn Method (CLI Argument)

**File**: `src/simple-bug-executor.ts`

Replace stdin piping with CLI argument spawn:

```typescript
/**
 * Spawn Claude with prompt as CLI argument (not stdin)
 */
private async spawnClaudeWithArg(
  workingDirectory: string,
  prompt: string,
  timeoutSeconds: number,
  commandId: string,
  commitmentId: string
): Promise<BugFixResult> {
  return new Promise((resolve) => {
    this.log(`[v1.0] Spawning claude with CLI arg in ${workingDirectory}`);

    // NEW: Pass prompt as positional argument, NOT via stdin
    const proc = spawn('claude', [
      '--dangerously-skip-permissions',
      '--max-turns', this.MAX_TURNS.toString(),
      prompt,  // ← Prompt as CLI argument
    ], {
      cwd: workingDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],  // stdin ignored (no piping)
      env: {
        ...process.env,
        MENTU_BRIDGE_COMMAND_ID: commandId,
        MENTU_COMMITMENT: commitmentId,
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        }),
      },
    });

    this.currentProcess = proc;

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      this.log(`Command timed out after ${timeoutSeconds}s`);
      proc.kill('SIGTERM');
      setTimeout(() => {
        if (this.currentProcess === proc) {
          proc.kill('SIGKILL');
        }
      }, 5000);
    }, timeoutSeconds * 1000);

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      if (stdout.length % 5000 < chunk.length) {
        this.log(`Output: ${stdout.length} bytes`);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      this.currentProcess = null;

      const exitCode = code ?? 1;
      this.log(`Claude exited with code ${exitCode}${timedOut ? ' (timeout)' : ''}`);

      resolve({
        success: !timedOut && exitCode === 0,
        verified: false,
        summary: timedOut
          ? `Timed out after ${timeoutSeconds}s`
          : stdout.slice(-1000) || stderr.slice(-500) || 'No output',
        files_changed: [],
        tests_passed: false,
        blocked_reason: timedOut ? 'Execution timeout' : undefined,
        exit_code: exitCode,
        output: stdout.slice(-10000),
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeoutHandle);
      this.currentProcess = null;

      this.log(`Spawn error: ${err.message}`);
      resolve({
        success: false,
        verified: false,
        summary: `Spawn error: ${err.message}`,
        files_changed: [],
        tests_passed: false,
        blocked_reason: err.message,
        exit_code: 1,
        output: stderr,
      });
    });
  });
}
```

**Verification**:
```bash
npm run build
grep "CLI arg" src/simple-bug-executor.ts
```

---

### Stage 2: Build Minimal Prompt

**File**: `src/simple-bug-executor.ts`

Replace the complex `buildUnifiedBugPrompt` with a minimal version:

```typescript
/**
 * Build minimal prompt that delegates to repo's BUG-FIX-PROTOCOL.md
 *
 * v1.0: Minimal prompt, repo owns instructions
 * v2.0: Will add worktree path, session tracking
 */
private buildMinimalPrompt(
  bugDescription: string,
  commitmentId: string,
  memoryId: string
): string {
  return `Fix this bug (commitment: ${commitmentId}):
${bugDescription}

Full instructions: Read ./BUG-FIX-PROTOCOL.md
Bug details available as memory: ${memoryId}`;
}
```

**Verification**:
```bash
grep "BUG-FIX-PROTOCOL" src/simple-bug-executor.ts
```

---

### Stage 3: Record Execution Start to Ledger (v2.0 Prep)

**File**: `src/simple-bug-executor.ts`

Add ledger recording for future v2.0 migration:

```typescript
/**
 * Record execution_start to ledger via mentu capture
 *
 * v1.0: Records for audit trail
 * v2.0: This becomes the dispatch mechanism (instead of bridge_commands)
 */
private async recordExecutionStart(
  commitmentId: string,
  workingDirectory: string,
  commandId: string
): Promise<string | null> {
  try {
    // Use mentu CLI to capture execution start
    // This creates a memory that can be queried in v2.0
    const response = await fetch(`${this.apiConfig.proxyUrl}/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': this.apiConfig.apiKey,
      },
      body: JSON.stringify({
        op: 'capture',
        body: `Bug execution starting for ${commitmentId}`,
        kind: 'execution_start',
        actor: 'agent:bridge-executor',
        meta: {
          commitment_id: commitmentId,
          working_directory: workingDirectory,
          bridge_command_id: commandId,
          state: 'starting',
          max_turns: this.MAX_TURNS,
          // v2.0 will add: tmux_session, worktree_path
        },
      }),
    });

    if (!response.ok) {
      this.log(`[Ledger] execution_start capture failed: ${await response.text()}`);
      return null;
    }

    const result = await response.json() as { id: string };
    this.log(`[Ledger] Recorded execution_start: ${result.id}`);
    return result.id;

  } catch (err) {
    this.log(`[Ledger] execution_start error: ${err instanceof Error ? err.message : String(err)}`);
    return null;  // Non-fatal: continue execution even if ledger fails
  }
}

/**
 * Record execution completion to ledger
 */
private async recordExecutionComplete(
  executionStartId: string | null,
  commitmentId: string,
  result: BugFixResult
): Promise<void> {
  if (!executionStartId) return;

  try {
    await fetch(`${this.apiConfig.proxyUrl}/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': this.apiConfig.apiKey,
      },
      body: JSON.stringify({
        op: 'annotate',
        target: executionStartId,
        body: result.success
          ? `Execution completed successfully: ${result.summary.slice(0, 200)}`
          : `Execution failed: ${result.blocked_reason || result.summary.slice(0, 200)}`,
        actor: 'agent:bridge-executor',
        meta: {
          state: result.verified ? 'verified' : (result.success ? 'completed' : 'failed'),
          exit_code: result.exit_code,
          files_changed: result.files_changed,
          verified: result.verified,
        },
      }),
    });

    this.log(`[Ledger] Recorded execution completion for ${commitmentId}`);
  } catch (err) {
    this.log(`[Ledger] completion annotation error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

---

### Stage 4: Update executeBugFix

**File**: `src/simple-bug-executor.ts`

Update to use new methods:

```typescript
private async executeBugFix(command: BugCommand): Promise<BugFixResult> {
  const payload = command.payload || {};
  const memoryId = payload.memory_id;
  const commitmentId = command.commitment_id || payload.commitment_id;
  const workingDirectory = command.working_directory;
  const timeoutSeconds = payload.timeout_seconds || command.timeout_seconds || this.TIMEOUT_SECONDS;

  if (!memoryId) {
    throw new Error('Bug execution requires payload.memory_id');
  }

  if (!commitmentId) {
    throw new Error('Bug execution requires commitment_id');
  }

  // Update bridge_commands status
  await this.supabase
    .from('bridge_commands')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .eq('id', command.id);

  // Record to ledger (v2.0 prep)
  const executionStartId = await this.recordExecutionStart(
    commitmentId,
    workingDirectory,
    command.id
  );

  // Capture starting git ref for verification
  const startRef = await this.getHeadRef(workingDirectory);
  this.log(`Starting ref: ${startRef}`);

  // Fetch bug memory for description
  this.log(`Fetching bug memory ${memoryId}`);
  const bugMemory = await this.fetchBugMemory(command.workspace_id, memoryId);
  if (!bugMemory) {
    throw new Error(`Bug memory ${memoryId} not found`);
  }

  // Extract bug description
  const bugDescription = this.extractBugDescription(bugMemory);

  // Build minimal prompt (delegates to repo's protocol file)
  const prompt = this.buildMinimalPrompt(bugDescription, commitmentId, memoryId);

  // Spawn Claude with CLI argument (not stdin)
  this.log(`Spawning Claude in ${workingDirectory} (max turns: ${this.MAX_TURNS}, timeout: ${timeoutSeconds}s)`);
  const claudeResult = await this.spawnClaudeWithArg(
    workingDirectory,
    prompt,
    timeoutSeconds,
    command.id,
    commitmentId
  );

  // Verify outcomes
  const verification = await this.verifyOutcome(
    workingDirectory,
    commitmentId,
    startRef,
    { success: claudeResult.success, blocked_reason: claudeResult.blocked_reason }
  );

  const finalResult: BugFixResult = {
    ...claudeResult,
    verified: verification.verified,
    files_changed: verification.filesChanged.length > 0
      ? verification.filesChanged
      : claudeResult.files_changed,
    verification,
  };

  // Record completion to ledger (v2.0 prep)
  await this.recordExecutionComplete(executionStartId, commitmentId, finalResult);

  return finalResult;
}
```

---

### Stage 5: Update Configuration

**File**: `src/simple-bug-executor.ts`

Update constructor for 50 max turns:

```typescript
// Add to interface
export interface SimpleBugExecutorConfig {
  pollIntervalMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  timeoutSeconds?: number;
  staleThresholdMinutes?: number;
  maxTurns?: number;  // NEW: configurable max turns
}

// In class, add property
private readonly MAX_TURNS: number;

// In constructor
constructor(
  supabase: SupabaseClient,
  workspaces: WorkspaceConfig[],
  machineId: string,
  apiConfig: { proxyUrl: string; apiKey: string },
  config: SimpleBugExecutorConfig = {}
) {
  // ... existing code ...

  // Increase default max turns from 30 to 50
  this.MAX_TURNS = config.maxTurns ?? 50;
}
```

---

### Stage 6: Add extractBugDescription Helper

**File**: `src/simple-bug-executor.ts`

```typescript
/**
 * Extract bug description from memory payload
 */
private extractBugDescription(memory: BugMemory): string {
  const payload = memory.payload || {};
  const body = (payload.body as string) || '';

  // Extract first paragraph (before --- separator) as description
  const description = body.split('---')[0]?.trim().slice(0, 800) || body.slice(0, 800);

  return description || 'Bug details in memory';
}
```

---

### Stage 7: Create Protocol Template

**File**: `docs/BUG-FIX-PROTOCOL-TEMPLATE.md`

Already created. Verify it exists:

```bash
ls docs/BUG-FIX-PROTOCOL-TEMPLATE.md
```

---

### Stage 8: Remove Old Methods

**File**: `src/simple-bug-executor.ts`

Remove deprecated methods:
- `spawnTerminalClaude` → replaced by `spawnClaudeWithArg`
- `buildUnifiedBugPrompt` → replaced by `buildMinimalPrompt`
- `extractBugInfo` → simplified to `extractBugDescription`

---

## v2.0 Migration Notes

When implementing v2.0 (from INTENT-SimpleBugSpawnv2-Architecture.md), these changes will be needed:

| v1.0 Code | v2.0 Change |
|-----------|-------------|
| Poll `bridge_commands` table | Query ledger: `op = commit AND tags contains bug_fix AND state = open` |
| `command.working_directory` | Read from genesis.key paths |
| Same directory execution | Worktree: `./work/{commitment_id}/` |
| No conflict detection | Build file dependency graph from bug descriptions |
| No tmux tracking | Record tmux session name in ledger |
| `recordExecutionStart()` | Becomes the dispatch mechanism |

**Code patterns to preserve**:
- Ledger recording (`recordExecutionStart`, `recordExecutionComplete`)
- Minimal prompt pattern
- Verification logic

---

## Verification Checklist

### Files
- [ ] `src/simple-bug-executor.ts` updated with CLI arg spawn
- [ ] `docs/BUG-FIX-PROTOCOL-TEMPLATE.md` exists

### Checks
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes
- [ ] No stdin piping in spawn code

### Functionality
- [ ] Spawn uses CLI argument (grep for "CLI arg" in logs)
- [ ] Prompt references `./BUG-FIX-PROTOCOL.md`
- [ ] Max turns is 50 by default
- [ ] Execution start recorded to ledger

### Mentu
- [ ] Commitment claimed
- [ ] Evidence captured
- [ ] Commitment submitted

---

## Completion Phase (REQUIRED)

**BEFORE calling `mentu submit`, you MUST:**

1. Create RESULT document at `docs/RESULT-SimpleBugSpawn-v1.0.md`
2. Capture RESULT as evidence:
   ```bash
   mentu capture "Created RESULT-SimpleBugSpawn: CLI arg spawn + ledger recording + protocol template" \
     --kind result-document \
     --path docs/RESULT-SimpleBugSpawn-v1.0.md \
     --author-type executor
   ```
3. Submit with evidence:
   ```bash
   mentu submit cmt_80f13e82 --summary "Refactored bug spawn to CLI arg pattern with ledger recording" --include-files
   ```

---

*This HANDOFF delivers v1.0 bug spawn (CLI arg, minimal prompt) with v2.0 preparation (ledger recording).*
