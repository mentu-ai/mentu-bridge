# PRD: Architecture Completion for mentu-bridge

**Mode:** Architect
**Author:** agent:claude-architect
**Date:** 2026-01-03
**Target:** mentu-bridge repository

---

## Context

mentu-bridge is the **Hands** of the Mentu organism—the execution layer that carries out commands on the local machine. It's a Node.js daemon running via launchd on macOS.

Current state:
- ✅ `.mentu/manifest.yaml` exists
- ✅ `.mentu/ledger.jsonl` exists
- ✅ `CLAUDE.md` exists
- ❌ `.mentu/genesis.key` missing
- ❌ `.mentu/config.yaml` missing

---

## What Must Be Done

### 1. Create genesis.key

**Location:** `.mentu/genesis.key`

**Requirements:**
- Actor: `agent:bridge-daemon` (from manifest.yaml)
- Role: Local execution daemon
- Permitted operations: `capture`, `commit`, `claim`, `close`, `annotate`
- The bridge is an EXECUTOR - it needs full lifecycle permissions
- It claims work, executes, and closes with evidence
- Trust gradient enabled with architect/auditor/executor roles
- Owner: Rashid Azarang

### 2. Create config.yaml

**Location:** `.mentu/config.yaml`

**Requirements:**
- Use environment variable references (no hardcoded secrets)
- Reference `${MENTU_API_URL}` for proxy URL
- Reference `${MENTU_WORKSPACE_ID}` for workspace
- Cloud enabled for Supabase realtime subscription
- Integrations: both disabled (bridge executes, doesn't ingest webhooks)

---

## Design Constraints

1. **The bridge is a TRUSTED executor** — it runs code on local machines
2. **Full commitment lifecycle** — claim, execute, close with evidence
3. **Captures memories** — task (before) and evidence (after) for every execution
4. **Local daemon** — runs via launchd, needs restart on config change

---

## Reference

Use mentu-ai/.mentu/genesis.key as the canonical schema reference.
Use claude-code/.mentu/ for recently created examples.

---

*Strategic intent only. Auditor will validate and produce implementation instructions.*
