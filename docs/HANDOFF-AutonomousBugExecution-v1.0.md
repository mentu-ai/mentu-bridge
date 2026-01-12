---
# ============================================================
# CANONICAL YAML FRONT MATTER
# ============================================================
id: HANDOFF-AutonomousBugExecution-v1.0
path: docs/HANDOFF-AutonomousBugExecution-v1.0.md
type: handoff
intent: execute

version: "1.0"
created: 2026-01-12
last_updated: 2026-01-12

tier: T2
author_type: executor

parent: PRD-AutonomousBugExecution-v1.0
children:
  - PROMPT-AutonomousBugExecution-v1.0

mentu:
  commitment: cmt_6268618f
  status: pending

validation:
  required: true
  tier: T2
---

# HANDOFF: AutonomousBugExecution v1.0 (mentu-bridge)

## For the Coding Agent

Extend the bug-executor to support /craft integration for autonomous bug fixing. When a bridge command contains a /craft prompt, the executor should run the full craft workflow (PRD → HANDOFF → PROMPT → execute) and chain agents through the process.

**Read the full PRD**: `/Users/rashid/Desktop/Workspaces/mentu-web/docs/PRD-AutonomousBugExecution-v1.0.md`

---

## Your Identity

| Dimension | Source | Value |
|-----------|--------|-------|
| **Actor** | Repository manifest | (auto-resolved from .mentu/manifest.yaml) |
| **Author Type** | This HANDOFF | executor |
| **Context** | Working directory | mentu-bridge |

**Your domain**: technical

---

## Cross-Repo Context

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  THIS HANDOFF (mentu-bridge)                                                 │
│  ───────────────────────────                                                 │
│  • /craft prompt detection and parsing                                       │
│  • Agent chaining logic (Architect → Auditor → Executor)                    │
│  • Rich bug context injection into prompts                                   │
│  • RESULT document creation and evidence capture                            │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  DEPENDENCY: mentu-proxy                                                     │
│  Creates bridge_command with /craft prompt and bug context                  │
│                                                                              │
├─────────────────────────────────────────────────────────────────────────────┤
│  DEPENDENCY: mentu-web                                                       │
│  UI for triggering and monitoring executions                                │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Completion Contract

**First action**: Update `.claude/completion.json`:

```json
{
  "version": "2.0",
  "name": "AutonomousBugExecution-v1.0 (mentu-bridge)",
  "tier": "T2",
  "required_files": [
    "src/craft-executor.ts",
    "src/bug-executor.ts",
    "src/prompt-builder.ts"
  ],
  "checks": {
    "tsc": true,
    "build": true,
    "test": false
  },
  "mentu": {
    "enabled": true,
    "commitments": {
      "mode": "dynamic",
      "min_count": 1,
      "require_closed": true,
      "require_evidence": true
    }
  },
  "max_iterations": 75
}
```

---

## Build Order

### Stage 1: Prompt Builder

Create a module to build rich prompts with bug context.

**File**: `src/prompt-builder.ts`

```typescript
/**
 * Prompt Builder - Constructs rich prompts for autonomous bug execution
 */

export interface BugContext {
  ticketId: string;
  title: string;
  description: string;
  severity: string;
  screenshotUrl?: string;
  consoleLogs?: Array<{ level: string; message: string; timestamp: number }>;
  behaviorTrace?: Array<{ type: string; target?: string; timestamp: number }>;
  environment?: {
    page_url?: string;
    browser?: string;
    os?: string;
    viewport?: string;
  };
  commitmentId: string;
}

/**
 * Detect if a prompt is a /craft command
 */
export function isCraftPrompt(prompt: string): boolean {
  return prompt.trim().startsWith('/craft');
}

/**
 * Parse the feature name from a /craft command
 */
export function parseCraftFeatureName(prompt: string): string | null {
  const match = prompt.match(/^\/craft\s+(\S+)/);
  return match ? match[1] : null;
}

/**
 * Build a /craft prompt with full bug context
 */
export function buildCraftPrompt(bugContext: BugContext): string {
  const bugId = bugContext.ticketId.slice(0, 8);
  const featureName = `BugFix-${bugId}-v1.0`;

  let prompt = `/craft ${featureName}

## Bug Context

**Commitment ID**: ${bugContext.commitmentId}
**Ticket ID**: ${bugContext.ticketId}
**Severity**: ${bugContext.severity.toUpperCase()}

### Title
${bugContext.title}

### Description
${bugContext.description}

### Environment
- Page URL: ${bugContext.environment?.page_url || 'N/A'}
- Browser: ${bugContext.environment?.browser || 'N/A'}
- OS: ${bugContext.environment?.os || 'N/A'}
- Viewport: ${bugContext.environment?.viewport || 'N/A'}
`;

  if (bugContext.screenshotUrl) {
    prompt += `
