---
id: HANDOFF-BridgeCLIAPIMismatch-v1.0
type: handoff
audit_ref: AUDIT-BridgeCLIAPIMismatch-v1.0
created: 2026-01-03
executor: agent:claude-executor
tier: T2
mentu:
  commitment: pending
---

# HANDOFF: Bridge CLI/API Mismatch Fix

## Audit Context

This implementation was validated by audit before execution.

| Field | Value |
|-------|-------|
| Intent Source | Inline diagnostic session |
| Audit Reference | AUDIT-BridgeCLIAPIMismatch-v1.0 |
| Audit Verdict | APPROVE |
| Auditor | agent:claude-auditor |
| Checkpoint | c865b7cdd6ab195ea8d7fb70db8aac1a4f31632b |

### Audit Conditions

1. Only modify `prompt-builder.ts` and optionally `daemon.ts`
2. No database/schema changes
3. Must be backward compatible
4. Must test with real Supabase commitment

---

## Mission

Fix the 100% failure rate in bridge commitment execution by updating the prompt-builder to instruct Claude to use the proxy API instead of the local `mentu` CLI.

---

## Current State (Broken)

**File**: `src/prompt-builder.ts` lines 59-61

```typescript
## Commands Available
- mentu capture "evidence" --kind evidence
- mentu close {commitment_id} --evidence mem_XXXXXXXX
```

**Problem**: `mentu` CLI looks in local `.mentu/ledger.jsonl`, but commitments are in Supabase.

---

## Target State (Fixed)

Replace CLI instructions with proxy API instructions:

```markdown
## Mentu API

**Base URL**: {proxy_url}
**Auth**: X-Proxy-Token: {proxy_token}

### 1. Capture Evidence
```bash
curl -X POST {proxy_url}/ops \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Token: {proxy_token}" \
  -d '{"op": "capture", "body": "Description of what you did and the result", "kind": "evidence"}'
```

Response: `{"id": "mem_XXXXXXXX", ...}`

### 2. Close Commitment
```bash
curl -X POST {proxy_url}/ops \
  -H "Content-Type: application/json" \
  -H "X-Proxy-Token: {proxy_token}" \
  -d '{"op": "close", "commitment": "{commitment_id}", "evidence": "mem_XXXXXXXX"}'
```
```

---

## Implementation Steps

### Step 1: Update Template Variables

**File**: `src/prompt-builder.ts`

Add new replacements to the `replacements` object (around line 69):

```typescript
const replacements: Record<string, string> = {
  // ... existing ...
  proxy_url: config?.mentu?.proxy_url || 'https://mentu-proxy.affihub.workers.dev',
  proxy_token: config?.mentu?.api_key || '<TOKEN_NOT_PROVIDED>',
};
```

**Note**: You'll need to pass `config` to `buildExecutionPrompt()`. Update the function signature:

```typescript
export function buildExecutionPrompt(
  commitment: Commitment,
  source: Memory | null,
  config?: { mentu?: { proxy_url?: string; api_key?: string } }
): string
```

### Step 2: Update the Template

Replace the `## Commands Available` section (lines 59-61) with:

```typescript
## Mentu API

**Base URL**: {proxy_url}
**Auth Header**: X-Proxy-Token: {proxy_token}

### Capture Evidence (required before closing)
\`\`\`
POST {proxy_url}/ops
Content-Type: application/json
X-Proxy-Token: {proxy_token}

{"op": "capture", "body": "What you accomplished and the evidence", "kind": "evidence"}
\`\`\`
Returns: {"id": "mem_XXXXXXXX", ...}

### Close Commitment (final step)
\`\`\`
POST {proxy_url}/ops
Content-Type: application/json
X-Proxy-Token: {proxy_token}

{"op": "close", "commitment": "{commitment_id}", "evidence": "mem_XXXXXXXX"}
\`\`\`

**Important**: You MUST capture evidence first, then use the returned mem_ID to close.
```

### Step 3: Update Caller in scheduler.ts

**File**: `src/scheduler.ts` line 221

Update the call to pass config:

```typescript
const prompt = buildExecutionPrompt(commitment, source, this.config);
```

### Step 4: Rebuild and Test

```bash
cd /Users/rashid/Desktop/Workspaces/mentu-bridge
npm run build
```

Restart daemon and test with a real commitment.

---

## Verification Checklist

- [ ] `prompt-builder.ts` updated with API instructions
- [ ] Function signature updated to accept config
- [ ] `scheduler.ts` passes config to buildExecutionPrompt
- [ ] Build succeeds (`npm run build`)
- [ ] Daemon restarts without errors
- [ ] Test: Submit a simple commitment and verify Claude uses API (not CLI)
- [ ] Test: Commitment closes successfully in Supabase

---

## Files to Modify

| File | Change |
|------|--------|
| `src/prompt-builder.ts` | Update template + function signature |
| `src/scheduler.ts` | Pass config to buildExecutionPrompt |

---

## Rollback Plan

If issues occur:
1. Revert to checkpoint: `git checkout c865b7c`
2. Rebuild: `npm run build`
3. Restart daemon

---

## Evidence Requirements

Upon completion, capture evidence showing:
1. The updated prompt-builder template
2. A successful commitment closure via API
3. Supabase showing commitment state = 'closed'

---

*Handoff created: 2026-01-03*
