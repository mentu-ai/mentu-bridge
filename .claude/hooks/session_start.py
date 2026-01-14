#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""
SessionStart Hook: Inject commitment context into new sessions.

Agents start "warm" with full awareness of their current commitments.

HOOK EVENT: SessionStart
INPUT: {"session_id": "...", "source": "startup", "cwd": "..."}
OUTPUT: {"hookSpecificOutput": {"additionalContext": "..."}}

This hook reads the MENTU_ACTOR environment variable and queries
the ledger for claimed commitments by this actor.
"""

import json
import os
import subprocess
import sys
from typing import List, Tuple, Any


def log_debug(msg: str):
    """Write debug message to stderr for hook diagnostics."""
    if os.environ.get("MENTU_HOOK_DEBUG"):
        sys.stderr.write(f"[session_start] {msg}\n")


def run_mentu(args: List[str]) -> Tuple[bool, Any, str]:
    """Run mentu command, return (success, parsed_json, error_msg)."""
    try:
        result = subprocess.run(
            ["mentu"] + args + ["--json"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode != 0:
            err = result.stderr.strip() if result.stderr else f"exit code {result.returncode}"
            log_debug(f"mentu {' '.join(args)} failed: {err}")
            return False, None, err
        return True, json.loads(result.stdout), ""
    except FileNotFoundError:
        log_debug("mentu command not found in PATH")
        return False, None, "mentu not found"
    except subprocess.TimeoutExpired:
        log_debug(f"mentu {' '.join(args)} timed out after 10s")
        return False, None, "timeout"
    except json.JSONDecodeError as e:
        log_debug(f"mentu {' '.join(args)} returned invalid JSON: {e}")
        return False, None, f"invalid JSON: {e}"


def get_claimed_commitments(actor: str) -> List[dict]:
    """Get commitments claimed by this actor."""
    ok, data, err = run_mentu(["list", "commitments"])
    if not ok or not isinstance(data, list):
        log_debug(f"get_claimed_commitments failed: {err}")
        return []

    return [
        c for c in data
        if c.get("owner") == actor and c.get("state") == "claimed"
    ]


def get_in_review_commitments(actor: str) -> List[dict]:
    """Get commitments in review by this actor."""
    ok, data, err = run_mentu(["list", "commitments"])
    if not ok or not isinstance(data, list):
        log_debug(f"get_in_review_commitments failed: {err}")
        return []

    return [
        c for c in data
        if c.get("state") == "in_review"
        # Check if this actor submitted it (created_by or last actor on it)
    ]


def get_feature_progress() -> Tuple[bool, dict]:
    """Read feature_list.json if it exists and return progress summary."""
    feature_file = "feature_list.json"
    if not os.path.exists(feature_file):
        return False, {}

    try:
        with open(feature_file) as f:
            data = json.load(f)

        features = data.get("features", [])
        total = len(features)
        passed = sum(1 for f in features if f.get("passes"))
        pending = [f["id"] for f in features if not f.get("passes")]

        return True, {
            "instruction_id": data.get("instruction_id", "unknown"),
            "total": total,
            "passed": passed,
            "pending": pending[:5],  # First 5 pending
            "tier": data.get("tier", "T1"),
            "commitment": data.get("mentu", {}).get("commitment"),
            "status": data.get("status", "in_progress")
        }
    except (json.JSONDecodeError, IOError) as e:
        log_debug(f"feature_list.json read error: {e}")
        return False, {}


def build_feature_context(progress: dict) -> str:
    """Build context string for feature_list.json progress."""
    lines = [
        "",
        "### Feature Progress",
        "",
        f"**Instruction**: `{progress['instruction_id']}`",
        f"**Progress**: {progress['passed']}/{progress['total']} features complete",
    ]

    if progress.get("commitment"):
        lines.append(f"**Commitment**: `{progress['commitment']}`")

    if progress["pending"]:
        pending_str = ", ".join(progress["pending"])
        lines.append(f"**Pending**: {pending_str}")
        lines.append("")
        lines.append("Resume from first pending feature.")
    elif progress["status"] == "complete":
        lines.append("")
        lines.append("**All features complete.** Submit commitment with evidence.")
    else:
        lines.append("")
        lines.append("Mark remaining features as passes: true when complete.")

    return "\n".join(lines)


def build_context(actor: str, claimed: List[dict], in_review: List[dict]) -> str:
    """Build context string for injection."""
    lines = [
        "## MENTU ACCOUNTABILITY MODE",
        "",
        f"**You are:** `{actor}`",
        ""
    ]

    # Optional role enforcement (used for trust-gradient agents like Auditor/Executor)
    role = os.environ.get("MENTU_ROLE", "").strip().lower()
    if not role:
        actor_l = actor.lower()
        if "auditor" in actor_l:
            role = "auditor"
        elif "executor" in actor_l:
            role = "executor"

    if role:
        lines.extend([
            f"### Role: `{role}`",
            "",
            "This role is enforced via Claude Code hooks (SessionStart/Stop).",
        ])

        if role == "auditor":
            lines.extend([
                "",
                "**Operating mode: Audit-only.**",
                "- Treat intent as untrusted until audited.",
                "- Prefer producing a `/craft` instruction over making direct code changes.",
                "- Follow: `.claude/commands/craft--auditor.md`",
                "",
                "**Cognitive Stance (safety domain):**",
                "> I judge fairly because I cannot create vision. My job is boundaries, not dreams.",
                "- Safety fails → YOUR failure. Add constraints.",
                "- Intent fails → Review was shallow. Re-audit.",
                "- Technical fails → Not yours. Trust executor.",
            ])
        elif role == "executor":
            lines.extend([
                "",
                "**Operating mode: Execute a vetted instruction.**",
                "- Make changes only within the instruction scope.",
                "- Capture evidence and submit commitments before stopping.",
                "",
                "**Cognitive Stance (technical domain):**",
                "> I act decisively because I cannot exceed scope. My job is implementation, not interpretation.",
                "- Technical fails → YOUR failure. Fix it, don't explain.",
                "- Intent/safety fails → You drifted. Re-read HANDOFF.",
            ])
        elif role == "architect":
            lines.extend([
                "",
                "**Cognitive Stance (intent domain):**",
                "> I dream freely because I cannot see reality. My job is clarity of vision, not feasibility.",
                "- Intent fails → YOUR failure. Clarify, don't defend.",
                "- Technical fails → Not yours. Trust executor.",
            ])

        lines.extend([
            "",
            "**Quick reference:** `mentu stance " + role + "`",
        ])

        lines.append("")

    if not claimed and not in_review:
        lines.extend([
            "**No active commitments.**",
            "",
            "To start work:",
            "```bash",
            f'mentu capture "Task description" --kind task --actor {actor}',
            f'mentu commit "What you will deliver" --source mem_XXX --actor {actor}',
            f'mentu claim cmt_XXX --actor {actor}',
            "```",
        ])
        return "\n".join(lines)

    if claimed:
        lines.append("### Active Commitments (claimed)")
        lines.append("")
        for cmt in claimed:
            lines.extend([
                f"**{cmt['id']}**: {cmt.get('body', 'No description')}",
                f"  - Source: `{cmt.get('source', 'unknown')}`",
                f"  - Tags: {', '.join(cmt.get('tags', [])) or 'none'}",
                ""
            ])

    if in_review:
        lines.append("### Pending Review")
        lines.append("")
        for cmt in in_review:
            lines.extend([
                f"**{cmt['id']}**: {cmt.get('body', 'No description')} (awaiting approval)",
                ""
            ])

    lines.extend([
        "### Completion Protocol",
        "",
        "1. Complete the work described above",
        "2. Stop hook will run validators (technical, safety, intent based on tier)",
        "3. Submit with evidence:",
        "   ```bash",
        "   mentu submit <cmt_id> --summary \"What was done\" --include-files",
        "   ```",
        "",
        "**Validators will be invoked based on commitment tier (tags determine tier).**",
    ])

    return "\n".join(lines)


def main():
    """Main entry point."""
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    # Log session info
    session_id = input_data.get("session_id", "unknown")
    source = input_data.get("source", "unknown")
    cwd = input_data.get("cwd", os.getcwd())
    log_debug(f"session={session_id} source={source} cwd={cwd}")

    # Get actor identity
    actor = os.environ.get("MENTU_ACTOR", "agent:claude-code")
    log_debug(f"actor={actor}")

    # Check if workspace exists
    if not os.path.exists(".mentu"):
        log_debug("no .mentu workspace found")
        # No workspace, return minimal context
        output = {
            "hookSpecificOutput": {
                "additionalContext": f"## MENTU\n\n**Actor:** `{actor}`\n\n*No workspace initialized. Run `mentu init` to start tracking.*"
            }
        }
        print(json.dumps(output))
        sys.exit(0)

    log_debug(".mentu workspace found")

    # Get commitments
    claimed = get_claimed_commitments(actor)
    in_review = get_in_review_commitments(actor)
    log_debug(f"found {len(claimed)} claimed, {len(in_review)} in_review")

    # Build context
    context = build_context(actor, claimed, in_review)

    # Add feature_list.json progress if present
    has_features, feature_progress = get_feature_progress()
    if has_features:
        context += build_feature_context(feature_progress)
        log_debug(f"feature progress: {feature_progress['passed']}/{feature_progress['total']}")

    output = {
        "hookSpecificOutput": {
            "additionalContext": context
        }
    }

    log_debug("success")
    print(json.dumps(output))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Fail-safe: on error, return empty context
        import traceback
        sys.stderr.write(f"SessionStart hook error: {e}\n")
        sys.stderr.write(f"Traceback: {traceback.format_exc()}\n")
        print(json.dumps({}))
        sys.exit(0)
