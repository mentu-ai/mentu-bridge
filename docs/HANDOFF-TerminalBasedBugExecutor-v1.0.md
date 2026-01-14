---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: HANDOFF-TerminalBasedBugExecutor-v1.0
path: docs/HANDOFF-TerminalBasedBugExecutor-v1.0.md
type: handoff
intent: execute

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T2

author_type: executor

parent: PRD-TerminalBasedBugExecutor-v1.0
children:
  - PROMPT-TerminalBasedBugExecutor-v1.0

mentu:
  commitment: cmt_tbe_c06c29
  status: pending

validation:
  required: true
  tier: T2
---

# HANDOFF: TerminalBasedBugExecutor v1.0

## For the Coding Agent

Replace the headless JSON-prompt bug executor with terminal-based Claude spawning. Bridge becomes infrastructure, Claude becomes actor.

**Read the full PRD**: `docs/PRD-TerminalBasedBugExecutor-v1.0.md`

---

## Your Identity

You are operating as **executor** (from this HANDOFF's `author_type` field).

Your actor identity comes from the repository manifest (`.mentu/manifest.yaml`).

| Dimension | Source | Value |
|-----------|--------|-------|
| **Actor** | Repository manifest | (auto-resolved) |
| **Author Type** | This HANDOFF | executor |
| **Context** | Working directory | mentu-bridge |

**Your domain**: technical

**The Rule**:
- Failure in YOUR domain → Own it. Fix it. Don't explain.
- Failure in ANOTHER domain → You drifted. Re-read this HANDOFF.

---

## Completion Contract

**Path**: `.mentu/feature_lists/cmt_XXXXXXXX.json`

```json
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-TerminalBasedBugExecutor-v1.0",
  "created": "2026-01-13T00:00:00Z",
  "status": "in_progress",
  "tier": "T2",
  "mentu": {
    "commitment": "cmt_XXXXXXXX",
    "source": "mem_XXXXXXXX"
  },
  "features": [
    {
      "id": "F001",
      "description": "bug-executor uses command.working_directory directly",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F002",
      "description": "Bug context file written to .mentu/bug-context.md",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F003",
      "description": "Claude spawned in terminal mode with correct cwd",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F004",
      "description": "Bridge does NOT claim/close commitments",
      "passes": false,
      "evidence": null
    },
    {
      "id": "F005",
      "description": "TypeScript compiles without errors",
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

## Mentu Protocol

### Operations

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge

# Claim commitment (actor auto-resolved)
mentu claim cmt_XXXXXXXX --author-type executor

# Capture progress
mentu capture "Progress update" --kind execution-progress --author-type executor
```

---

## Build Order

### Stage 1: Create Context Writer

Create a new file to write structured bug context.

**File**: `src/context-writer.ts`

```typescript
import * as fs from 'fs/promises';
import * as path from 'path';
import type { AuditOutput } from './types/audit-output.js';

export interface BugContextOptions {
  commitmentId: string;
  audit: AuditOutput;
  workingDirectory: string;
}

/**
 * Write bug context to .mentu/bug-context.md
 * Claude will read this file on startup.
 */
export async function writeBugContext(options: BugContextOptions): Promise<string> {
  const { commitmentId, audit, workingDirectory } = options;

  const mentuDir = path.join(workingDirectory, '.mentu');
  await fs.mkdir(mentuDir, { recursive: true });

  const contextPath = path.join(mentuDir, 'bug-context.md');

  const content = `# Bug Fix Context

## Commitment
${commitmentId}

## Objective
${audit.audit.objective}

## Context from Auditor
- **Hypothesis**: ${audit.context.hypothesis}
- **Likely files**: ${audit.context.likely_files.join(', ')}
- **Confidence**: ${audit.context.confidence}

## Scope Boundaries
- **Allowed to modify**: ${audit.audit.scope.allowed_patterns.join(', ')}
- **FORBIDDEN to touch**: ${audit.audit.scope.forbidden_patterns.join(', ')}
- **Maximum files to change**: ${audit.audit.scope.max_file_changes}

## Constraints
${audit.audit.constraints.map(c => `- ${c}`).join('\n')}

## Success Criteria
${audit.audit.success_criteria.map(c => `- ${c}`).join('\n')}

---

## Your Task

1. Run: \`mentu claim ${commitmentId}\`
2. Fix the bug (you have Read, Edit, Bash, Grep, Glob)
3. Verify your fix works (build, test if applicable)
4. Run: \`mentu capture "Fixed: <summary>" --kind evidence\`
5. Run: \`mentu close ${commitmentId} --evidence mem_XXXXXXXX\`

**Important**: You are the ACTOR. You claim and close the commitment.
`;

  await fs.writeFile(contextPath, content, 'utf-8');
  return contextPath;
}
```

**Verification**:
```bash
npx tsc --noEmit
```

---

### Stage 2: Modify executeBugCommand

Update `executeBugCommand()` in `bug-executor.ts` to:
1. Use `command.working_directory` directly (not workspace config)
2. Remove direct claim operation (Claude will claim)
3. Remove direct close operation (Claude will close)

**File**: `src/bug-executor.ts`

Find the `executeBugCommand` method (around line 995) and modify:

```typescript
/**
 * Execute a bug_execution command using terminal-based Claude spawning.
 *
 * ARCHITECTURE CHANGE (v2.0):
 * - Bridge is INFRASTRUCTURE only (no ledger operations)
 * - Claude is the ACTOR (claims, captures, closes)
 * - Auditor still runs headless for boundary analysis
 * - Executor spawns in terminal mode with mentu CLI access
 */