### Screenshot
![Bug Screenshot](${bugContext.screenshotUrl})
`;
  }

  if (bugContext.consoleLogs && bugContext.consoleLogs.length > 0) {
    const recentLogs = bugContext.consoleLogs.slice(-15);
    prompt += `
### Console Logs (${bugContext.consoleLogs.length} total, showing last 15)
\`\`\`
${recentLogs.map((log) => `[${log.level.toUpperCase()}] ${log.message}`).join('\n')}
\`\`\`
`;
  }

  if (bugContext.behaviorTrace && bugContext.behaviorTrace.length > 0) {
    const recentEvents = bugContext.behaviorTrace.slice(-10);
    prompt += `
### Behavior Trace (${bugContext.behaviorTrace.length} events, showing last 10)
${recentEvents.map((e) => `- ${e.type}: ${typeof e.target === 'string' ? e.target : JSON.stringify(e.target)}`).join('\n')}
`;
  }

  prompt += `
## Execution Instructions

This is an autonomous bug fix execution. Follow this workflow:

1. **Architect Phase**: Analyze the bug and create a PRD with:
   - Root cause hypothesis
   - Files likely involved
   - Success criteria for the fix

2. **Auditor Phase**: Validate the PRD and create HANDOFF with:
   - Step-by-step implementation plan
   - Verification commands
   - Risk assessment

3. **Executor Phase**: Implement the fix:
   - Create worktree for isolation
   - Make minimal, focused changes
   - Run tests to verify fix
   - Capture evidence

4. **Closure Phase**:
   - Create RESULT document
   - Capture as evidence
   - Close commitment ${bugContext.commitmentId}

## Constraints

- DO NOT modify unrelated files
- Keep changes minimal and focused
- All changes must pass tsc and build
- Create git commits with descriptive messages
- If tests exist, they must pass
`;

  return prompt;
}

/**
 * Build the executor prompt that runs after /craft creates the HANDOFF
 */
