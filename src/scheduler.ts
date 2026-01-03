// Scheduler for polling due commitments

import type { BridgeConfig } from './types.js';

interface Commitment {
  id: string;
  body: string;
  source: string;
  state: string;
  owner: string | null;
  meta?: {
    affinity?: string;
    working_directory?: string;
    due_at?: string;
    requires?: string[];
    instructions?: string;
    timeout?: number;
  };
}

interface Memory {
  id: string;
  body: string;
  kind: string | null;
  ts: string;
}

export interface ExecuteCommitmentEvent {
  commitment: Commitment;
  prompt: string;
  workingDirectory: string;
  timeout: number;
}

export type ExecuteHandler = (event: ExecuteCommitmentEvent) => Promise<void>;

export class CommitmentScheduler {
  private config: BridgeConfig;
  private pollInterval: NodeJS.Timeout | null = null;
  private isProcessing = false;
  private onExecute: ExecuteHandler | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  /**
   * Register handler for commitment execution
   */
  setExecuteHandler(handler: ExecuteHandler): void {
    this.onExecute = handler;
  }

  private log(message: string): void {
    console.log(`[${new Date().toISOString()}] [Scheduler] ${message}`);
  }

  /**
   * Start the polling loop
   */
  start(): void {
    this.log('Starting commitment scheduler');

    // Poll every 60 seconds
    this.pollInterval = setInterval(() => {
      this.tick();
    }, 60_000);

    // Also run immediately
    this.tick();
  }

  /**
   * Stop the polling loop
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.log('Scheduler stopped');
  }

  /**
   * Single tick of the scheduler
   */
  private async tick(): Promise<void> {
    if (this.isProcessing) {
      this.log('Skipping tick - still processing previous batch');
      return;
    }

    this.isProcessing = true;

    try {
      const commitments = await this.fetchDueCommitments();

      if (commitments.length === 0) {
        return;
      }

      this.log(`Found ${commitments.length} due commitment(s)`);

      // Process serially
      for (const commitment of commitments) {
        await this.processCommitment(commitment);
      }
    } catch (error) {
      this.log(`Tick error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Fetch commitments that are due and claimable by bridge
   */
  private async fetchDueCommitments(): Promise<Commitment[]> {
    const response = await fetch(
      `${this.config.mentu.proxy_url}/commitments?state=open&limit=10`,
      {
        headers: {
          'X-Proxy-Token': this.config.mentu.api_key,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch commitments: ${response.status}`);
    }

    const data = await response.json() as { commitments: Commitment[] };
    const commitments = data.commitments || [];

    // Filter for due commitments with bridge affinity or no affinity, and no owner
    const now = new Date();
    return commitments.filter(c => {
      // Must be unowned
      if (c.owner) return false;

      // Check affinity (bridge or unspecified)
      const affinity = c.meta?.affinity;
      if (affinity && affinity !== 'bridge') return false;

      // Check due_at
      if (!c.meta?.due_at) return true;  // No due_at = immediately due
      return new Date(c.meta.due_at) <= now;
    });
  }

  /**
   * Process a single commitment
   */
  private async processCommitment(commitment: Commitment): Promise<void> {
    this.log(`Processing commitment ${commitment.id}`);

    try {
      // 1. Claim
      const claimed = await this.claimCommitment(commitment.id);
      if (!claimed) {
        this.log(`Failed to claim ${commitment.id} - already claimed`);
        return;
      }

      // 2. Get source memory for context
      const source = await this.fetchMemory(commitment.source);

      // 3. Build and execute
      await this.executeCommitment(commitment, source);

    } catch (error) {
      this.log(`Error processing ${commitment.id}: ${error instanceof Error ? error.message : String(error)}`);

      // Capture failure and release
      await this.handleFailure(commitment.id, error);
    }
  }

  /**
   * Claim a commitment via Mentu API
   */
  private async claimCommitment(commitmentId: string): Promise<boolean> {
    const response = await fetch(`${this.config.mentu.proxy_url}/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': this.config.mentu.api_key,
      },
      body: JSON.stringify({
        op: 'claim',
        commitment: commitmentId,
      }),
    });

    return response.ok;
  }

  /**
   * Fetch a memory by ID
   */
  private async fetchMemory(memoryId: string): Promise<Memory | null> {
    const response = await fetch(
      `${this.config.mentu.proxy_url}/rest/v1/memories?id=eq.${memoryId}&limit=1`,
      {
        headers: {
          'X-Proxy-Token': this.config.mentu.api_key,
        },
      }
    );

    if (!response.ok) return null;
    const memories = await response.json() as Memory[];
    return memories[0] || null;
  }

  /**
   * Execute commitment via Claude
   */
  private async executeCommitment(commitment: Commitment, source: Memory | null): Promise<void> {
    if (!this.onExecute) {
      this.log('No execute handler registered - skipping commitment execution');
      return;
    }

    // Build prompt using prompt-builder
    const { buildExecutionPrompt } = await import('./prompt-builder.js');
    const prompt = buildExecutionPrompt(commitment, source, this.config);

    const workingDirectory = commitment.meta?.working_directory ||
      this.config.execution.allowed_directories[0];

    // Call the registered handler
    await this.onExecute({
      commitment,
      prompt,
      workingDirectory,
      timeout: (commitment.meta?.timeout || 30) * 60 * 1000,
    });
  }

  /**
   * Handle execution failure
   */
  private async handleFailure(commitmentId: string, error: unknown): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Capture failure memory
    await fetch(`${this.config.mentu.proxy_url}/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': this.config.mentu.api_key,
      },
      body: JSON.stringify({
        op: 'capture',
        body: `Execution failed for ${commitmentId}: ${errorMessage}`,
        kind: 'execution_failure',
        meta: { commitment_id: commitmentId },
      }),
    });

    // Annotate commitment
    await fetch(`${this.config.mentu.proxy_url}/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': this.config.mentu.api_key,
      },
      body: JSON.stringify({
        op: 'annotate',
        target: commitmentId,
        body: `Automated execution failed: ${errorMessage}`,
        kind: 'execution_failed',
      }),
    });

    // Release claim
    await fetch(`${this.config.mentu.proxy_url}/ops`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Token': this.config.mentu.api_key,
      },
      body: JSON.stringify({
        op: 'release',
        commitment: commitmentId,
      }),
    });
  }
}
