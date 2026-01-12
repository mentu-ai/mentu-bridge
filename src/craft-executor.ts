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
  buildCraftExecutorPrompt
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
      Math.floor(timeoutSeconds / 3) * 1000
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
      Math.floor(timeoutSeconds / 3) * 1000
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
    const executorPrompt = buildCraftExecutorPrompt(handoffPath, commitmentId, workingDirectory);
    const executorResult = await this.runAgent(
      executorPrompt,
      workingDirectory,
      streamer,
      Math.floor(timeoutSeconds / 3) * 1000
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
        timeout: timeoutMs,
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
