import * as fs from 'fs/promises';
import * as path from 'path';
import type { AuditOutput } from './types/audit-output.js';

export interface BugContextOptions {
  commitmentId: string;
  audit: AuditOutput;
  workingDirectory: string;
  apiConfig?: {
    proxyUrl: string;
    apiKey: string;
    workspaceId: string;
    actor: string;
  };
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

${options.apiConfig ? `
**CRITICAL**: Use these curl commands to update the Mentu ledger:

### 1. Claim the commitment
\`\`\`bash
curl -X POST "${options.apiConfig.proxyUrl}/ops" \\
  -H "Content-Type: application/json" \\
  -H "X-Proxy-Token: ${options.apiConfig.apiKey}" \\
  -d '{"op": "claim", "commitment": "${commitmentId}", "actor": "${options.apiConfig.actor}"}'
\`\`\`

### 2. Fix the bug
Use Read, Edit, Bash, Grep, Glob tools.

### 3. Verify your fix works
Run build/test commands as applicable.

### 4. Capture evidence
\`\`\`bash
curl -X POST "${options.apiConfig.proxyUrl}/ops" \\
  -H "Content-Type: application/json" \\
  -H "X-Proxy-Token: ${options.apiConfig.apiKey}" \\
  -d '{"op": "capture", "body": "Fixed: <your summary here>", "kind": "evidence", "workspace_id": "${options.apiConfig.workspaceId}", "actor": "${options.apiConfig.actor}"}'
\`\`\`

Save the returned \`id\` field (e.g., mem_XXXXXXXX).

### 5. Close the commitment
\`\`\`bash
curl -X POST "${options.apiConfig.proxyUrl}/ops" \\
  -H "Content-Type: application/json" \\
  -H "X-Proxy-Token: ${options.apiConfig.apiKey}" \\
  -d '{"op": "close", "commitment": "${commitmentId}", "evidence": "mem_XXXXXXXX", "actor": "${options.apiConfig.actor}"}'
\`\`\`

Replace \`mem_XXXXXXXX\` with the ID from step 4.
` : `
1. Run: \`mentu claim ${commitmentId}\`
2. Fix the bug (you have Read, Edit, Bash, Grep, Glob)
3. Verify your fix works (build, test if applicable)
4. Run: \`mentu capture "Fixed: <summary>" --kind evidence\`
5. Run: \`mentu close ${commitmentId} --evidence mem_XXXXXXXX\`
`}

**Important**: You are the ACTOR. You claim and close the commitment.
`;

  await fs.writeFile(contextPath, content, 'utf-8');
  return contextPath;
}