async executeBugCommand(command: BridgeCommand & { payload?: { memory_id?: string; commitment_id?: string; timeout_seconds?: number } }): Promise<ExecutionResult> {
  const payload = command.payload || {};
  const memoryId = payload.memory_id;
  const commitmentId = command.commitment_id || payload.commitment_id;
  const timeoutSeconds = payload.timeout_seconds || command.timeout_seconds || 3600;

  // CRITICAL FIX: Use command.working_directory directly
  // Do NOT use resolveWorkspaceDirectory() which overrides with workspace config
  const workingDirectory = command.working_directory;
  console.log(`[BugExecutor] Using command working_directory: ${workingDirectory}`);

  if (!memoryId) {
    throw new Error("Bug execution requires payload.memory_id");
  }

  if (!commitmentId) {
    throw new Error("Bug execution requires commitment_id");
  }

  // Step 1: Fetch bug memory
  console.log(`[BugExecutor] Fetching bug memory ${memoryId}`);
  const bugMemory = await this.fetchBugMemory(command.workspace_id, memoryId);
  if (!bugMemory) {
    throw new Error(`Bug memory ${memoryId} not found`);
  }

  // Step 2: Auditor - craft scoped boundaries (still headless, returns JSON)
  console.log(`[BugExecutor] Crafting audit boundaries via Auditor`);
  const audit = await this.craftAudit(bugMemory, workingDirectory);
  console.log(`[BugExecutor] Auditor hypothesis: ${audit.context.hypothesis}`);

  // Step 3: Write context file for Claude to read
  console.log(`[BugExecutor] Writing bug context file`);
  const contextPath = await writeBugContext({
    commitmentId,
    audit,
    workingDirectory
  });
  console.log(`[BugExecutor] Context written to: ${contextPath}`);

  // Step 4: Spawn Claude in terminal mode
  // Claude will claim, fix, capture evidence, and close
  console.log(`[BugExecutor] Spawning terminal executor in ${workingDirectory}`);
  const result = await this.spawnTerminalExecutor(workingDirectory, commitmentId, timeoutSeconds, command.id);

  // Step 5: Store result in bridge_commands.result
  const { error: updateError } = await this.supabase
    .from("bridge_commands")
    .update({ result: { audit, execution: result } })
    .eq("id", command.id)
    .select();

  if (updateError) {
    console.error(`[BugExecutor] Failed to store result for ${command.id}:`, updateError);
  } else {
    console.log(`[BugExecutor] Result stored for ${command.id}`);
  }

  // NOTE: Bridge does NOT claim or close
  // Claude is expected to do this via mentu CLI
  return result;
}
```

**Add import at top of file**:
```typescript
import { writeBugContext } from './context-writer.js';
```

**Verification**:
```bash
npx tsc --noEmit
```

---

### Stage 3: Add spawnTerminalExecutor Method

Add a new method to spawn Claude in terminal mode.

**File**: `src/bug-executor.ts`

Add this method to the BugExecutor class:

```typescript
/**
 * Spawn Claude in terminal mode.
 *
 * Claude runs IN the workspace with full tool access and mentu CLI.
 * Bridge's job is done after spawning - Claude handles claim/close.
 */
