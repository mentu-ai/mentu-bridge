#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""
Feature List Enforcer Hook: Block stop until all features pass.

Reads feature_list.json and blocks agent from stopping if any features
have passes: false. Also runs basic checks (tsc, build, test) if configured.

HOOK EVENT: Stop
INPUT: {"stop_hook_active": bool, ...}
OUTPUT: {} or {"decision": "block", "reason": "..."}

ACTIVATION:
  - Automatic if feature_list.json exists in working directory
  - Respects checks configuration in feature_list.json

MULTI-AGENT ISOLATION:
  - If MENTU_COMMITMENT env var is set, only enforce if it matches the
    commitment in feature_list.json
  - This allows parallel agents working on different commitments to coexist
  - Agent A (cmt_aaa) won't be blocked by Agent B's (cmt_bbb) feature list

RELATION TO OTHER HOOKS:
  - Runs BEFORE mentu_enforcer.py (feature enforcement first)
  - Runs BEFORE tier_validator.py (basic checks before validation)
  - If feature_enforcer passes, other hooks continue

FEATURE_LIST.JSON SCHEMA:
{
  "$schema": "feature-list-v1",
  "instruction_id": "INST-xxx",
  "tier": "T2",
  "mentu": {"commitment": "cmt_xxx"},
  "features": [
    {"id": "F001", "description": "...", "passes": false, "evidence": null}
  ],
  "checks": {"tsc": true, "build": true, "test": false}
}
"""

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Tuple, List, Dict, Any


FEATURE_FILE = "feature_list.json"
SCOPED_FEATURE_DIR = Path(".mentu/feature_lists")


def log_debug(msg: str):
    """Write debug message to stderr."""
    if os.environ.get("MENTU_HOOK_DEBUG"):
        sys.stderr.write(f"[feature_enforcer] {msg}\n")


def get_feature_list_path() -> Path:
    """Resolve feature list path for current commitment.

    Priority:
    1. .mentu/feature_lists/{cmt}.json (commitment-scoped)
    2. feature_list.json (legacy fallback)

    This enables multi-agent isolation: each commitment has its own
    feature list, preventing parallel agents from colliding.
    """
    commitment_id = os.environ.get("MENTU_COMMITMENT")

    if commitment_id:
        scoped_path = SCOPED_FEATURE_DIR / f"{commitment_id}.json"
        if scoped_path.exists():
            log_debug(f"Using scoped feature list: {scoped_path}")
            return scoped_path
        log_debug(f"Scoped path not found: {scoped_path}, falling back to root")

    # Legacy fallback
    root_path = Path(FEATURE_FILE)
    log_debug(f"Using root feature list: {root_path}")
    return root_path


def load_feature_list() -> Tuple[bool, Dict[str, Any]]:
    """Load feature list from resolved path.

    Returns:
        (exists, data) tuple
    """
    feature_path = get_feature_list_path()

    if not feature_path.exists():
        return False, {}

    try:
        with open(feature_path) as f:
            return True, json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        log_debug(f"Failed to load {feature_path}: {e}")
        return False, {}


def should_enforce_for_commitment(file_commitment: str) -> bool:
    """Check if this agent should be enforced by the feature list.

    Multi-agent isolation: If MENTU_COMMITMENT is set in the environment,
    only enforce if it matches the commitment in the feature list.

    This allows parallel agents to work on different commitments without
    blocking each other.

    Args:
        file_commitment: The commitment ID from feature_list.json

    Returns:
        True if enforcement should apply, False to skip
    """
    env_commitment = os.environ.get("MENTU_COMMITMENT")

    # No env var set = enforce (legacy behavior, single-agent mode)
    if not env_commitment:
        log_debug("No MENTU_COMMITMENT env var, enforcing (legacy mode)")
        return True

    # No commitment in file = enforce (malformed file, be safe)
    if not file_commitment or file_commitment == "pending":
        log_debug(f"No valid commitment in file ({file_commitment}), enforcing")
        return True

    # Check if commitments match
    if env_commitment == file_commitment:
        log_debug(f"Commitment match: {env_commitment}, enforcing")
        return True

    # Different commitment = skip enforcement (multi-agent isolation)
    log_debug(f"Commitment mismatch: env={env_commitment} file={file_commitment}, skipping enforcement")
    return False


def check_features_complete(features: List[Dict]) -> Tuple[bool, List[str]]:
    """Check if all features have passes: true.

    Returns:
        (all_complete, incomplete_ids) tuple
    """
    incomplete = [f["id"] for f in features if not f.get("passes")]
    return len(incomplete) == 0, incomplete


def run_check(check_name: str, command: List[str]) -> Tuple[bool, str]:
    """Run a check command and return (passed, message)."""
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            timeout=120,  # 2 minute timeout
            cwd=os.getcwd()
        )
        if result.returncode == 0:
            return True, f"{check_name}: PASS"
        else:
            # Get first line of stderr or stdout for error message
            error = result.stderr.strip() or result.stdout.strip()
            first_line = error.split('\n')[0][:100] if error else "failed"
            return False, f"{check_name}: FAIL - {first_line}"
    except subprocess.TimeoutExpired:
        return False, f"{check_name}: FAIL - timeout (120s)"
    except FileNotFoundError as e:
        return False, f"{check_name}: SKIP - {e.filename} not found"


def run_checks(checks_config: Dict[str, bool]) -> Tuple[bool, List[str]]:
    """Run configured checks (tsc, build, test).

    Returns:
        (all_passed, messages) tuple
    """
    messages = []
    all_passed = True

    if checks_config.get("tsc"):
        passed, msg = run_check("tsc", ["npx", "tsc", "--noEmit"])
        messages.append(msg)
        if not passed:
            all_passed = False

    if checks_config.get("build"):
        passed, msg = run_check("build", ["npm", "run", "build"])
        messages.append(msg)
        if not passed:
            all_passed = False

    if checks_config.get("test"):
        passed, msg = run_check("test", ["npm", "test"])
        messages.append(msg)
        if not passed:
            all_passed = False

    return all_passed, messages


def format_block_reason(
    incomplete_features: List[str],
    check_messages: List[str],
    instruction_id: str,
    commitment_id: str = None
) -> str:
    """Format the block reason message."""
    lines = [
        "## FEATURE LIST INCOMPLETE",
        "",
        f"**Instruction**: `{instruction_id}`",
    ]

    if commitment_id:
        lines.append(f"**Commitment**: `{commitment_id}`")

    lines.append("")

    if incomplete_features:
        lines.append("### Incomplete Features")
        lines.append("")
        for fid in incomplete_features[:5]:  # Show first 5
            lines.append(f"- `{fid}` — passes: false")
        if len(incomplete_features) > 5:
            lines.append(f"- ... and {len(incomplete_features) - 5} more")
        lines.append("")

    if check_messages:
        lines.append("### Checks")
        lines.append("")
        for msg in check_messages:
            status = "✓" if "PASS" in msg else "✗"
            lines.append(f"- {status} {msg}")
        lines.append("")

    lines.extend([
        "### Next Steps",
        "",
        "1. Complete each pending feature",
        "2. After completion: `mentu capture \"Completed F00X: description\"`",
        "3. Update feature_list.json: set `passes: true` and `evidence: mem_xxx`",
        "4. When all features pass, submit: `mentu submit <cmt_id> --summary \"...\"`",
    ])

    return "\n".join(lines)


def main():
    """Main entry point."""
    try:
        input_data = json.load(sys.stdin)
    except json.JSONDecodeError:
        input_data = {}

    # Check for stop loop prevention
    if input_data.get("stop_hook_active"):
        print(json.dumps({}))
        sys.exit(0)

    # Load feature_list.json
    exists, data = load_feature_list()

    if not exists:
        # No feature list = no enforcement from this hook
        log_debug("No feature_list.json found, allowing stop")
        print(json.dumps({}))
        sys.exit(0)

    instruction_id = data.get("instruction_id", "unknown")
    commitment_id = data.get("mentu", {}).get("commitment")
    features = data.get("features", [])
    checks_config = data.get("checks", {})
    status = data.get("status", "in_progress")

    log_debug(f"instruction={instruction_id} features={len(features)} status={status}")

    # Multi-agent isolation check
    if not should_enforce_for_commitment(commitment_id):
        log_debug("Skipping enforcement due to commitment mismatch (multi-agent isolation)")
        print(json.dumps({}))
        sys.exit(0)

    # If already marked complete, allow stop
    if status == "complete":
        log_debug("Feature list status=complete, allowing stop")
        print(json.dumps({}))
        sys.exit(0)

    # Check features
    features_complete, incomplete = check_features_complete(features)
    log_debug(f"features_complete={features_complete} incomplete={incomplete}")

    # Run checks if any configured
    checks_passed = True
    check_messages = []
    if checks_config:
        checks_passed, check_messages = run_checks(checks_config)
        log_debug(f"checks_passed={checks_passed} messages={check_messages}")

    # Determine if we should block
    if features_complete and checks_passed:
        log_debug("All features pass and checks pass, allowing stop")
        print(json.dumps({}))
        sys.exit(0)

    # Block with reason
    reason = format_block_reason(
        incomplete,
        check_messages,
        instruction_id,
        commitment_id
    )

    print(json.dumps({
        "decision": "block",
        "reason": reason
    }))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Fail-safe: on error, allow stop
        sys.stderr.write(f"Feature enforcer error: {e}\n")
        print(json.dumps({}))
        sys.exit(0)