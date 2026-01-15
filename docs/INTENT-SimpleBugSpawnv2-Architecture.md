---
id: INTENT-SimpleBugSpawnv2-Architecture
path: docs/INTENT-SimpleBugSpawnv2-Architecture.md
type: intent
intent: architect
version: "2.0"
created: 2026-01-14
tier: T3

author_type: architect
parent: AUDIT-LedgerFirstMigration-v1.0
related:
  - PRD-SimpleBugSpawn-v1.0
  - mentu-web/KanbanBoard
  - Genesis-Key-Canonical-Schema

status: draft
visibility: architect-only
---

# Architectural Intent: SimpleBugSpawn v2 - Ledger-First Bug Orchestration

> **From**: Architect
>
> **To**: Auditor (for validation) → Executor (for implementation)
>
> **Duration**: Multi-phase, staged rollout
>
> **Dependencies**: AUDIT-LedgerFirstMigration-v1.0 (approved with conditions)

---

## Strategic Vision

### The Principle

SimpleBugSpawn v2 implements **"Read ledger, write ops"** as the canonical bug execution system.

Instead of a separate `bridge_commands` table with ad-hoc routing logic, the **Mentu ledger becomes the single source of truth** for all bug execution state: claiming, execution tracking, isolation boundaries, concurrency control, and completion verification.

### Why Now

1. **v1.0 is shipping** (CLI arg spawn, minimal prompt, 50 turns, protocol template)
2. **LedgerFirstMigration audit approved** with conditions — the foundation exists
3. **KanbanBoard in mentu-web** already visualizes commitment state machine
4. **Video pattern** (worktrees, tmux sessions, parallel execution) validates the approach
5. **genesis.key already supports** execution configuration (machines, paths, permissions)

### What v2 Unlocks

- **Ledger-backed state machine**: bug execution tracked as capture/annotate/claim/close operations
- **Automatic conflict detection**: query ledger to find non-conflicting bugs for parallel execution
- **Worktree isolation**: each bug gets `./work/{commitment_id}/` — prevents clobbering
- **tmux session tracking**: record session names in ledger for inspection, monitoring, termination
- **Full audit trail**: every execution decision is an operation in the ledger
- **genesis.key governance**: machine affinity, concurrency limits, tier rules via genesis

---

## v1.0 Foundation (Already Shipping)

**Scope**: SimpleBugSpawn v1.0

```
Bug Report → Proxy builds commitment → bridge_commands table
                                              ↓
                                  SimpleBugExecutor polls
                                              ↓
                               Spawns Claude with CLI arg
                                              ↓
                          Claude reads ./BUG-FIX-PROTOCOL.md
                                              ↓
                          Claude commits, closes commitment
```

**Deliverables**:
- ✅ CLI argument spawn (not stdin piping)
- ✅ Minimal 4-line prompt (delegates to repo protocol)
- ✅ 50 max turns (configurable)
- ✅ Protocol template for repos to copy

**Constraint**: Bridge_commands table still required for routing (temporary)

---

## v2.0 Architecture: Ledger-First Orchestration

### Design Principle: Operations as State Machine

Bug execution is tracked as a sequence of ledger operations:

```
1. capture (kind: bug_execution_request)
   └─ Bug reported from WarrantyOS/Beacon
   └─ payload.meta: { severity, source_ticket, page_url, screenshot_url }

2. commit (references source memory)
   └─ Obligation created by triage/router
   └─ payload.meta: { workspace_id, working_directory, bug_fix_protocol, tier }
   └─ tags: [bug_fix, auth] (for routing rules)

3. capture (kind: execution_start)
   └─ Executor beginning work
   └─ payload.refs: [commitment_id]
   └─ payload.meta: { state: "claimed", executor_id, start_time }

4. claim (on commitment)
   └─ Executor has claimed responsibility
   └─ Atomic: update bridge_commands STATUS = claimed WHERE status = pending

5. annotate (on execution_start memory)
   └─ Executor spawning Claude
   └─ payload.meta: { tmux_session: "bug_cmt_abc123", state: "running", max_turns: 50 }

6. capture (kind: worktree_created)
   └─ Executor created isolated worktree
   └─ payload.meta: { worktree_path: "./work/cmt_abc123", branch: "worktree_cmt_abc123" }

7. capture (kind: implementation_evidence)
   └─ Claude completed (files changed, tests passed, commits made)
   └─ payload: "Fixed Safari login issue in auth.ts:234"
   └─ payload.refs: [commitment_id]

8. annotate (on execution_start memory)
   └─ Executor merged worktree
   └─ payload.meta: { worktree_merged: true, merge_commit: "abc123def456", state: "merged" }

9. submit (on commitment)
   └─ Executor submitting for approval
   └─ payload.evidence_refs: [implementation_evidence_id]
   └─ payload.summary: "Fixed Safari login. Tests pass. Ready for review."

10. approve (on commitment)
    └─ Auto-approve for T1, human approval for T2+
    └─ payload.reason: "T1 tier auto-approval" | "Approved by human:rashid@acme.com"

11. close (on commitment)
    └─ Commitment resolved
    └─ payload.evidence_refs: [implementation_evidence_id]
    └─ payload.reason: "approved"
```

