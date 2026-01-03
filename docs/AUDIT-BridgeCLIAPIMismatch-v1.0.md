---
id: AUDIT-BridgeCLIAPIMismatch-v1.0
type: audit
intent_ref: (inline - from diagnostic session)
created: 2026-01-03
auditor: agent:claude-auditor
checkpoint:
  git_sha: c865b7cdd6ab195ea8d7fb70db8aac1a4f31632b
  timestamp: 2026-01-03T00:04:00Z
verdict: APPROVE
mentu:
  evidence: mem_dbc06d17
---

# Audit: Bridge CLI/API Mismatch Fix

## Executive Summary

The mentu-bridge daemon's commitment execution has a **100% failure rate** due to an architecture mismatch: the prompt-builder instructs Claude to use the local `mentu` CLI, but commitments are stored in Supabase (not local ledgers).

**Verdict**: APPROVE - Fix is essential, low-risk, and follows existing patterns.

---

## 1. Issue Description

### Root Cause

```
Scheduler → Supabase (cmt_xxx exists in cloud)
    ↓
Spawn Claude with prompt:
    "mentu close cmt_xxx --evidence ..."
    ↓
Claude runs: mentu close cmt_xxx
    ↓
CLI checks: .mentu/ledger.jsonl (LOCAL)
    ↓
ERROR: "Commitment cmt_xxx does not exist"
    ↓
Claude stuck in reasoning loop
    ↓
Process hangs for 60+ minutes
```

### Evidence

```bash
$ mentu close cmt_aa2b2e9c --evidence mem_test
Error: Commitment cmt_aa2b2e9c does not exist
```

The CLI looks in local `.mentu/ledger.jsonl`, but `cmt_aa2b2e9c` is a Supabase-backed commitment.

---

## 2. Affected Components

| File | Role | Change Required |
|------|------|-----------------|
| `src/prompt-builder.ts` | Generates execution prompts | Replace CLI commands with API instructions |
| `src/daemon.ts` | Core daemon | (Optional) Add `closeCommitment()` method |
| `src/scheduler.ts` | Commitment polling | No changes (already uses API) |

---

## 3. Technical Feasibility

### Existing Pattern (daemon.ts lines 34-62)

```typescript
private async captureMemory(body: string, kind?: string): Promise<MentuOperation | null> {
  const response = await fetch(`${this.config.mentu.proxy_url}/ops`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Proxy-Token': this.config.mentu.api_key,
    },
    body: JSON.stringify({
      op: 'capture',
      body,
      kind,
    }),
  });
  // ...
}
```

This same pattern supports `op: "close"` - just need to add it.

### Required API Operations

| Operation | Endpoint | Body |
|-----------|----------|------|
| Capture evidence | `POST /ops` | `{"op": "capture", "body": "...", "kind": "evidence"}` |
| Close commitment | `POST /ops` | `{"op": "close", "commitment": "cmt_xxx", "evidence": "mem_xxx"}` |

---

## 4. Risk Assessment

| Risk | Level | Rationale |
|------|-------|-----------|
| Scope Creep | Low | Well-defined single fix |
| Breaking Changes | Low | Only affects new executions |
| Security | Low | Using existing proxy token |
| Technical Debt | Low | Actually reduces debt |
| Reversibility | Low | Single file change |

---

## 5. Effort Estimation

**Tier**: T2 (Feature)

| Task | Effort |
|------|--------|
| Update prompt-builder template | 30 min |
| Add template variables for proxy credentials | 15 min |
| (Optional) Add closeCommitment helper | 30 min |
| Test with real commitment | 15 min |
| **Total** | ~1.5 hours |

---

## 6. Proposed Solution

### Option A: Pass Credentials to Claude (Recommended)

Update `prompt-builder.ts` to include:

```markdown
## Mentu API (Use Instead of CLI)

Base URL: {proxy_url}
Auth Header: X-Proxy-Token: {proxy_token}

### Capture Evidence
POST {proxy_url}/ops
{"op": "capture", "body": "What you did and the result", "kind": "evidence"}

### Close Commitment
POST {proxy_url}/ops
{"op": "close", "commitment": "{commitment_id}", "evidence": "mem_XXXXXXXX"}
```

### Option B: Daemon Handles Closing (Alternative)

Claude only captures evidence; daemon detects new evidence and closes commitment automatically.

**Recommendation**: Option A - simpler, gives Claude full control.

---

## 7. Secondary Issues Identified

### Issue 2: No Affinity Control

Open commitments have `meta: {}` - no affinity set. Scheduler picks up EVERYTHING including:
- "Implement Temporal Primitives v1.0" (major feature)
- "Implement orchestrator skill" (major feature)

**Recommendation**: Separate fix - add affinity metadata to commitments.

### Issue 3: Race Condition

Same command executed multiple times due to both Realtime subscription AND pending check triggering.

**Recommendation**: Add execution lock (separate fix).

### Issue 4: Long Default Timeout

3600s (1 hour) timeout for bridge tasks is excessive.

**Recommendation**: Reduce to 300-600s (separate fix).

---

## 8. Audit Conditions

If approved, the following conditions apply to execution:

1. **Scope**: Only modify `prompt-builder.ts` and optionally `daemon.ts`
2. **No schema changes**: No database modifications
3. **Backward compatible**: Existing commands should still work
4. **Testable**: Must verify with real Supabase commitment before merge

---

## 9. Provenance Chain

| Artifact | ID |
|----------|-----|
| Checkpoint SHA | `c865b7cdd6ab195ea8d7fb70db8aac1a4f31632b` |
| Audit Evidence | `mem_dbc06d17` |
| Auditor | `agent:claude-auditor` |

---

*Audit completed: 2026-01-03*
