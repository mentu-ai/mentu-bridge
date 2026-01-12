/**
 * Prompt Builder - Constructs rich prompts for autonomous bug execution
 *
 * This module provides:
 * 1. /craft command detection and parsing
 * 2. Rich bug context formatting
 * 3. Executor prompt generation for HANDOFF execution
 * 4. Legacy execution prompt generation for scheduled commitments
 */

// =============================================================================
// BUG CONTEXT TYPES
// =============================================================================

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

// =============================================================================
// CRAFT COMMAND DETECTION
// =============================================================================

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

// =============================================================================
// CRAFT PROMPT BUILDING
// =============================================================================

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
export function buildCraftExecutorPrompt(
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

// =============================================================================
// LEGACY EXECUTION PROMPT (for scheduled commitments)
// =============================================================================

interface Commitment {
  id: string;
  body: string;
  source: string;
  meta?: {
    due_at?: string;
    requires?: string[];
    instructions?: string;
    timeout?: number;
    working_directory?: string;
  };
}

interface Memory {
  id: string;
  body: string;
  kind: string | null;
  ts: string;
}

const EXECUTION_TEMPLATE = `
# Autonomous Execution Context

You are executing a commitment headlessly. No human is present.

## Commitment
**ID**: {commitment_id}
**Body**: {commitment_body}
**Due**: {due_at}

## Origin
{source_body}
(kind: {source_kind}, created: {source_ts})

## Environment
- Working directory: {working_directory}
- Available: {requires}

## Instructions
{instructions}

## Protocol
1. Read context (CLAUDE.md, relevant files)
2. Plan approach
3. Execute
4. Verify
5. Capture evidence: **what you did** + **what the result was**
6. Close the commitment with evidence

## Constraints
- You CANNOT ask clarifying questions
- If ambiguous, make reasonable assumptions and document them
- If blocked, capture escalation memory and STOP
- Do not exceed {timeout} minutes
- You MUST close the commitment before exiting

## Mentu API

**Base URL**: {proxy_url}
**Auth Header**: X-Proxy-Token: {proxy_token}

### Capture Evidence (required before closing)
\`\`\`
POST {proxy_url}/ops
Content-Type: application/json
X-Proxy-Token: {proxy_token}

{"op": "capture", "body": "What you accomplished and the evidence", "kind": "evidence"}
\`\`\`
Returns: {"id": "mem_XXXXXXXX", ...}

### Close Commitment (final step)
\`\`\`
POST {proxy_url}/ops
Content-Type: application/json
X-Proxy-Token: {proxy_token}

{"op": "close", "commitment": "{commitment_id}", "evidence": "mem_XXXXXXXX"}
\`\`\`

**Important**: You MUST capture evidence first, then use the returned mem_ID to close.

Begin.
`.trim();

export function buildExecutionPrompt(
  commitment: Commitment,
  source: Memory | null,
  config?: { mentu?: { proxy_url?: string; api_key?: string } }
): string {
  const template = EXECUTION_TEMPLATE;

  const replacements: Record<string, string> = {
    commitment_id: commitment.id,
    commitment_body: commitment.body,
    due_at: commitment.meta?.due_at || 'immediate',
    source_body: source?.body || '(no source memory)',
    source_kind: source?.kind || 'unknown',
    source_ts: source?.ts || 'unknown',
    working_directory: commitment.meta?.working_directory || process.cwd(),
    requires: commitment.meta?.requires?.join(', ') || 'standard tools',
    instructions: commitment.meta?.instructions || 'Execute the commitment as described.',
    timeout: String(commitment.meta?.timeout || 30),
    proxy_url: config?.mentu?.proxy_url || 'https://mentu-proxy.affihub.workers.dev',
    proxy_token: config?.mentu?.api_key || '<TOKEN_NOT_PROVIDED>',
  };

  let result = template;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value);
  }

  return result;
}