### Bridge Executor Responsibilities

The bridge daemon becomes an **orchestrator and state machine reader**:

```typescript
async function orchestrateBugFix() {
  // 1. Query ledger for open bug_fix commitments
  const bugs = await queryLedger(`
    op = commit
    AND tags contains bug_fix
    AND state = open
  `);

  // 2. Filter for non-conflicting bugs
  const nonConflicting = detectConflicts(bugs);

  // 3. For each selectable bug
  for (const bug of nonConflicting) {
    // Create execution_start memory
    const execMem = await capture({
      kind: "execution_start",
      refs: [bug.id],
      meta: { commitment_id: bug.id, state: "claimed" }
    });

    // Claim the commitment (atomic)
    await claim(bug.id);

    // Create worktree from workspace path
    const worktreePath = `./work/${bug.id}`;
    await createWorktree(
      bug.meta.working_directory,
      worktreePath,
      `worktree_${bug.id}`
    );

    // Record worktree creation
    await capture({
      kind: "worktree_created",
      refs: [bug.id],
      meta: { worktree_path: worktreePath, branch: `worktree_${bug.id}` }
    });

    // Build minimal prompt
    const prompt = buildMinimalPrompt(bug);

    // Spawn Claude in tmux session
    const sessionName = `bug_${bug.id}`;
    await spawnInTmux(sessionName, prompt, { cwd: worktreePath });

    // Record tmux spawn
    await annotate(execMem.id, {
      body: `Claude spawned in tmux session`,
      meta: { tmux_session: sessionName, state: "running", max_turns: 50 }
    });
  }
}
```

### Querying the State Machine

Instead of `SELECT * FROM bridge_commands WHERE status = 'pending'`:

```bash
# Find all bugs currently executing
mentu query 'op = annotate AND kind = execution_start AND meta.state = running'

# Find all bugs claimed by this executor
mentu query 'op = claim AND actor = agent:bridge-executor AND committed_state = claimed'

# Find bugs with conflicts (same file)
mentu query 'op = capture AND kind = worktree_created AND refs[0]'
# Then: analyze file changes in each worktree

# Find completed bugs ready to merge
mentu query 'op = annotate AND meta.state = merged'

# Find bugs needing intervention
mentu query 'op = annotate AND meta.state = intervention_required'
```

---

## Ledger Governance: genesis.key Extensions

### Current Genesis Key (v1.1)

```yaml
identity:
  paths:
    local: "/Users/rashid/Desktop/Workspaces/mentu-ai"
    vps: "/home/mentu/Workspaces/mentu-ai"
  machines:
    - id: "vps-01"
      role: "executor"
```

### Extended for Bug Execution (v2.0)

