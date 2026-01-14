/**
 * Terminal-based Bug Executor
 *
 * Philosophy: Bridge becomes infrastructure, Claude becomes actor.
 *
 * This executor:
 * 1. Writes bug-context.md in the working directory with all bug info
 * 2. Spawns Claude in terminal mode with mentu CLI access
 * 3. Claude is responsible for fixing the bug AND closing the commitment
 *
 * The bridge does NOT:
 * - Parse Claude output for JSON
 * - Close commitments on Claude's behalf
 * - Make decisions about success/failure
 *
 * Claude has:
 * - Full filesystem access
 * - mentu CLI for capture/close/annotate
 * - Authority to close the commitment with evidence
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { BridgeConfig } from "./types.js";

export interface TerminalBugResult {
  success: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  context_file_path: string;
  duration_ms: number;
}

export interface BugCommandPayload {
  memory_id: string;
  commitment_id?: string;
  timeout_seconds?: number;
}

export interface TerminalBugCommand {
  id: string;
  workspace_id: string;
  working_directory: string;
  payload: BugCommandPayload;
  timeout_seconds?: number;
}

/**
 * Fetch bug memory from operations table
 */
async function fetchBugMemory(
  supabase: SupabaseClient,
  workspaceId: string,
  memoryId: string
): Promise<{ id: string; payload: Record<string, unknown> } | null> {
  const { data, error } = await supabase
    .from("operations")
    .select("id, op, payload")
    .eq("id", memoryId)
    .eq("workspace_id", workspaceId)
    .single();

  if (error || !data) {
    console.error(`[TerminalBugExecutor] Failed to fetch memory ${memoryId}:`, error);
    return null;
  }

  return data as { id: string; payload: Record<string, unknown> };
}

/**
 * Extract essential info from bug payload for bug-context.md
 */
function extractBugContext(memory: { id: string; payload: Record<string, unknown> }): string {
  const payload = memory.payload || {};
  const body = (payload.body as string) || '';
  const meta = (payload.meta as Record<string, unknown>) || {};
  const kind = (payload.kind as string) || 'bug';

  let context = `# Bug Context

**Memory ID**: ${memory.id}
**Kind**: ${kind}

## Description

${body}

## Metadata
`;

  // Add available metadata
  if (meta.page_url) context += `- **Page URL**: ${meta.page_url}\n`;
  if (meta.element_text) context += `- **Element**: ${meta.element_text}\n`;
  if (meta.element_tag) context += `- **Element Tag**: ${meta.element_tag}\n`;
  if (meta.browser) context += `- **Browser**: ${meta.browser}\n`;
  if (meta.os) context += `- **OS**: ${meta.os}\n`;
  if (meta.viewport) context += `- **Viewport**: ${meta.viewport}\n`;
  if (meta.screenshot_url) context += `- **Screenshot**: ${meta.screenshot_url}\n`;

  // Add console errors if present
  const consoleErrors = meta.console_errors as Array<{ level: string; message: string }> | undefined;
  if (consoleErrors && consoleErrors.length > 0) {
    context += `\n## Console Errors\n\n`;
    context += '```\n';
    for (const err of consoleErrors.slice(-20)) {
      context += `[${err.level}] ${err.message}\n`;
    }
    context += '```\n';
  }

  // Add behavior trace if present
  const behaviorTrace = meta.behavior_trace as Array<{ type: string; target?: string }> | undefined;
  if (behaviorTrace && behaviorTrace.length > 0) {
    context += `\n## User Actions\n\n`;
    for (const action of behaviorTrace.slice(-15)) {
      context += `- ${action.type}${action.target ? `: ${action.target}` : ''}\n`;
    }
  }

  return context;
}

/**
 * Build the prompt for terminal-based bug execution.
 * Claude receives the context file path and has full autonomy.
 */