export function buildExecutorPrompt(
  handoffPath: string,
  commitmentId: string,
  workingDirectory: string
): string {
  return `# IDENTITY
Your actor identity comes from the repository manifest (.mentu/manifest.yaml).
Your role (author_type) is executor.

# COGNITIVE STANCE
Your domain: TECHNICAL
Fix technical failures, defer on intent/safety.

# MISSION
Execute the bug fix as specified in the HANDOFF.

# PROTOCOL
1. Read .mentu/manifest.yaml for actor identity
2. Read ${handoffPath} for complete instructions
3. Claim commitment: mentu claim ${commitmentId} --author-type executor
4. Execute each build stage
5. Verify with tsc and build
6. Create RESULT document
7. Capture evidence: mentu capture "Created RESULT" --kind result-document
8. Submit: mentu submit ${commitmentId} --summary "Bug fix completed" --include-files

# CONTEXT
Working directory: ${workingDirectory}
Commitment: ${commitmentId}
HANDOFF: ${handoffPath}

# CONSTRAINTS
- Stay within the worktree
- Only modify files specified in HANDOFF
- All changes must compile
`;
}
```

**Verification**:
```bash
npx tsc --noEmit src/prompt-builder.ts
```

---

### Stage 2: Craft Executor

Create a specialized executor for /craft commands that chains agents.

**File**: `src/craft-executor.ts`

```typescript
/**
 * Craft Executor - Handles /craft commands with agent chaining
 *
 * Flow:
 * 1. Detect /craft in prompt
 * 2. Run Architect agent (creates PRD)
 * 3. Run Auditor agent (creates HANDOFF)
 * 4. Run Executor agent (implements fix)
 * 5. Capture evidence and close commitment
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SupabaseClient } from '@supabase/supabase-js';
import { OutputStreamer } from './output-streamer.js';
import {
  isCraftPrompt,
  parseCraftFeatureName,
  buildExecutorPrompt
} from './prompt-builder.js';

export interface CraftExecutionResult {
  success: boolean;
  phase: 'architect' | 'auditor' | 'executor' | 'complete';
  prdPath?: string;
  handoffPath?: string;
  resultPath?: string;
  error?: string;
  output: string;
}

export class CraftExecutor {
  private supabase: SupabaseClient;
  private workspaceId: string;

  constructor(supabase: SupabaseClient, workspaceId: string) {
    this.supabase = supabase;
    this.workspaceId = workspaceId;
  }

  /**
   * Check if this is a /craft command
   */
  isCraftCommand(prompt: string): boolean {
    return isCraftPrompt(prompt);
  }

  /**
   * Execute a /craft command with full agent chaining
   */
  async execute(
    prompt: string,
    workingDirectory: string,
    commitmentId: string,
    streamer: OutputStreamer,
    timeoutSeconds: number = 3600
  ): Promise<CraftExecutionResult> {
    const featureName = parseCraftFeatureName(prompt);
    if (!featureName) {
      return {
        success: false,
        phase: 'architect',
        error: 'Could not parse feature name from /craft command',
        output: '',
      };
    }

    streamer.write('stdout', `[CraftExecutor] Starting /craft workflow for ${featureName}\n`);

    // Phase 1: Architect - Create PRD
    streamer.write('stdout', `[CraftExecutor] Phase 1: Architect (creating PRD)\n`);
    const architectResult = await this.runAgent(
      this.buildArchitectPrompt(prompt, featureName, workingDirectory),
      workingDirectory,
      streamer,
      timeoutSeconds / 3
    );

    if (!architectResult.success) {
      return {
        success: false,
        phase: 'architect',
        error: `Architect phase failed: ${architectResult.error}`,
        output: architectResult.output,
      };
    }

    const prdPath = `docs/PRD-${featureName}.md`;
    if (!fs.existsSync(path.join(workingDirectory, prdPath))) {
      return {
        success: false,
        phase: 'architect',
        error: `PRD not created at ${prdPath}`,
        output: architectResult.output,
      };
    }

    // Phase 2: Auditor - Create HANDOFF
    streamer.write('stdout', `[CraftExecutor] Phase 2: Auditor (creating HANDOFF)\n`);
    const auditorResult = await this.runAgent(
      this.buildAuditorPrompt(prdPath, featureName, workingDirectory),
      workingDirectory,
      streamer,
      timeoutSeconds / 3
    );

    if (!auditorResult.success) {
      return {
        success: false,
        phase: 'auditor',
        prdPath,
        error: `Auditor phase failed: ${auditorResult.error}`,
        output: architectResult.output + auditorResult.output,
      };
    }

    const handoffPath = `docs/HANDOFF-${featureName}.md`;
    if (!fs.existsSync(path.join(workingDirectory, handoffPath))) {
      return {
        success: false,
        phase: 'auditor',
        prdPath,
        error: `HANDOFF not created at ${handoffPath}`,
        output: architectResult.output + auditorResult.output,
      };
    }

    // Phase 3: Executor - Implement the fix
    streamer.write('stdout', `[CraftExecutor] Phase 3: Executor (implementing fix)\n`);
    const executorPrompt = buildExecutorPrompt(handoffPath, commitmentId, workingDirectory);
    const executorResult = await this.runAgent(
      executorPrompt,
      workingDirectory,
      streamer,
      timeoutSeconds / 3
    );

    const resultPath = `docs/RESULT-${featureName}.md`;
    const resultExists = fs.existsSync(path.join(workingDirectory, resultPath));

    return {
      success: executorResult.success && resultExists,
      phase: 'complete',
      prdPath,
      handoffPath,
      resultPath: resultExists ? resultPath : undefined,
      error: executorResult.success ? undefined : executorResult.error,
      output: architectResult.output + auditorResult.output + executorResult.output,
    };
  }

  /**
   * Build the Architect agent prompt
   */
  private buildArchitectPrompt(
    originalPrompt: string,
    featureName: string,
    workingDirectory: string
  ): string {
    return `# IDENTITY
You are the Architect agent. Your job is to analyze bugs and create PRDs.

# MISSION
Analyze the bug described below and create a PRD document.

# ORIGINAL PROMPT
${originalPrompt}

# DELIVERABLE
Create: docs/PRD-${featureName}.md

The PRD must include:
1. Problem statement with current vs desired state
2. Root cause hypothesis
3. Files likely involved (search the codebase)
4. Success criteria
5. Constraints

# PROTOCOL
1. Search the codebase for relevant files
2. Analyze the bug context
3. Create the PRD document
4. Verify the PRD has valid YAML front matter

# CONSTRAINTS
- Only create the PRD, do not implement
- Focus on analysis and planning
- Working directory: ${workingDirectory}
`;
  }

  /**
   * Build the Auditor agent prompt
   */
  private buildAuditorPrompt(
    prdPath: string,
    featureName: string,
    workingDirectory: string
  ): string {
    return `# IDENTITY
You are the Auditor agent. Your job is to validate PRDs and create HANDOFFs.

# MISSION
Read the PRD and create a detailed HANDOFF document.

# INPUT
PRD: ${prdPath}

# DELIVERABLE
Create: docs/HANDOFF-${featureName}.md

The HANDOFF must include:
1. Build order with concrete stages
2. Code snippets for each stage
3. Verification commands
4. Completion contract with required files
5. Mentu integration (commitment claim, capture, submit)

# PROTOCOL
1. Read the PRD thoroughly
2. Verify the analysis is correct
3. Create the HANDOFF with actionable steps
4. Ensure all code is copy-paste ready

# CONSTRAINTS
- Only create the HANDOFF, do not implement
- Focus on making instructions clear and executable
- Working directory: ${workingDirectory}
`;
  }

  /**
   * Run a single agent with the given prompt
   */
  private runAgent(
    prompt: string,
    workingDirectory: string,
    streamer: OutputStreamer,
    timeoutMs: number
  ): Promise<{ success: boolean; output: string; error?: string }> {
    return new Promise((resolve) => {
      const args = [
        '--dangerously-skip-permissions',
        '--max-turns', '50',
        '-p', prompt
      ];

      const proc = spawn('claude', args, {
        cwd: workingDirectory,
        timeout: timeoutMs * 1000,
        env: { ...process.env }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        const chunk = data.toString();
        stdout += chunk;
        streamer.write('stdout', chunk);
      });

      proc.stderr.on('data', (data) => {
        const chunk = data.toString();
        stderr += chunk;
        streamer.write('stderr', chunk);
      });

      proc.on('close', (code) => {
        resolve({
          success: code === 0,
          output: stdout,
          error: code !== 0 ? stderr || `Exit code: ${code}` : undefined,
        });
      });

      proc.on('error', (err) => {
        resolve({
          success: false,
          output: stdout,
          error: err.message,
        });
      });
    });
  }
}
```

**Verification**:
```bash
npx tsc --noEmit src/craft-executor.ts
```

---

### Stage 3: Integrate CraftExecutor into BugExecutor

Update bug-executor.ts to use CraftExecutor for /craft commands.

**File**: `src/bug-executor.ts`

Add import at the top:
```typescript
import { CraftExecutor } from './craft-executor.js';
import { isCraftPrompt } from './prompt-builder.js';
```

Add class property:
```typescript
private craftExecutor: CraftExecutor;
```

Initialize in constructor:
```typescript
this.craftExecutor = new CraftExecutor(supabase, workspaceId);
```

Modify `runClaudeCommand` method to detect /craft and use CraftExecutor:

```typescript
private async runClaudeCommand(
  command: BridgeCommand,
  execDir: string,
  streamer: OutputStreamer
): Promise<ExecutionResult> {
  // Check if this is a /craft command
  if (isCraftPrompt(command.prompt) && command.commitment_id) {
    console.log(`[BugExecutor] Detected /craft command, using CraftExecutor`);

    const craftResult = await this.craftExecutor.execute(
      command.prompt,
      execDir,
      command.commitment_id,
      streamer,
      command.timeout_seconds || 3600
    );

    return {
      success: craftResult.success,
      summary: craftResult.success
        ? `Craft workflow completed. PRD: ${craftResult.prdPath}, HANDOFF: ${craftResult.handoffPath}, RESULT: ${craftResult.resultPath}`
        : `Craft workflow failed at ${craftResult.phase}: ${craftResult.error}`,
      files_changed: [
        craftResult.prdPath,
        craftResult.handoffPath,
        craftResult.resultPath
      ].filter(Boolean) as string[],
      tests_passed: craftResult.success,
      exit_code: craftResult.success ? 0 : 1,
      output: craftResult.output,
    };
  }

  // Original implementation for non-craft commands
  return new Promise<ExecutionResult>((resolve) => {
    // ... existing code ...
  });
}
```

**Verification**:
```bash
npm run build
```

---

### Stage 4: Update Exports

**File**: `src/index.ts`

Add exports for new modules:

```typescript
export { CraftExecutor } from './craft-executor.js';
export {
  buildCraftPrompt,
  buildExecutorPrompt,
  isCraftPrompt,
  parseCraftFeatureName,
  type BugContext
} from './prompt-builder.js';
```

---

## Verification Checklist

### Files
- [ ] `src/prompt-builder.ts` exists
- [ ] `src/craft-executor.ts` exists
- [ ] `src/bug-executor.ts` updated with CraftExecutor integration

### Checks
- [ ] `npm run build` passes
- [ ] `npx tsc --noEmit` passes

### Mentu
- [ ] Commitment claimed
- [ ] RESULT document created
- [ ] Commitment submitted

### Functionality
- [ ] /craft commands detected correctly
- [ ] Architect agent creates PRD
- [ ] Auditor agent creates HANDOFF
- [ ] Executor agent implements fix
- [ ] RESULT document created
- [ ] Commitment closed with evidence

---

## Completion Phase (REQUIRED)

**BEFORE calling `mentu submit`, you MUST create a RESULT document:**

```bash
# Create: docs/RESULT-AutonomousBugExecution-v1.0.md

mentu capture "Created RESULT-AutonomousBugExecution: /craft integration with agent chaining" \
  --kind result-document \
  --path docs/RESULT-AutonomousBugExecution-v1.0.md \
  --author-type executor

mentu submit cmt_XXXXXXXX \
  --summary "Implemented /craft integration: prompt builder, craft executor, agent chaining" \
  --include-files
```

---

*Agent chaining for autonomous bug execution: Architect → Auditor → Executor.*
