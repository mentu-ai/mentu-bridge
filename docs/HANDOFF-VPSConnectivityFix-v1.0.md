---
id: HANDOFF-VPSConnectivityFix-v1.0
path: docs/HANDOFF-VPSConnectivityFix-v1.0.md
type: handoff
intent: execute

version: "1.0"
created: 2026-01-13
last_updated: 2026-01-13

tier: T1

author_type: executor

mentu:
  commitment: cmt_bugfixer01
  source: mem_bugfixer01
  status: pending
---

# HANDOFF: VPSConnectivityFix v1.0

## For the Coding Agent

Fix two critical issues preventing the VPS bridge from working:
1. **Realtime subscriptions timeout every ~10 seconds** - constant reconnect loop
2. **401 on scheduler fetches** - `Failed to fetch commitments: 401`

---

## Your Identity

You are operating as **executor** in the **mentu-bridge** repository.

**Your domain**: technical. Fix it. Don't explain.

---

## Issue 1: Realtime Subscription Timeouts

### Symptoms

```
[2026-01-13T05:22:56.667Z] [claude-code] Subscription status: TIMED_OUT
[2026-01-13T05:22:56.667Z] [claude-code] Connection lost. Reconnecting in 5 seconds...
```

This loops every 10 seconds, preventing stable operation.

### Root Cause

The Supabase realtime client likely has:
- Missing heartbeat configuration
- Timeout too short for VPS network latency
- WebSocket connection not maintained properly

### Fix

**File**: `src/daemon.ts`

Find the Supabase client initialization and update:

```typescript
import { createClient } from '@supabase/supabase-js';

// Current (likely missing options)
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Fixed - add realtime options
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  realtime: {
    params: {
      eventsPerSecond: 10,
    },
    heartbeatIntervalMs: 15000,  // 15 second heartbeat (default is 30s, may be too long)
    reconnectAfterMs: (tries) => Math.min(tries * 1000, 30000),  // Exponential backoff
  },
  auth: {
    persistSession: false,  // VPS daemon doesn't need session persistence
  },
});
```

If using channels, also configure per-channel:

```typescript
const channel = supabase
  .channel('bridge-commands')
  .on('postgres_changes', { ... }, handler)
  .subscribe((status) => {
    console.log(`[channel] Subscription status: ${status}`);
    if (status === 'TIMED_OUT') {
      // Don't immediately reconnect - let the client handle it
      console.log('[channel] Will auto-reconnect...');
    }
  });
```

### Verification

```bash
# After fix, deploy and check logs
npm run build
# Copy to VPS or sync
ssh mentu@208.167.255.71 'sudo systemctl restart mentu-bridge'
ssh mentu@208.167.255.71 'tail -50 /home/mentu/logs/bridge.log | grep -E "Subscription|TIMED_OUT"'
# Should see SUBSCRIBED, minimal TIMED_OUT
```

---

## Issue 2: Scheduler 401 Unauthorized

### Symptoms

```
[2026-01-13T05:19:48.260Z] [Scheduler] Tick error: Failed to fetch commitments: 401
```

### Root Cause

The scheduler is making HTTP requests to fetch commitments but:
- Using wrong auth header (X-Proxy-Token vs service role key)
- Or token not loaded from environment
- Or hitting wrong endpoint

### Diagnosis

Find the scheduler code and check how it fetches commitments:

```bash
grep -r "fetch.*commitments" src/
grep -r "401" src/
```

### Likely Fix Options

**Option A: Using Supabase client directly (preferred)**

If scheduler uses `fetch()` to hit an API, switch to Supabase client:

```typescript
// BAD: HTTP fetch with token issues
const response = await fetch(`${API_URL}/commitments`, {
  headers: { 'X-Proxy-Token': token }  // Token might be wrong/missing
});

// GOOD: Use Supabase client directly (already authenticated)
const { data, error } = await this.supabase
  .from('commitments')
  .select('*')
  .eq('state', 'open')
  .order('scheduled_start_at', { ascending: true });
```

**Option B: Fix the token if HTTP is required**

```typescript
// Ensure token is loaded
const MENTU_PROXY_TOKEN = process.env.MENTU_PROXY_TOKEN;
if (!MENTU_PROXY_TOKEN) {
  console.error('[Scheduler] MENTU_PROXY_TOKEN not set!');
}

// Use correct header
const response = await fetch(`${API_URL}/commitments`, {
  headers: {
    'Authorization': `Bearer ${MENTU_PROXY_TOKEN}`,  // Or X-API-Key depending on endpoint
    'Content-Type': 'application/json',
  }
});
```

**Option C: Check environment file on VPS**

```bash
ssh mentu@208.167.255.71 'cat /home/mentu/.mentu.env | grep -E "TOKEN|KEY"'
# Ensure MENTU_PROXY_TOKEN or SUPABASE_SERVICE_ROLE_KEY is set
```

### Verification

```bash
ssh mentu@208.167.255.71 'tail -50 /home/mentu/logs/bridge.log | grep -E "Scheduler|401|commitments"'
# Should see successful fetches, no 401
```

---

## Build Order

1. **Read current implementation**:
   ```bash
   cat src/daemon.ts | head -100
   grep -n "createClient" src/*.ts
   grep -n "Scheduler" src/*.ts
   ```

2. **Fix Supabase client options** in `src/daemon.ts`

3. **Fix scheduler auth** - find scheduler code and fix token/auth

4. **Build**:
   ```bash
   npm run build
   ```

5. **Deploy to VPS** (files sync via SyncThing, or manually):
   ```bash
   ssh mentu@208.167.255.71 'cd /home/mentu/Workspaces/mentu-bridge && git pull && npm run build'
   ```

6. **Restart service**:
   ```bash
   ssh mentu@208.167.255.71 'sudo systemctl restart mentu-bridge'
   ```

7. **Verify fixes**:
   ```bash
   ssh mentu@208.167.255.71 'sleep 30 && tail -100 /home/mentu/logs/bridge.log | grep -E "SUBSCRIBED|TIMED_OUT|401|Scheduler"'
   ```

---

## Verification Checklist

- [ ] Supabase client has realtime options configured
- [ ] `npm run build` passes
- [ ] Bridge restarts cleanly on VPS
- [ ] Logs show `SUBSCRIBED` status (not constant TIMED_OUT loop)
- [ ] Logs show NO `401` errors from Scheduler
- [ ] Bridge stays connected for 5+ minutes without timeout loop

---

## Constraints

- DO NOT change the command execution logic
- DO NOT modify the BugExecutor code (already fixed)
- DO NOT change Supabase table schemas
- MUST maintain backwards compatibility with existing commands

---

*Fix connectivity. Enable autonomous execution.*