private async spawnTerminalExecutor(
  workingDirectory: string,
  commitmentId: string,
  timeoutSeconds: number,
  commandId: string
): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const prompt = `You are fixing a bug for commitment ${commitmentId}.

Read .mentu/bug-context.md for full instructions.

Key steps:
1. mentu claim ${commitmentId}
2. Fix the bug (you have Read, Edit, Bash, Grep, Glob)
3. Verify your fix
4. mentu capture "Fixed: <summary>" --kind evidence
5. mentu close ${commitmentId} --evidence <mem_id>

When complete, output JSON:
{"success": true, "summary": "what you did", "files_changed": ["file.ts"]}`;

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
      }
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      console.log(`[Executor] ${chunk.trim()}`);
    });

    proc.stderr.on("data", (data) => {
      const chunk = data.toString();
      stderr += chunk;
      console.error(`[Executor:stderr] ${chunk.trim()}`);
    });

    proc.on("close", (code) => {
      const exitCode = code ?? 1;
      console.log(`[BugExecutor] Claude exited with code ${exitCode}`);

      // Try to extract JSON result from output
      const jsonMatch = stdout.match(/\{[\s\S]*?"success"[\s\S]*?\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          resolve({
            success: parsed.success ?? (exitCode === 0),
            summary: parsed.summary ?? stdout.slice(-500),
            files_changed: parsed.files_changed ?? [],
            tests_passed: parsed.tests_passed ?? false,
            exit_code: exitCode,
            output: stdout
          });
          return;
        } catch {
          // Fall through to default
        }
      }

      resolve({
        success: exitCode === 0,
        summary: stdout.slice(-1000) || stderr.slice(-500) || "No output",
        files_changed: [],
        tests_passed: false,
        exit_code: exitCode,
        output: stdout
      });
    });

    proc.on("error", (err) => {
      console.error(`[BugExecutor] Spawn error:`, err);
      resolve({
        success: false,
        summary: `Spawn error: ${err.message}`,
        files_changed: [],
        tests_passed: false,
        exit_code: 1,
        output: stderr
      });
    });
  });
}
```

**Verification**:
```bash
npm run build
```

---

### Stage 4: Remove Old spawnExecutor

The old `spawnExecutor` method (headless JSON-only) is no longer used for bug execution.

**File**: `src/bug-executor.ts`

Either:
1. Rename old `spawnExecutor` to `spawnHeadlessExecutor` (for non-bug commands)
2. Or leave it (it's only used by legacy paths)

The `spawnTerminalExecutor` we created is the new method for bug_execution commands.

**Verification**:
```bash
npm run build
npx tsc --noEmit
```

---

### Stage 5: Deploy and Test

1. **Build**:
```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
npm run build
```

2. **Deploy to VPS**:
```bash
# SyncThing handles this automatically
# Or: rsync -av dist/ mentu@208.167.255.71:/home/mentu/Workspaces/mentu-bridge/dist/
```

3. **Restart bridge on VPS**:
```bash
ssh mentu@208.167.255.71 'sudo systemctl restart mentu-bridge'
```

4. **Test with a new bug report** and observe:
```bash
ssh mentu@208.167.255.71 'journalctl -u mentu-bridge -f'
```

**Expected behavior**:
- `[BugExecutor] Using command working_directory: /correct/path`
- `[BugExecutor] Writing bug context file`
- `[BugExecutor] Spawning terminal executor in /correct/path`
- Claude runs, claims, fixes, closes
- Commitment state changes in ledger (by Claude, not bridge)

---

## Before Submitting

Before running `mentu submit`, spawn validators:

1. Use Task tool with `subagent_type="technical-validator"`

All must return verdict: PASS before submitting.

---

## Completion Phase (REQUIRED)

### Step 1: Create RESULT Document

```bash
# Create: docs/RESULT-TerminalBasedBugExecutor-v1.0.md
```

### Step 2: Capture RESULT as Evidence

```bash
mentu capture "Created RESULT-TerminalBasedBugExecutor: Terminal-based executor implemented" \
  --kind result-document \
  --path docs/RESULT-TerminalBasedBugExecutor-v1.0.md \
  --author-type executor
```

### Step 3: Submit with Evidence

```bash
mentu submit cmt_XXXXXXXX \
  --summary "Implemented terminal-based bug executor. Bridge is now infrastructure, Claude is actor." \
  --include-files
```

---

## Verification Checklist

### Files
- [ ] `src/context-writer.ts` exists
- [ ] `src/bug-executor.ts` modified with new spawnTerminalExecutor

### Checks
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes

### Mentu
- [ ] Commitment claimed
- [ ] Technical validator passed
- [ ] RESULT document created
- [ ] Commitment submitted

### Functionality
- [ ] Bug execution uses command.working_directory (not workspace config)
- [ ] Context file written to .mentu/bug-context.md
- [ ] Claude spawns in terminal mode with correct cwd
- [ ] Claude claims and closes (not bridge)

---

*Bridge becomes infrastructure. Claude becomes actor. The Dual Triad is restored.*
