// Bug Report Orchestrator
// Handles bug-related bridge commands: investigation, analysis, evidence capture

import { SupabaseClient } from '@supabase/supabase-js';
import { ChildProcess, spawn } from 'child_process';

export interface BugCommand {
  id: string;
  workspace_id: string;
  commitment_id: string;
  agent: string;
  prompt: string;
  working_directory: string;
  timeout_seconds: number;
  status: string;
  created_at: string;
}

export interface BugCommandResult {
  command_id: string;
  status: 'success' | 'failed' | 'timeout';
  output: string;
  evidence_id?: string;
}

export class BugOrchestrator {
  private supabase: SupabaseClient;
  private currentProcess: ChildProcess | null = null;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Check if a command is bug-related
   */
  isBugCommand(command: BugCommand): boolean {
    return Boolean(
      command.prompt &&
      (command.prompt.includes('bug') ||
        command.prompt.includes('Bug') ||
        command.prompt.includes('Investigation'))
    );
  }

  /**
   * Claim a bug command atomically
   * Returns true if claimed successfully, false if already claimed
   */
  async claimCommand(commandId: string): Promise<boolean> {
    try {
      const response = await fetch(
        `https://api.supabase.com/rest/v1/bridge_commands?id=eq.${commandId}&status=eq.pending`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
          },
          body: JSON.stringify({
            status: 'claimed',
            claimed_at: new Date().toISOString(),
          }),
        }
      );

      if (!response.ok) {
        return false; // Already claimed
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute Claude agent with investigation prompt
   * Returns the agent's output
   */
  async executeClaudeAgent(prompt: string, workingDirectory: string, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        if (this.currentProcess) {
          this.currentProcess.kill();
        }
        reject(new Error(`Timeout after ${timeout} seconds`));
      }, timeout * 1000);

      const args = [
        '--dangerously-skip-permissions',
        `--max-turns=30`,
      ];

      const env = {
        ...process.env,
        CLAUDE_WORKING_DIR: workingDirectory,
      };

      this.currentProcess = spawn('claude', args, {
        env,
        stdio: 'pipe',
      });

      let output = '';
      let errorOutput = '';

      if (this.currentProcess.stdout) {
        this.currentProcess.stdout.on('data', (data: Buffer) => {
          output += data.toString();
        });
      }

      if (this.currentProcess.stderr) {
        this.currentProcess.stderr.on('data', (data: Buffer) => {
          errorOutput += data.toString();
        });
      }

      if (this.currentProcess.stdin) {
        this.currentProcess.stdin.write(prompt);
        this.currentProcess.stdin.end();
      }

      this.currentProcess.on('close', (code: number | null) => {
        clearTimeout(timeoutHandle);

        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Agent failed with code ${code}: ${errorOutput}`));
        }
      });

      this.currentProcess.on('error', (error: Error) => {
        clearTimeout(timeoutHandle);
        reject(error);
      });
    });
  }

  /**
   * Parse investigation output from Claude
   * Looks for structured findings in the output
   */
  parseInvestigationOutput(
    output: string
  ): {
    is_real_bug: boolean;
    root_cause?: string;
    confidence: number;
    affected_components: string[];
    suggested_fix?: string;
  } {
    // Look for JSON output from Claude
    const jsonMatch = output.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          is_real_bug: parsed.is_real_bug ?? true,
          root_cause: parsed.root_cause,
          confidence: parsed.confidence ?? 0.7,
          affected_components: parsed.affected_components ?? [],
          suggested_fix: parsed.suggested_fix,
        };
      } catch {
        // Fall through to text parsing
      }
    }

    // Fallback: parse from text
    const confidenceMatch = output.match(/confidence[:\s]+([0-9.]+)/i);
    const confidence = confidenceMatch ? parseFloat(confidenceMatch[1]) : 0.7;

    const isBugMatch = output.match(/real\s+bug|is\s+bug|bug\s+confirmed/i);
    const is_real_bug = !!isBugMatch && !output.includes('not a bug');

    return {
      is_real_bug,
      confidence,
      affected_components: [],
    };
  }

  /**
   * Process a bug command end-to-end
   */
  async processBugCommand(command: BugCommand): Promise<BugCommandResult> {
    try {
      // 1. Claim command atomically
      const claimed = await this.claimCommand(command.id);
      if (!claimed) {
        return {
          command_id: command.id,
          status: 'failed',
          output: 'Command already claimed by another machine',
        };
      }

      // 2. Execute Claude agent
      let agentOutput = '';
      try {
        agentOutput = await this.executeClaudeAgent(
          command.prompt,
          command.working_directory,
          command.timeout_seconds
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          command_id: command.id,
          status: error instanceof Error && message.includes('Timeout') ? 'timeout' : 'failed',
          output: message,
        };
      }

      // 3. Parse investigation output
      const investigation = this.parseInvestigationOutput(agentOutput);

      // 4. Capture as evidence memory (optional, for audit trail)
      // This would be done via mentu capture in production
      // For now, we store the result in bridge_results table

      // 5. Return success with evidence
      return {
        command_id: command.id,
        status: 'success',
        output: agentOutput,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        command_id: command.id,
        status: 'failed',
        output: message,
      };
    }
  }

  /**
   * Store command result to Supabase
   */
  async storeCommandResult(
    commandId: string,
    result: BugCommandResult
  ): Promise<void> {
    try {
      await this.supabase.from('bridge_results').insert({
        command_id: commandId,
        status: result.status,
        output: result.output,
        created_at: new Date().toISOString(),
      });
    } catch (error) {
      console.error(`Failed to store command result: ${error}`);
      // Don't throw - command was executed, just couldn't store result
    }
  }
}
