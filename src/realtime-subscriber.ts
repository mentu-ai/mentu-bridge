/**
 * Realtime Subscriber - WebSocket subscription to bridge_commands
 *
 * Ported from beacon/supabase.rs for beacon-parity.
 * Provides instant command pickup via Supabase Realtime instead of polling.
 */

import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

export interface BridgeCommand {
  id: string;
  workspace_id: string;
  prompt: string;
  working_directory: string;
  agent: string;
  flags: string[];
  timeout_seconds: number;
  target_machine_id?: string;
  status: 'pending' | 'claimed' | 'running' | 'completed' | 'failed';
  claimed_by_machine_id?: string;
  claimed_at?: string;
  started_at?: string;
  completed_at?: string;
  exit_code?: number;
  output?: string;
  error?: string;
  approval_required: boolean;
  approval_status?: 'pending' | 'approved' | 'rejected';
  with_worktree: boolean;
  commitment_id?: string;
  created_at?: string;
  // Bug execution support
  command_type?: 'spawn' | 'bug_execution';
  payload?: {
    memory_id?: string;
    commitment_id?: string;
    bug_title?: string;
    timeout_seconds?: number;
    approval_mode?: string;
    [key: string]: unknown;
  };
  result?: unknown;
}

export type RealtimeEvent =
  | { type: 'CommandInserted'; command: BridgeCommand }
  | { type: 'CommandUpdated'; command: BridgeCommand }
  | { type: 'Connected' }
  | { type: 'Disconnected' }
  | { type: 'Error'; message: string };

export type EventHandler = (event: RealtimeEvent) => void;

/**
 * RealtimeSubscriber provides WebSocket-based subscription to bridge_commands table.
 * Fires immediately on INSERT/UPDATE, eliminating polling delay.
 */
export class RealtimeSubscriber {
  private supabase: SupabaseClient;
  private workspaceId: string;
  private machineId: string;
  private channel?: RealtimeChannel;
  private handlers: EventHandler[] = [];
  private isConnected = false;

  constructor(supabase: SupabaseClient, workspaceId: string, machineId: string) {
    this.supabase = supabase;
    this.workspaceId = workspaceId;
    this.machineId = machineId;
  }

  /**
   * Register an event handler
   */
  onEvent(handler: EventHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Emit event to all registered handlers
   */
  private emit(event: RealtimeEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (e) {
        console.error("[RealtimeSubscriber] Handler error:", e);
      }
    }
  }

  /**
   * Subscribe to bridge_commands changes for this workspace
   */
  async subscribe(): Promise<void> {
    console.log(`[RealtimeSubscriber] Subscribing to workspace ${this.workspaceId}`);

    this.channel = this.supabase
      .channel(`bridge_commands_${this.workspaceId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'bridge_commands',
          filter: `workspace_id=eq.${this.workspaceId}`
        },
        (payload) => {
          console.log("[RealtimeSubscriber] INSERT received");
          this.emit({
            type: 'CommandInserted',
            command: payload.new as BridgeCommand
          });
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'bridge_commands',
          filter: `workspace_id=eq.${this.workspaceId}`
        },
        (payload) => {
          console.log("[RealtimeSubscriber] UPDATE received");
          this.emit({
            type: 'CommandUpdated',
            command: payload.new as BridgeCommand
          });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log("[RealtimeSubscriber] Connected");
          this.isConnected = true;
          this.emit({ type: 'Connected' });
        } else if (status === 'CLOSED') {
          console.log("[RealtimeSubscriber] Disconnected");
          this.isConnected = false;
          this.emit({ type: 'Disconnected' });
        } else if (status === 'CHANNEL_ERROR') {
          console.error("[RealtimeSubscriber] Channel error");
          this.emit({ type: 'Error', message: 'Channel error' });
        }
      });
  }

  /**
   * Unsubscribe from the channel
   */
  async unsubscribe(): Promise<void> {
    if (this.channel) {
      await this.supabase.removeChannel(this.channel);
      this.channel = undefined;
      this.isConnected = false;
      console.log("[RealtimeSubscriber] Unsubscribed");
    }
  }

  /**
   * Check if currently connected
   */
  getIsConnected(): boolean {
    return this.isConnected;
  }

  /**
   * Get machine ID this subscriber is bound to
   */
  getMachineId(): string {
    return this.machineId;
  }
}
