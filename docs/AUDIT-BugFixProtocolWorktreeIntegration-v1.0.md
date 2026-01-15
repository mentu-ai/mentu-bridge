---
id: AUDIT-BugFixProtocolWorktreeIntegration-v1.0
path: docs/AUDIT-BugFixProtocolWorktreeIntegration-v1.0.md
type: audit
intent: reference

version: "1.0"
created: 2026-01-14
last_updated: 2026-01-14

intent_ref: n/a
craft_ref: pending

auditor: agent:claude-code
checkpoint:
  git_sha: pending
  timestamp: 2026-01-14T00:00:00Z

verdict: ASSESS_FEASIBILITY
verdict_timestamp: 2026-01-14T00:00:00Z

mentu:
  evidence: pending
  status: assessment
---

# Audit: BugFixProtocol Worktree Integration

> **Question**: What must exist to add this workflow to BUG-FIX-PROTOCOL.md?
>
> **Scope**: Text-driven instructions for Claude to execute worktree + tmux + ledger workflow
>
> **Outcome**: Assessment of dependencies, gaps, and readiness

---

## Proposed Workflow (from User Request)

```
For each bug:
├─ Create worktree: git worktree add --detach ./work/{cmt_id} main
├─ Record to ledger: capture (kind: execution_start, meta: {state: starting})
├─ Spawn tmux session: tmux new-session -d -s bug_{cmt_id}
├─ In session: claude --max-turns 50 "Fix this bug..."
│  └─ Claude Code checkpointing auto-tracks all edits
│  └─ User can /rewind if needed
├─ Claude commits, closes commitment
├─ Executor records: annotate (meta: {state: completed, merge_ready})
├─ Merge worktree: git merge --no-ff work/{cmt_id}
└─ Cleanup: git worktree remove work/{cmt_id}
```

---

## Prerequisites Assessment

### 1. Environment & Tools

| Requirement | Status | Check |
|-------------|--------|-------|
| **Git** | ✅ Assumed available | `git --version` |
| **tmux** | ✅ Assumed available | `tmux -V` |
| **mentu CLI** | ✅ Assumed available | `mentu --version` |
| **Claude CLI** | ✅ Assumed available | `claude --version` |
| **CLAUDE_CODE_OAUTH_TOKEN** | ✅ Should be set | `echo $CLAUDE_CODE_OAUTH_TOKEN` |
| **MENTU_COMMITMENT** | ❓ May need setting | Should be set by executor |
| **MENTU_API_URL** | ❓ May need setting | Should point to mentu-proxy |
| **MENTU_PROXY_TOKEN** | ❓ May need setting | Authentication for mentu-proxy |

**Assessment**: Most tools exist. Environment variables need verification in BUG-FIX-PROTOCOL.

---

### 2. Ledger Operations Support

| Operation | Required | Available | Notes |
|-----------|----------|-----------|-------|
| **capture** (kind: execution_start) | YES | ✅ mentu CLI supports | Need to verify output format |
| **annotate** (target: memory_id) | YES | ✅ mentu CLI supports | Need to verify output format |
| **claim** (on commitment) | YES | ✅ mentu CLI supports | Already part of commitment flow |
| **close** (on commitment) | YES | ✅ mentu CLI supports | Already part of commitment flow |
| **JSON output** | YES | ✅ mentu supports `--json` flag | Critical for scripting |

**Assessment**: All operations exist. Need to test JSON output parsing.

---

### 3. Git Worktree Support

| Feature | Status | Check |
|---------|--------|-------|
| **git worktree add** | ✅ Standard Git | `git worktree list` |
| **Detached HEAD** | ✅ Standard Git | `git worktree add --detach` |
| **Branch from main** | ✅ Depends on repo | Repo must have 'main' branch |
| **Merge --no-ff** | ✅ Standard Git | `git merge --no-ff` |
| **Worktree remove** | ✅ Standard Git | `git worktree remove` |

**Assessment**: All git features standard. Only assumption: 'main' branch exists.

---

### 4. tmux Session Support

| Feature | Status | Notes |
|---------|--------|-------|
| **tmux new-session -d** | ✅ Detached mode | Session runs in background |
| **-s session-name** | ✅ Naming | Can use `bug_{commitment_id}` |
| **-c directory** | ✅ Working directory | Can set to `./work/{cmt_id}` |
| **Command execution** | ✅ Direct command | Can run `claude ...` in session |
| **Session inspection** | ✅ Standard tmux | `tmux list-sessions`, `tmux capture-pane` |

**Assessment**: All tmux features standard. User can inspect sessions manually.

---

### 5. Claude Code Integration

