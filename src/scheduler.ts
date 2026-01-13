// Scheduler for polling due commitments
// Implements Temporal Primitives v1.0 from orchestrator.yaml

import type { BridgeConfig } from './types.js';

/**
 * Temporal State Machine (from orchestrator.yaml):
 * scheduled → due → active → late → closed
 *     ↓        ↓
 *  waiting  waiting
 */
export type TemporalState = 'scheduled' | 'due' | 'waiting' | 'active' | 'late' | 'closed' | 'escalated';

/**
 * Late policy determines action when task misses deadline
 */
export type LatePolicy = 'warn' | 'fail' | 'escalate';

/**
 * Dependency satisfaction status
 */
export interface DependencyStatus {
  satisfied: boolean;
  blocked_by: string[];
  wait_type: 'wait_for' | 'wait_for_all' | 'wait_for_any' | 'requires' | null;
}

/**
 * Extended commitment interface with full temporal metadata
 */
interface Commitment {
  id: string;
  body: string;
  source: string;
  state: string;
  owner: string | null;
  meta?: {
    // Affinity routing
    affinity?: string;
    working_directory?: string;
    instructions?: string;
    timeout?: number;

    // Temporal primitives
    due_at?: string;           // When task should execute (ISO 8601)
    scheduled_for?: string;    // Alias for due_at
    deadline?: string;         // Hard deadline for completion
    wait_until?: string;       // Embargo - don't execute before
    grace_period?: number;     // Minutes after deadline before marking late
    late_policy?: LatePolicy;  // Action when late: warn, fail, escalate

    // Dependency primitives
    wait_for?: string;         // Single commitment ID to wait for
    wait_for_all?: string[];   // Wait for ALL commitments (fan-in)
    wait_for_any?: string[];   // Wait for ANY commitment (race)
    requires?: string[];       // Hard dependencies - cannot start until all closed

    // Recurrence (not implemented in this version)
    recurrence?: string;
    timezone?: string;
    ends_at?: string;
    count?: number;
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
  private commitmentCache: Map<string, { state: string; updated_at: string }> = new Map();

  constructor(config: BridgeConfig) {
    this.config = config;
  }

  /**
   * Calculate the temporal state of a commitment
   */
  private calculateTemporalState(commitment: Commitment, now: Date): TemporalState {
    const meta = commitment.meta || {};

    // Already closed
    if (commitment.state === 'closed') return 'closed';

    // Check if claimed/active
    if (commitment.owner) return 'active';

    // Check wait_until embargo
    if (meta.wait_until && new Date(meta.wait_until) > now) {
      return 'waiting';
    }

    // Get effective due time (support both due_at and scheduled_for)
    const dueAt = meta.due_at || meta.scheduled_for;

    // No due time = immediately due
    if (!dueAt) return 'due';

    // Future due time
    if (new Date(dueAt) > now) return 'scheduled';

    // Due time has passed - check deadline
    if (meta.deadline) {
      const deadline = new Date(meta.deadline);
      const gracePeriod = (meta.grace_period || 0) * 60 * 1000;
      const effectiveDeadline = new Date(deadline.getTime() + gracePeriod);

      if (now > effectiveDeadline) {
        return 'late';
      }
    }

    return 'due';
  }

  /**
   * Check if a commitment's dependencies are satisfied
   */
  private async checkDependencies(commitment: Commitment): Promise<DependencyStatus> {
    const meta = commitment.meta || {};
    const result: DependencyStatus = {
      satisfied: true,
      blocked_by: [],
      wait_type: null,
    };

    // Check requires (hard dependencies)
    if (meta.requires && meta.requires.length > 0) {
      result.wait_type = 'requires';
      const statuses = await this.fetchCommitmentStates(meta.requires);
      for (const [id, state] of Object.entries(statuses)) {
        if (state !== 'closed') {
          result.satisfied = false;
          result.blocked_by.push(id);
        }
      }
      if (!result.satisfied) return result;
    }

    // Check wait_for (single dependency)
    if (meta.wait_for) {
      result.wait_type = 'wait_for';
      const statuses = await this.fetchCommitmentStates([meta.wait_for]);
      if (statuses[meta.wait_for] !== 'closed') {
        result.satisfied = false;
        result.blocked_by.push(meta.wait_for);
      }
      if (!result.satisfied) return result;
    }

    // Check wait_for_all (fan-in pattern)
    if (meta.wait_for_all && meta.wait_for_all.length > 0) {
      result.wait_type = 'wait_for_all';
      const statuses = await this.fetchCommitmentStates(meta.wait_for_all);
      for (const [id, state] of Object.entries(statuses)) {
        if (state !== 'closed') {
          result.satisfied = false;
          result.blocked_by.push(id);
        }
      }
      if (!result.satisfied) return result;
    }

    // Check wait_for_any (race pattern) - satisfied if ANY is closed
    if (meta.wait_for_any && meta.wait_for_any.length > 0) {
      result.wait_type = 'wait_for_any';
      const statuses = await this.fetchCommitmentStates(meta.wait_for_any);
      const anyClosed = Object.values(statuses).some(state => state === 'closed');
      if (!anyClosed) {
        result.satisfied = false;
        result.blocked_by = meta.wait_for_any;
      }
    }

    return result;
  }

  /**
   * Fetch commitment states (with caching)
   */
  private async fetchCommitmentStates(ids: string[]): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const uncached: string[] = [];

    // Check cache first
    for (const id of ids) {
      const cached = this.commitmentCache.get(id);
      if (cached && Date.now() - new Date(cached.updated_at).getTime() < 30000) {
        result[id] = cached.state;
      } else {
        uncached.push(id);
      }
    }

    // Fetch uncached
    if (uncached.length > 0) {
      try {
        const response = await fetch(
          `${this.config.mentu.proxy_url}/rest/v1/commitments?id=in.(${uncached.join(',')})&select=id,state`,
          {
            headers: {
              'X-Proxy-Token': this.config.mentu.api_key,
            },
          }
        );

        if (response.ok) {
          const commitments = await response.json() as { id: string; state: string }[];
          for (const c of commitments) {
            result[c.id] = c.state;
            this.commitmentCache.set(c.id, { state: c.state, updated_at: new Date().toISOString() });
          }
        }
      } catch (error) {
        this.log(`Failed to fetch commitment states: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return result;
  }

  /**
   * Handle late policy for a commitment that missed its deadline
   */
  private async handleLatePolicy(commitment: Commitment): Promise<'continue' | 'skip'> {
    const policy = commitment.meta?.late_policy || 'warn';

    switch (policy) {
      case 'warn':
        // Annotate and continue
        await this.annotateCommitment(commitment.id, `Warning: Task is past deadline`, 'deadline_warning');
        this.log(`[LATE] ${commitment.id} is past deadline (policy: warn, continuing)`);
        return 'continue';

      case 'fail':
        // Annotate and skip - don't execute
        await this.annotateCommitment(commitment.id, `Task failed: missed deadline`, 'deadline_failed');
        this.log(`[LATE] ${commitment.id} failed due to missed deadline (policy: fail)`);
        return 'skip';

      case 'escalate':
        // Annotate for escalation and continue
        await this.annotateCommitment(commitment.id, `ESCALATION: Task past deadline, requires attention`, 'deadline_escalated');
        await this.captureEscalation(commitment);
        this.log(`[LATE] ${commitment.id} escalated (policy: escalate, continuing)`);
        return 'continue';

      default:
        return 'continue';
    }
  }

  /**
   * Annotate a commitment via Mentu API
   */
  private async annotateCommitment(commitmentId: string, body: string, kind: string): Promise<void> {
    try {
      await fetch(`${this.config.mentu.proxy_url}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Token': this.config.mentu.api_key,
        },
        body: JSON.stringify({
          op: 'annotate',
          target: commitmentId,
          body,
          kind,
        }),
      });
    } catch (error) {
      this.log(`Failed to annotate ${commitmentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Capture escalation memory for human attention
   */
  private async captureEscalation(commitment: Commitment): Promise<void> {
    try {
      await fetch(`${this.config.mentu.proxy_url}/ops`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Token': this.config.mentu.api_key,
        },
        body: JSON.stringify({
          op: 'capture',
          body: `ESCALATION: Commitment ${commitment.id} missed deadline and requires human attention.\n\nTask: ${commitment.body}\nDeadline: ${commitment.meta?.deadline}\nPolicy: escalate`,
          kind: 'escalation',
          meta: { commitment_id: commitment.id, affinity: 'human' },
        }),
      });
    } catch (error) {
      this.log(`Failed to capture escalation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Register handler for commitment execution
   */
  setExecuteHandler(handler: ExecuteHandler): void {
    this.onExecute = handler;
  }

  /**
   * Public method to query wait status for a commitment
   * Used by CLI: mentu wait <commitment_id>
   */
  async queryWaitStatus(commitmentId: string): Promise<{
    temporal_state: TemporalState;
    dependencies: DependencyStatus;
    ready: boolean;
  }> {
    // Fetch the commitment
    const response = await fetch(
      `${this.config.mentu.proxy_url}/rest/v1/commitments?id=eq.${commitmentId}&limit=1`,
      {
        headers: {
          'X-Proxy-Token': this.config.mentu.api_key,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch commitment: ${response.status}`);
    }

    const commitments = await response.json() as Commitment[];
    if (commitments.length === 0) {
      throw new Error(`Commitment not found: ${commitmentId}`);
    }

    const commitment = commitments[0];
    const now = new Date();
    const temporalState = this.calculateTemporalState(commitment, now);
    const dependencies = await this.checkDependencies(commitment);

    const ready = (temporalState === 'due' || temporalState === 'late') && dependencies.satisfied;

    return { temporal_state: temporalState, dependencies, ready };
  }

  /**
   * Public method to list all waiting commitments
   * Used by CLI: mentu wait --list
   */
  async listWaitingCommitments(): Promise<Array<{
    id: string;
    body: string;
    temporal_state: TemporalState;
    blocked_by: string[];
    wait_type: string | null;
  }>> {
    const response = await fetch(
      `${this.config.mentu.proxy_url}/rest/v1/commitments?state=eq.open&limit=50&select=id,body,source,state,owner,meta`,
      {
        headers: {
          'X-Proxy-Token': this.config.mentu.api_key,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch commitments: ${response.status}`);
    }

    const commitments = await response.json() as Commitment[];
    const now = new Date();
    const waiting: Array<{
      id: string;
      body: string;
      temporal_state: TemporalState;
      blocked_by: string[];
      wait_type: string | null;
    }> = [];

    for (const c of commitments) {
      const temporalState = this.calculateTemporalState(c, now);
      const deps = await this.checkDependencies(c);

      // Include if not ready to execute
      if (temporalState === 'scheduled' || temporalState === 'waiting' || !deps.satisfied) {
        waiting.push({
          id: c.id,
          body: c.body,
          temporal_state: temporalState,
          blocked_by: deps.blocked_by,
          wait_type: deps.wait_type,
        });
      }
    }

    return waiting;
  }

  /**
   * Force a resolution tick (useful for testing and CLI)
   * Used by CLI: mentu resolve
   */
  async resolveTick(dryRun = false): Promise<{
    tick_at: string;
    checked: number;
    spawned: string[];
    blocked: string[];
    errors: string[];
  }> {
    const result = {
      tick_at: new Date().toISOString(),
      checked: 0,
      spawned: [] as string[],
      blocked: [] as string[],
      errors: [] as string[],
    };

    try {
      const response = await fetch(
        `${this.config.mentu.proxy_url}/rest/v1/commitments?state=eq.open&limit=50&select=id,body,source,state,owner,meta`,
        {
          headers: {
            'X-Proxy-Token': this.config.mentu.api_key,
          },
        }
      );

      if (!response.ok) {
        result.errors.push(`Failed to fetch commitments: ${response.status}`);
        return result;
      }

      const commitments = await response.json() as Commitment[];
      const now = new Date();

      for (const c of commitments) {
        result.checked++;

        // Check affinity
        const affinity = c.meta?.affinity;
        if (affinity && affinity !== 'bridge') continue;

        // Skip owned
        if (c.owner) continue;

        const temporalState = this.calculateTemporalState(c, now);
        const deps = await this.checkDependencies(c);

        if (temporalState === 'scheduled' || temporalState === 'waiting' || !deps.satisfied) {
          result.blocked.push(c.id);
          continue;
        }

        // Ready to execute
        if (!dryRun) {
          // In real execution, this would trigger the tick
          result.spawned.push(c.id);
        } else {
          result.spawned.push(`${c.id} (dry-run)`);
        }
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error));
    }

    return result;
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
   * Implements full temporal primitive checking
   */
  private async fetchDueCommitments(): Promise<Commitment[]> {
    const response = await fetch(
      `${this.config.mentu.proxy_url}/rest/v1/commitments?state=eq.open&limit=20&select=id,body,source,state,owner,meta`,
      {
        headers: {
          'X-Proxy-Token': this.config.mentu.api_key,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to fetch commitments: ${response.status}`);
    }

    const commitments = await response.json() as Commitment[];
    const now = new Date();
    const ready: Commitment[] = [];

    for (const c of commitments) {
      // Must be unowned
      if (c.owner) continue;

      // Skip bug commitments - these are handled by BugExecutor, not Scheduler
      // Bug commitments have body starting with "Investigate:" and are processed via bridge_commands
      if (c.body.startsWith('Investigate:')) {
        continue;
      }

      // Check affinity (bridge or unspecified)
      const affinity = c.meta?.affinity;
      if (affinity && affinity !== 'bridge') continue;

      // Calculate temporal state
      const temporalState = this.calculateTemporalState(c, now);

      // Skip if not due yet or if scheduled for future
      if (temporalState === 'scheduled' || temporalState === 'closed') continue;

      // Check wait_until embargo
      if (temporalState === 'waiting') {
        this.log(`[WAITING] ${c.id} embargoed until ${c.meta?.wait_until}`);
        continue;
      }

      // Check dependencies
      const deps = await this.checkDependencies(c);
      if (!deps.satisfied) {
        this.log(`[BLOCKED] ${c.id} waiting for ${deps.wait_type}: ${deps.blocked_by.join(', ')}`);
        continue;
      }

      // Handle late commitments
      if (temporalState === 'late') {
        const action = await this.handleLatePolicy(c);
        if (action === 'skip') continue;
      }

      ready.push(c);
    }

    return ready;
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