```yaml
identity:
  # ... existing ...
  execution_config:
    bug_execution:
      max_concurrent: 3              # Max simultaneous bug fixes on this machine
      max_turns: 50                  # Default max turns for Claude
      timeout_seconds: 3600          # Default timeout
      conflict_detection:
        check_file_overlap: true     # Don't spawn if files conflict
        check_test_overlap: true     # Don't spawn if test suites overlap
        check_dependencies: true     # Don't spawn if bugs are ordered

      worktree_config:
        base_path: "./work"          # Where to create worktrees
        cleanup_after: 604800        # Cleanup orphaned after 7 days

      tmux_config:
        session_prefix: "bug_"       # tmux session name prefix
        auto_capture_output: true    # Save session logs to ledger

      tier_rules:
        T1:
          auto_approve: true         # Automatically approve T1 bugs
          max_concurrent_override: 5 # Allow more T1s to run

        T2:
          auto_approve: false        # Require human approval
          max_concurrent_override: 3

        T3:
          auto_approve: false        # Require human approval
          max_concurrent_override: 1 # One high-risk bug at a time

permissions:
  actors:
    "agent:bridge-executor":
      operations: [capture, annotate, claim, close, submit]
      execution_tiers: [T1, T2]     # Can only execute T1, T2 bugs
      machine_affinity: [vps-01]    # Can only run on vps-01

    "agent:bridge-executor-t3":
      operations: [capture, annotate, claim, close, submit]
      execution_tiers: [T3]          # Only T3 (high-risk)
      machine_affinity: [vps-01]
```

---

## Parallel Execution with Conflict Detection

### The Pattern

From the YouTube video: don't spawn all tasks at once. Instead:

```
1. Query ledger for open bugs
2. Build dependency graph (which files each bug touches)
3. Select maximal non-conflicting set
4. Spawn those in parallel
5. Monitor their ledger state
6. When one completes, select next batch
```

### Implementation in Bridge Executor

```typescript
async function detectConflicts(bugs: Commitment[]): Promise<Commitment[][]> {
  // Build map of bug → files it will change
  const bugFiles = new Map<string, Set<string>>();
  for (const bug of bugs) {
    const worktreeId = bug.id;
    const repoPath = bug.meta.working_directory;

    // Analyze which files this bug description mentions
    const mentionedFiles = extractFileMentions(bug.payload.body);
    bugFiles.set(worktreeId, mentionedFiles);
  }

  // Find maximal non-conflicting set
  const graph = buildConflictGraph(bugFiles);
  const maximalSet = selectMaximalIndependentSet(graph);

  return maximalSet;
}

function extractFileMentions(bugDescription: string): Set<string> {
  // Parse bug description for file mentions
  // Match: "src/auth.ts", "tests/login.test.tsx", etc.
  const filePattern = /(?:src|components|tests|lib)\S+\.\w+/g;
  return new Set(bugDescription.match(filePattern) || []);
}

function buildConflictGraph(bugFiles: Map<string, Set<string>>): ConflictGraph {
  // Two bugs conflict if they mention overlapping files
  const conflicts = new Map<string, Set<string>>();

  for (const [bugA, filesA] of bugFiles) {
    conflicts.set(bugA, new Set());
    for (const [bugB, filesB] of bugFiles) {
      if (bugA !== bugB && hasOverlap(filesA, filesB)) {
        conflicts.get(bugA)!.add(bugB);
      }
    }
  }

  return conflicts;
}

function selectMaximalIndependentSet(graph: ConflictGraph): Commitment[] {
  // Greedy selection: pick largest non-conflicting subset
  const selected: string[] = [];
  const remaining = new Set(graph.keys());

  while (remaining.size > 0) {
    // Pick bug with least conflicts among remaining
    let best = Array.from(remaining).sort(
      (a, b) => graph.get(a)!.size - graph.get(b)!.size
    )[0];

    selected.push(best);
    remaining.delete(best);

    // Remove conflicting bugs
    for (const conflict of graph.get(best)!) {
      remaining.delete(conflict);
    }
  }

  return selected;
}
```

---

## Integration with mentu-web KanbanBoard

The KanbanBoard already visualizes commitment state:

```
todo | in_progress | in_review | done | cancelled
```

### v2 Enhancements

**Add visual indicators**:
- Bug execution badge showing:
  - ⏳ Pending (waiting for executor)
  - 🚀 Running (Claude is active)
  - 📦 Worktree created (isolated workspace)
  - 🔀 Merging (worktree merge in progress)
  - ✅ Done (merged back)

**Clickable cards show**:
- Commitment state (open/claimed/in_review/closed)
- Execution timeline:
  - execution_start memory created
  - worktree_created memory
  - implementation_evidence capture
  - merge annotate
- tmux session link: `Open tmux session [bug_cmt_abc123]`
- Ledger operations for this bug (full audit trail)

**Real-time updates** via Supabase realtime subscriptions on `operations` table

---

## Other Architectural Ideas for v2+

### Consider in Design

