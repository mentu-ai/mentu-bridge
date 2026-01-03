import { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import { spawn } from 'child_process';
import type { Command, ExecutionResult, BridgeConfig } from './types.js';

export class ApprovalHandler {
  private supabase: SupabaseClient;
  private config: BridgeConfig;
  private channels: Map<string, RealtimeChannel> = new Map();
  private log: (message: string) => void;

  constructor(
    supabase: SupabaseClient,
    config: BridgeConfig,
    logger: (message: string) => void
  ) {
    this.supabase = supabase;
    this.config = config;
    this.log = logger;
  }

  /**
   * Subscribe to approval events for a specific command
   */
  async waitForApproval(command: Command): Promise<'approved' | 'rejected' | 'timeout'> {
    return new Promise((resolve) => {
      const timeoutMs = 24 * 60 * 60 * 1000; // 24 hours
      let resolved = false;

      // Set timeout
      const timeout = setTimeout(async () => {
        if (!resolved) {
          resolved = true;
          await this.cleanup(command.id);
          resolve('timeout');
        }
      }, timeoutMs);

      // Subscribe to changes on this command
      const channel = this.supabase
        .channel(`approval-${command.id}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'bridge_commands',
            filter: `id=eq.${command.id}`,
          },
          async (payload) => {
            const updated = payload.new as Command;
            if (updated.approval_status === 'approved' || updated.approval_status === 'rejected') {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                await this.cleanup(command.id);
                resolve(updated.approval_status);
              }
            }
          }
        )
        .subscribe();

      this.channels.set(command.id, channel);
    });
  }

  /**
   * Execute the on_approve action
   */
  async executeOnApprove(command: Command): Promise<ExecutionResult> {
    if (!command.on_approve) {
      return { status: 'success', exit_code: 0, stdout: 'No on_approve action', stderr: '' };
    }

    return new Promise((resolve) => {
      this.log(`Executing on_approve: ${command.on_approve}`);

      const child = spawn('/bin/bash', ['-c', command.on_approve!], {
        cwd: command.working_directory,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        resolve({
          status: code === 0 ? 'success' : 'failed',
          exit_code: code ?? 1,
          stdout,
          stderr,
        });
      });

      child.on('error', (error) => {
        resolve({
          status: 'failed',
          exit_code: 1,
          stdout,
          stderr,
          error_message: error.message,
        });
      });
    });
  }

  private async cleanup(commandId: string): Promise<void> {
    const channel = this.channels.get(commandId);
    if (channel) {
      await this.supabase.removeChannel(channel);
      this.channels.delete(commandId);
    }
  }

  async dispose(): Promise<void> {
    for (const [id] of this.channels) {
      await this.cleanup(id);
    }
  }
}