function buildTerminalPrompt(
  contextFilePath: string,
  commitmentId: string | undefined,
  workingDirectory: string,
  config: BridgeConfig
): string {
  const proxyUrl = config.mentu.proxy_url;
  const proxyToken = config.mentu.api_key;

  return `# Bug Fix Execution

You are executing a bug fix in terminal mode with full autonomy.

## Context

Read the bug details from: ${contextFilePath}

## Working Directory

${workingDirectory}

## Your Authority

You have:
- Full filesystem access (Read, Edit, Write, Glob, Grep, Bash)
- mentu CLI for ledger operations
- Authority to close the commitment when done

## Protocol

1. **Read** the bug-context.md file to understand the issue
2. **Investigate** - use grep, glob, read to find relevant code
3. **Plan** your fix approach
4. **Implement** the fix with minimal, focused changes
5. **Verify** - run tests, tsc, or appropriate verification
6. **Capture evidence** of what you did:
   \`\`\`
   POST ${proxyUrl}/ops
   Content-Type: application/json
   X-Proxy-Token: ${proxyToken}

   {"op": "capture", "body": "Description of fix and verification", "kind": "evidence"}
   \`\`\`
7. **Close the commitment** (if commitment_id is provided):
   \`\`\`
   POST ${proxyUrl}/ops
   Content-Type: application/json
   X-Proxy-Token: ${proxyToken}

   {"op": "close", "commitment": "${commitmentId || 'COMMITMENT_ID'}", "evidence": "mem_XXXXXXXX"}
   \`\`\`

${commitmentId ? `## Commitment ID\n\n${commitmentId}\n\nYou MUST close this commitment with evidence when done.` : '## No Commitment\n\nNo commitment ID provided - just fix the bug and capture evidence.'}

## Constraints

- Do NOT ask for clarification - make reasonable assumptions
- Keep changes minimal and focused
- If blocked, capture an escalation memory and stop
- You have ${config.execution.default_timeout_seconds / 60} minutes maximum

## Begin

Read ${contextFilePath} and start fixing the bug.`;
}

/**
 * Execute a bug fix command in terminal mode.
 *
 * This spawns Claude with:
 * - Full tool access
 * - mentu CLI environment
 * - Bug context file in working directory
 */
export async function executeTerminalBugCommand(
  supabase: SupabaseClient,
  command: TerminalBugCommand,
  config: BridgeConfig
): Promise<TerminalBugResult> {
  const startTime = Date.now();
  const workingDirectory = command.working_directory;
  const memoryId = command.payload.memory_id;
  const commitmentId = command.payload.commitment_id;
  const timeoutSeconds = command.payload.timeout_seconds || command.timeout_seconds || config.execution.default_timeout_seconds;

  console.log(`[TerminalBugExecutor] Starting bug execution`);
  console.log(`[TerminalBugExecutor] Working directory: ${workingDirectory}`);
  console.log(`[TerminalBugExecutor] Memory ID: ${memoryId}`);
  console.log(`[TerminalBugExecutor] Commitment ID: ${commitmentId || 'none'}`);

  // Step 1: Fetch bug memory
  const memory = await fetchBugMemory(supabase, command.workspace_id, memoryId);
  if (!memory) {
    return {
      success: false,
      exit_code: 1,
      stdout: '',
      stderr: `Bug memory ${memoryId} not found`,
      context_file_path: '',
      duration_ms: Date.now() - startTime,
    };
  }

  // Step 2: Write bug-context.md to working directory
  const contextContent = extractBugContext(memory);
  const contextFilePath = path.join(workingDirectory, 'bug-context.md');

  try {
    fs.writeFileSync(contextFilePath, contextContent, 'utf-8');
    console.log(`[TerminalBugExecutor] Wrote bug context to ${contextFilePath}`);
  } catch (err) {
    return {
      success: false,
      exit_code: 1,
      stdout: '',
      stderr: `Failed to write bug-context.md: ${err}`,
      context_file_path: '',
      duration_ms: Date.now() - startTime,
    };
  }

  // Step 3: Build prompt for Claude
  const prompt = buildTerminalPrompt(contextFilePath, commitmentId, workingDirectory, config);

  // Step 4: Spawn Claude in terminal mode
  console.log(`[TerminalBugExecutor] Spawning Claude in terminal mode...`);

  const result = await new Promise<TerminalBugResult>((resolve) => {
    const args = [
      '--dangerously-skip-permissions',
      '-p', prompt
    ];

    const proc = spawn('claude', args, {
      cwd: workingDirectory,
      timeout: timeoutSeconds * 1000,
      env: {
        ...process.env,
        // Pass OAuth token for Claude CLI
        ...(process.env.CLAUDE_CODE_OAUTH_TOKEN && {
          CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        }),
        // Pass proxy credentials for mentu operations
        MENTU_PROXY_URL: config.mentu.proxy_url,
        MENTU_PROXY_TOKEN: config.mentu.api_key,
        // Command ID for correlation
        MENTU_BRIDGE_COMMAND_ID: command.id,
      },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      // Log progress
      if (stdout.length % 1000 < chunk.length) {
        console.log(`[TerminalBugExecutor] Output: ${stdout.length} bytes`);
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const exitCode = code ?? 1;
      resolve({
        success: exitCode === 0,
        exit_code: exitCode,
        stdout: stdout.slice(-10000), // Truncate to 10KB
        stderr: stderr.slice(-2000),
        context_file_path: contextFilePath,
        duration_ms: Date.now() - startTime,
      });
    });

    proc.on('error', (err) => {
      resolve({
        success: false,
        exit_code: 1,
        stdout: '',
        stderr: `Spawn error: ${err.message}`,
        context_file_path: contextFilePath,
        duration_ms: Date.now() - startTime,
      });
    });
  });

  console.log(`[TerminalBugExecutor] Completed in ${result.duration_ms}ms with exit code ${result.exit_code}`);

  // Step 5: Cleanup (optional - leave bug-context.md for debugging)
  // fs.unlinkSync(contextFilePath);

  return result;
}

/**
 * Terminal Bug Executor class for integration with BridgeDaemon
 */
export class TerminalBugExecutor {
  private supabase: SupabaseClient;
  private config: BridgeConfig;

  constructor(supabase: SupabaseClient, config: BridgeConfig) {
    this.supabase = supabase;
    this.config = config;
  }

  /**
   * Execute a bug_execution command using the terminal-based approach
   */
  async execute(command: TerminalBugCommand): Promise<TerminalBugResult> {
    return executeTerminalBugCommand(this.supabase, command, this.config);
  }

  /**
   * Stop the executor (no-op for stateless terminal executor)
   */
  async stop(): Promise<void> {
    console.log('[TerminalBugExecutor] Stopped');
  }
}