1. **Machine Pools** (dispatch to "vps-*" wildcard)
   - Genesis key specifies: `execution_target: "vps-*"` → load balance across available executors
   - Deferred to v2.1 (as audit noted)

2. **Bug Batching** (group related bugs)
   - Bugs tagged `[related:batch-123]` share worktree
   - Single PR from multiple bug fixes
   - Reduces friction for connected issues

3. **Evidence Collection Pipeline**
   - Automatically capture:
     - Screenshots before/after (from WarrantyOS)
     - Console logs during execution
     - Test output
     - Deployment logs
   - Link all to single implementation_evidence memory

4. **Rollback Capability**
   - If bug fix breaks tests, executor can:
     - `mentu release cmt_xxx` (give up and mark as intervention_required)
     - Worktree is preserved for investigation
     - Next executor can continue or restart

5. **Time-Boxed Execution**
   - Commitment tagged `[urgent]` → max 2 turns
   - Normal bug → max 50 turns
   - Research bug → max 100 turns (with approval)
   - Controls spent on investigation vs. outcome

6. **Cross-Repo Bug Fixes** (future)
   - Bug in app A caused by lib in repo B
   - Genesis key specifies: can dispatch to [app-a, lib-b] simultaneously
   - Both worktrees in coordination

---

## Phases

### Phase 1: v1.0 - Foundation (🚀 Shipping Now)

- CLI arg spawn
- Minimal prompt
- 50 turns
- Protocol template
- Still uses `bridge_commands` table for routing

### Phase 2: v2.0 - Ledger-First (Architect → Auditor → Executor)

**Stage 1**: Genesis schema extensions (execution_config, tier_rules)
**Stage 2**: Dispatch operation type (13th operation)
**Stage 3**: Bridge ledger subscription (read from operations, write capture/annotate/claim)
**Stage 4**: Worktree isolation + tmux session tracking
**Stage 5**: Conflict detection + parallel execution
**Stage 6**: Deprecate bridge_commands table
**Stage 7**: KanbanBoard real-time integration

### Phase 3: v2.1+ - Enhancements

- Machine pools
- Bug batching
- Evidence collection pipeline
- Rollback capability
- Time-box controls
- Cross-repo coordination

---

## Success Criteria

### v2.0 Acceptance

- ✅ All bug executions tracked as ledger operations
- ✅ genesis.key fully governs execution (tier rules, machine affinity, concurrency)
- ✅ Conflict detection prevents simultaneous clobbering
- ✅ Worktree isolation proven (multiple bugs in parallel without conflict)
- ✅ tmux sessions tracked and inspectable
- ✅ KanbanBoard displays execution state in real-time
- ✅ Full audit trail from bug report → fix → closure
- ✅ bridge_commands table deprecated (still supported for compat)

### Verification

```bash
# Query ledger: find all bugs currently executing
mentu query 'op = annotate AND meta.state = running'

# Should see: execution_start memory for each active bug
# Each should have: tmux_session, worktree_path, max_turns

# Check conflict detection: pick any 2 running bugs
# Their worktrees should be in: ./work/cmt_xxx and ./work/cmt_yyy
# No overlap in files they mention

# Check KanbanBoard: real-time state updates
# When executor creates worktree_created operation
# KanbanBoard badge should update immediately
```

---

## Dependencies & Blockers

**Blocking**:
- ✅ AUDIT-LedgerFirstMigration-v1.0 (APPROVED WITH CONDITIONS)
- ✅ INTENT-WorkflowOrchestratorInvocation (required for routing to executor)

**Required Infrastructure**:
- ✅ Supabase operations table (already exists)
- ✅ genesis.key parser (already exists)
- ✅ Mentu CLI dispatch command (to be built)

**Related Work**:
- mentu-web KanbanBoard (can extend in Phase 2 Stage 7)
- mentu-proxy bug-webhook handler (route to ledger instead of bridge_commands)
- mentu-bridge realtime subscriber (extend to listen to operations table)

---

## Sign-Off

This intent establishes the **architectural direction** for SimpleBugSpawn v2: a **ledger-first, conflict-aware, parallel-execution bug orchestration system** where every decision is auditable, every bug execution is isolated, and the Mentu ledger is the single source of truth.

Ready for auditor validation.

---

*Authored by: Architect (remote agent)*
*For audition by: Auditor (lead agent)*
*For execution by: Executor (bridge daemon + CLI)*