| Feature | Status | How It Works |
|---------|--------|--------------|
| **Checkpointing** | ✅ Native | Automatically tracks file edits per prompt |
| **/rewind command** | ✅ Native | User can revert to prior checkpoints |
| **--max-turns** | ✅ CLI flag | Limits conversation turns |
| **Working directory** | ✅ Via -cwd | tmux session sets `cwd: ./work/{cmt_id}` |
| **BUG-FIX-PROTOCOL.md reading** | ✅ Native | Claude can read local files with Read tool |

**Assessment**: Claude Code fully supports this workflow. Checkpointing provides safety net.

---

## Text-Driven Instruction Analysis

### What BUG-FIX-PROTOCOL Must Specify

The protocol document needs to tell Claude:

#### A. **Setup Phase** (before spawning)
- ✅ What working directory to expect (or is it already set?)
- ✅ What commitment_id and memory_id to use
- ✅ What environment variables are available
- ✅ Where to find the bug description

#### B. **Investigation Phase** (in tmux session)
- ✅ How to read bug description from memory
- ✅ How to understand the codebase
- ✅ How to run tests
- ✅ How to verify the fix

#### C. **Fix Phase**
- ✅ File modification rules
- ✅ Testing requirements
- ✅ Commit message format
- ✅ When to stop (evidence required)

#### D. **Closure Phase**
- ✅ What commands to run to capture evidence
- ✅ What commands to run to close commitment
- ✅ How to verify closure

#### E. **Recovery** (if things go wrong)
- ✅ How to use /rewind if edits are bad
- ✅ How to annotate commitment if blocked
- ✅ When to give up (mark intervention_required)

---

## Critical Dependencies

### Must Exist Before BUG-FIX-PROTOCOL Can Be Executed

| Dependency | Status | Risk |
|------------|--------|------|
| **SimpleBugExecutor v1.0 deployed** | ❓ In progress | BLOCKING - executor creates worktree |
| **mentu CLI with capture/annotate** | ✅ Exists | Low |
| **mentu-proxy /ops endpoint** | ✅ Likely exists | Low |
| **Bug description in memory** | ✅ From webhook | Low |
| **Commitment created** | ✅ From webhook | Low |
| **BUG-FIX-PROTOCOL.md in repo** | ❓ Needs creation | BLOCKING - Claude reads this |
| **Git repo with 'main' branch** | ✅ Assumed | Low |
| **Repo has proper test suite** | ❓ Per-repo | Low (can skip tests) |

---

## Gaps & Solutions

### Gap 1: How Does Claude Know Its Working Directory?

**Current**: SimpleBugExecutor spawns with `cwd: ./work/{commitment_id}`

**Solution**: Document in BUG-FIX-PROTOCOL:
```markdown
## Your Working Environment

You are running in an isolated worktree at: `./work/{commitment_id}/`

This directory is a complete copy of the repository. All your edits here are isolated.
The main repo will NOT be affected until you finish and the worktree is merged.

You can verify:
\`\`\`bash
pwd  # Should show ./work/{commitment_id}
\`\`\`
```

### Gap 2: How Does Claude Access Commitment & Memory IDs?

**Current**: SimpleBugExecutor sets environment variables `MENTU_COMMITMENT`, `MENTU_API_URL`, `MENTU_PROXY_TOKEN`

**Solution**: Document in BUG-FIX-PROTOCOL:
```markdown
## Your Commitment IDs

Environment variables are set for you:
- `$MENTU_COMMITMENT` - The commitment ID you must close
- `$MENTU_PROXY_TOKEN` - Authentication token
- `$MENTU_API_URL` - API endpoint

To fetch your bug description:
\`\`\`bash
mentu show $MENTU_COMMITMENT --json | jq '.payload.body'
\`\`\`
```

### Gap 3: How Does Claude Record Evidence to Ledger?

**Current**: SimpleExecutor records completion via HTTP to mentu-proxy

**New**: Claude should record it directly:
```markdown
## Capturing Evidence

After fixing the bug, capture your evidence:

\`\`\`bash
EVIDENCE=$(mentu capture "Fixed: Brief description" \
  --kind implementation-evidence \
  --actor agent:claude-vps \
  --json | jq -r '.id')

mentu close $MENTU_COMMITMENT \
  --evidence $EVIDENCE \
  --actor agent:claude-vps
\`\`\`
```

### Gap 4: How Does tmux Session Get Tracked?

**Current**: SimpleBugExecutor records tmux session name in ledger

**Question**: Should Claude also record it, or is it handled by executor?

