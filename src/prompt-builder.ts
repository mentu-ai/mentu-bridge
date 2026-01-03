// Build execution prompts for commitments

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
