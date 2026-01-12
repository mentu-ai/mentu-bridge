/**
 * Output Streamer - Real-time log streaming to spawn_logs table
 *
 * Ported from beacon/output.rs for beacon-parity.
 * Provides 100ms interval streaming of stdout/stderr during execution.
 */

import { SupabaseClient } from "@supabase/supabase-js";

/**
 * OutputStreamer buffers and streams stdout/stderr to spawn_logs table in real-time.
 */
export class OutputStreamer {
  private supabase: SupabaseClient;
  private commandId: string;
  private workspaceId: string;
  private stdoutBuffer: string = "";
  private stderrBuffer: string = "";
  private intervalId?: NodeJS.Timeout;
  private streamInterval = 100; // 100ms flush interval

  constructor(supabase: SupabaseClient, commandId: string, workspaceId: string) {
    this.supabase = supabase;
    this.commandId = commandId;
    this.workspaceId = workspaceId;
  }

  /**
   * Start the streaming interval
   */
  start(): void {
    console.log(`[OutputStreamer] Starting for command ${this.commandId}`);

    this.intervalId = setInterval(() => {
      this.flushBuffers();
    }, this.streamInterval);
  }

  /**
   * Write data to a stream buffer
   */
  write(stream: 'stdout' | 'stderr', data: string): void {
    if (stream === 'stdout') {
      this.stdoutBuffer += data;
    } else {
      this.stderrBuffer += data;
    }
  }

  /**
   * Flush buffered output to database
   */
  private async flushBuffers(): Promise<void> {
    const promises: Promise<void>[] = [];

    if (this.stdoutBuffer) {
      const chunk = this.stdoutBuffer;
      this.stdoutBuffer = "";
      promises.push(this.writeToDb('stdout', chunk));
    }

    if (this.stderrBuffer) {
      const chunk = this.stderrBuffer;
      this.stderrBuffer = "";
      promises.push(this.writeToDb('stderr', chunk));
    }

    await Promise.all(promises);
  }

  /**
   * Write a log entry to spawn_logs table
   */
  private async writeToDb(stream: 'stdout' | 'stderr', message: string): Promise<void> {
    try {
      const { error } = await this.supabase.from('spawn_logs').insert({
        command_id: this.commandId,
        workspace_id: this.workspaceId,
        stream,
        message,
        ts: new Date().toISOString()
      });

      if (error) {
        console.error(`[OutputStreamer] Failed to write to spawn_logs:`, error.message);
      }
    } catch (e) {
      console.error(`[OutputStreamer] Exception writing to spawn_logs:`, e);
    }
  }

  /**
   * Force flush all buffered content
   */
  async flush(): Promise<void> {
    await this.flushBuffers();
  }

  /**
   * Stop streaming and perform final flush
   */
  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    // Final flush
    await this.flushBuffers();

    console.log(`[OutputStreamer] Stopped for command ${this.commandId}`);
  }
}