**Solution**: Executor should record it (Claude doesn't know its own session name).

### Gap 5: How Does Merging Happen?

**Current**: Executor polls ledger, checks if commitment closed, then merges

**Question**: Should this be automatic or manual?

**Solution**: Manual for v1.0. BUG-FIX-PROTOCOL can document:
```markdown
## After Closing

Once you've closed the commitment:

\`\`\`bash
mentu close $MENTU_COMMITMENT --evidence $EVIDENCE
\`\`\`

The executor will:
1. Detect the closed commitment
2. Merge your worktree back to main
3. Clean up the isolated directory

You can monitor:
\`\`\`bash
mentu show $MENTU_COMMITMENT  # Check state
tmux list-sessions            # See all active bug sessions
\`\`\`
```

---

## BUG-FIX-PROTOCOL.md Structure (Required)

The document needs these sections:

```markdown
# BUG-FIX-PROTOCOL.md

## 1. Your Environment
- Working directory (isolated worktree)
- Environment variables available
- Tools available (git, mentu, claude)

## 2. Understanding Your Bug
- How to fetch bug description from memory
- How to read codebase (CLAUDE.md, file structure)
- How to run tests

## 3. Investigation Steps
- Search for relevant files
- Read code to understand problem
- Form hypothesis

## 4. Fix Guidelines
- Minimal changes only
- Preserve existing behavior
- Run tests frequently

## 5. Verification
- Type checking (tsc)
- Tests (npm test)
- Build (npm run build)

## 6. Committing Your Work
- Git commit message format
- Push changes

## 7. Closing the Commitment
- Capture evidence command
- Close commitment command
- Verify closure

## 8. Recovery (If Blocked)
- How to use /rewind
- How to annotate commitment
- When to give up

## 9. Constraints
- Max 5 files changed
- No package.json
- No config files
```

---

## Readiness Assessment

### What Must Happen BEFORE This Works

1. **✅ SimpleBugSpawn v1.0 Complete**
   - CLI arg spawn working
   - Minimal prompt working
   - MAX_TURNS set to 50

2. **❓ Environment Variable Passing**
   - Verify `MENTU_COMMITMENT` is set in spawned process
   - Verify `MENTU_API_URL` is set
   - Verify `MENTU_PROXY_TOKEN` is set

3. **❓ mentu CLI JSON Output**
   - Test `mentu capture ... --json` output format
   - Test `mentu show ... --json` output format
   - Verify jq parsing works

4. **✅ Git Worktree Creation**
   - SimpleBugExecutor creates `./work/{commitment_id}/`
   - Claude runs in that directory
   - Verified via pwd

5. **❓ BUG-FIX-PROTOCOL.md in Repo**
   - Create template document
   - Include all sections above
   - Make it repo-specific

6. **❓ Testing on Target Repo**
   - Pick test repository
   - Create BUG-FIX-PROTOCOL.md
   - Create fake bug commitment
   - Manually test workflow
   - Verify worktree merge works

---

## Verdict

### Can This Be Added to BUG-FIX-PROTOCOL?

**YES, with conditions**:

| Condition | Status | Action |
|-----------|--------|--------|
| SimpleBugSpawn v1.0 working | ⏳ In progress | Complete HANDOFF-SimpleBugSpawn-v1.0 first |
| Environment variables verified | ❓ Unclear | Add logging to SimpleBugExecutor to confirm vars set |
| mentu CLI JSON output tested | ❓ Unclear | Quick test: `mentu capture ... --json \| jq` |
| BUG-FIX-PROTOCOL template created | ❓ Not started | Create template with all sections |
| Integration test on real repo | ❓ Not started | Run end-to-end test before shipping |

### Timeline

1. **Complete v1.0 HANDOFF** (spawn + prompt + protocol template)
2. **Create BUG-FIX-PROTOCOL-TEMPLATE.md** with worktree/tmux/ledger sections
3. **Test environment variables** (5 min)
4. **Test mentu JSON output** (5 min)
5. **Integration test on inline-substitute** (30 min)
6. **Document in CLAUDE.md** how to create per-repo BUG-FIX-PROTOCOL.md

---

## Summary

**The workflow is fully feasible.** All tools exist. What's needed:

1. ✅ SimpleBugExecutor creates worktree
2. ✅ SimpleBugExecutor sets environment variables
3. ✅ BUG-FIX-PROTOCOL.md documents the full workflow
4. ✅ Claude reads protocol and follows it
5. ✅ User can inspect tmux sessions manually
6. ✅ Claude commits and closes commitment
7. ✅ SimpleBugExecutor merges worktree automatically

**This is text-driven, not process-driven. Claude just reads and executes.**

---

## Recommended Next Steps

1. **Complete SimpleBugSpawn v1.0** (finish HANDOFF-SimpleBugSpawn-v1.0)
2. **Create BUG-FIX-PROTOCOL-TEMPLATE.md** with complete instructions including:
   - Worktree info
   - Environment variables
   - Commitment closure commands
   - Recovery via /rewind
3. **Add to inline-substitute repo** as real example
4. **Run integration test**: Create fake bug → spawn → verify closure → check merged
5. **Document** in mentu-ai/CLAUDE.md how to create project-specific BUG-FIX-PROTOCOL.md

---

*Audit complete. Readiness: HIGH (pending v1.0 completion)*
