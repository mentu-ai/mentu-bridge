#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Shared utilities for multi-agent completion handling.

This module provides thread-safe, atomic operations for managing
agent-scoped completion contracts. Supports both:
- completion.json (v3.0 multi-agent schema) - legacy
- feature_list.json (v1 schema) - preferred

Feature List takes priority when present. It replaces completion.json
as the Executor's contract with a simpler feature-based tracking model.

v3.0 Schema (completion.json - legacy):
{
  "version": "3.0",
  "schema": "multi-agent",
  "agents": {
    "agent:foo": { ... contract ... },
    "agent:bar": { ... contract ... }
  },
  "defaults": { ... }
}

v1 Schema (feature_list.json - preferred):
{
  "$schema": "feature-list-v1",
  "instruction_id": "HANDOFF-xxx",
  "tier": "T2",
  "mentu": {"commitment": "cmt_xxx"},
  "features": [{"id": "F001", "passes": false, "evidence": null}],
  "checks": {"tsc": true, "build": true}
}
"""

import fcntl
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

CONTRACT_FILE = Path(".claude/completion.json")
FEATURE_LIST_FILE = Path("feature_list.json")
STATE_DIR = Path(".claude/state")


def get_agent_id() -> str:
    """Get current agent's identity.

    Priority:
    1. MENTU_ACTOR environment variable (explicit)
    2. CLAUDE_SESSION_ID environment variable (session-based fallback)
    3. "default" (last resort)
    """
    # Explicit actor from environment
    actor = os.environ.get("MENTU_ACTOR")
    if actor:
        return actor

    # Session-based fallback
    session_id = os.environ.get("CLAUDE_SESSION_ID", "default")
    return f"session:{session_id}"


def load_completion() -> dict:
    """Load completion.json with shared (read) lock.

    Returns empty v3.0 structure if file doesn't exist.
    """
    if not CONTRACT_FILE.exists():
        return {"version": "3.0", "schema": "multi-agent", "agents": {}}

    with open(CONTRACT_FILE, "r") as f:
        fcntl.flock(f, fcntl.LOCK_SH)
        try:
            return json.load(f)
        except json.JSONDecodeError:
            return {"version": "3.0", "schema": "multi-agent", "agents": {}}
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def get_agent_contract(agent_id: Optional[str] = None) -> dict:
    """Get contract for specific agent (defaults to current).

    Args:
        agent_id: Agent identifier. If None, uses get_agent_id().

    Returns:
        Agent's contract dict, or empty dict if not found.
    """
    if agent_id is None:
        agent_id = get_agent_id()

    data = load_completion()

    # v3.0 multi-agent schema
    if data.get("schema") == "multi-agent":
        return data.get("agents", {}).get(agent_id, {})

    # v2.0 single-agent (backward compat)
    # In v2.0, the entire file IS the contract
    return data


def migrate_v2_to_v3(v2_data: dict, agent_id: str) -> dict:
    """Migrate v2.0 single-agent to v3.0 multi-agent schema.

    The existing v2.0 contract becomes the first agent's namespace.
    """
    return {
        "version": "3.0",
        "schema": "multi-agent",
        "agents": {
            agent_id: {
                "name": v2_data.get("name", "Migrated"),
                "started": datetime.now(timezone.utc).isoformat(),
                "required_files": v2_data.get("required_files", []),
                "checks": v2_data.get("checks", {}),
                "commands": v2_data.get("commands", []),
                "mentu": v2_data.get("mentu"),
                "max_iterations": v2_data.get("max_iterations", 50),
            }
        },
        "defaults": {
            "checks": {"tsc": True, "build": True},
            "max_iterations": 50
        }
    }


def save_agent_contract(contract: dict, agent_id: Optional[str] = None) -> None:
    """Atomically save agent's contract with exclusive lock.

    If the file is v2.0, migrates to v3.0 first. Preserves other agents' contracts.

    Args:
        contract: The contract dict to save for this agent.
        agent_id: Agent identifier. If None, uses get_agent_id().
    """
    if agent_id is None:
        agent_id = get_agent_id()

    CONTRACT_FILE.parent.mkdir(exist_ok=True)

    # Create file if it doesn't exist
    if not CONTRACT_FILE.exists():
        initial = {
            "version": "3.0",
            "schema": "multi-agent",
            "agents": {},
            "defaults": {
                "checks": {"tsc": True, "build": True},
                "max_iterations": 50
            }
        }
        CONTRACT_FILE.write_text(json.dumps(initial, indent=2))

    with open(CONTRACT_FILE, "r+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            try:
                data = json.load(f)
            except json.JSONDecodeError:
                data = {"version": "3.0", "schema": "multi-agent", "agents": {}}

            # Migrate v2.0 to v3.0 if needed
            if data.get("version") == "2.0" or data.get("schema") != "multi-agent":
                data = migrate_v2_to_v3(data, agent_id)

            # Ensure agents dict exists
            if "agents" not in data:
                data["agents"] = {}

            # Update agent's namespace
            contract["updated"] = datetime.now(timezone.utc).isoformat()
            if "started" not in contract and agent_id not in data["agents"]:
                contract["started"] = datetime.now(timezone.utc).isoformat()
            elif agent_id in data["agents"] and "started" in data["agents"][agent_id]:
                contract["started"] = data["agents"][agent_id]["started"]

            data["agents"][agent_id] = contract

            f.seek(0)
            f.truncate()
            json.dump(data, f, indent=2)
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def remove_agent_contract(agent_id: Optional[str] = None) -> bool:
    """Remove an agent's contract from completion.json.

    Args:
        agent_id: Agent identifier. If None, uses get_agent_id().

    Returns:
        True if agent was removed, False if agent didn't exist.
    """
    if agent_id is None:
        agent_id = get_agent_id()

    if not CONTRACT_FILE.exists():
        return False

    with open(CONTRACT_FILE, "r+") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            data = json.load(f)

            if data.get("schema") != "multi-agent":
                return False

            if agent_id not in data.get("agents", {}):
                return False

            del data["agents"][agent_id]

            f.seek(0)
            f.truncate()
            json.dump(data, f, indent=2)
            return True
        except json.JSONDecodeError:
            return False
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def list_agents() -> list[str]:
    """List all agent IDs with contracts.

    Returns:
        List of agent identifiers.
    """
    data = load_completion()
    if data.get("schema") == "multi-agent":
        return list(data.get("agents", {}).keys())
    # v2.0 has no agent namespace
    return []


def get_defaults() -> dict:
    """Get default contract values.

    Returns:
        Defaults dict from v3.0 schema, or sensible defaults.
    """
    data = load_completion()
    return data.get("defaults", {
        "checks": {"tsc": True, "build": True},
        "max_iterations": 50
    })


# ─────────────────────────────────────────────────────────────
# Agent State Management (per-agent state files)
# ─────────────────────────────────────────────────────────────

def get_state_file(agent_id: Optional[str] = None) -> Path:
    """Get path to agent's state file.

    Each agent has its own state file to avoid cross-contamination.
    """
    if agent_id is None:
        agent_id = get_agent_id()

    # Sanitize agent_id for filename (replace : with -)
    safe_id = agent_id.replace(":", "-").replace("/", "-")
    return STATE_DIR / f"{safe_id}.json"


def load_agent_state(agent_id: Optional[str] = None) -> dict:
    """Load state for specific agent.

    Args:
        agent_id: Agent identifier. If None, uses get_agent_id().

    Returns:
        Agent's state dict with iteration count.
    """
    state_file = get_state_file(agent_id)
    if state_file.exists():
        try:
            return json.loads(state_file.read_text())
        except json.JSONDecodeError:
            pass
    return {"iteration": 0}


def save_agent_state(state: dict, agent_id: Optional[str] = None) -> None:
    """Save state for specific agent.

    Args:
        state: State dict to save.
        agent_id: Agent identifier. If None, uses get_agent_id().
    """
    state_file = get_state_file(agent_id)
    state_file.parent.mkdir(parents=True, exist_ok=True)
    state_file.write_text(json.dumps(state, indent=2))


def reset_agent_state(agent_id: Optional[str] = None) -> None:
    """Reset state for specific agent.

    Args:
        agent_id: Agent identifier. If None, uses get_agent_id().
    """
    state_file = get_state_file(agent_id)
    state_file.unlink(missing_ok=True)


# ─────────────────────────────────────────────────────────────
# Feature List Support (v1 schema - preferred)
# ─────────────────────────────────────────────────────────────

def has_feature_list() -> bool:
    """Check if feature_list.json exists."""
    return FEATURE_LIST_FILE.exists()


def load_feature_list() -> dict:
    """Load feature_list.json.

    Returns empty dict if file doesn't exist.
    """
    if not FEATURE_LIST_FILE.exists():
        return {}

    try:
        return json.loads(FEATURE_LIST_FILE.read_text())
    except json.JSONDecodeError:
        return {}


def get_feature_progress() -> dict:
    """Get feature progress summary.

    Returns:
        Dict with total, passed, pending counts and feature IDs.
    """
    data = load_feature_list()
    if not data:
        return {"exists": False}

    features = data.get("features", [])
    passed = [f for f in features if f.get("passes")]
    pending = [f for f in features if not f.get("passes")]

    return {
        "exists": True,
        "instruction_id": data.get("instruction_id", "unknown"),
        "tier": data.get("tier", "T1"),
        "commitment": data.get("mentu", {}).get("commitment"),
        "total": len(features),
        "passed": len(passed),
        "pending_count": len(pending),
        "pending_ids": [f["id"] for f in pending[:5]],
        "status": data.get("status", "in_progress"),
        "checks": data.get("checks", {})
    }


def update_feature(feature_id: str, passes: bool, evidence: Optional[str] = None) -> bool:
    """Update a feature's status in feature_list.json.

    Args:
        feature_id: The feature ID (e.g., "F001")
        passes: Whether the feature passes
        evidence: Optional Mentu memory ID

    Returns:
        True if updated, False if feature not found or error.
    """
    if not FEATURE_LIST_FILE.exists():
        return False

    try:
        data = json.loads(FEATURE_LIST_FILE.read_text())
        features = data.get("features", [])

        for f in features:
            if f.get("id") == feature_id:
                f["passes"] = passes
                if evidence:
                    f["evidence"] = evidence
                FEATURE_LIST_FILE.write_text(json.dumps(data, indent=2))
                return True

        return False
    except (json.JSONDecodeError, IOError):
        return False


def check_all_features_pass() -> tuple[bool, list[str]]:
    """Check if all features pass.

    Returns:
        (all_pass, incomplete_ids) tuple
    """
    data = load_feature_list()
    if not data:
        return True, []  # No feature list = no enforcement

    features = data.get("features", [])
    incomplete = [f["id"] for f in features if not f.get("passes")]

    return len(incomplete) == 0, incomplete


def get_tier_from_feature_list() -> Optional[str]:
    """Get tier from feature_list.json.

    Returns:
        Tier string (T1/T2/T3) or None if no feature list.
    """
    data = load_feature_list()
    return data.get("tier") if data else None


# ─────────────────────────────────────────────────────────────
# Module test (when run directly)
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Basic sanity check
    print(f"Agent ID: {get_agent_id()}")
    print(f"Contract file: {CONTRACT_FILE}")
    print(f"Exists: {CONTRACT_FILE.exists()}")

    data = load_completion()
    print(f"Schema: {data.get('schema', data.get('version', 'unknown'))}")

    if data.get("schema") == "multi-agent":
        print(f"Agents: {list(data.get('agents', {}).keys())}")
