#!/usr/bin/env python3
"""
PostToolUse Hook: Stream tool execution logs to Supabase spawn_logs table.

This hook runs after each tool call during mentu-bridge autonomous execution.
It captures the tool name, input, and response, then streams to spawn_logs.

HOOK EVENT: PostToolUse
MATCHER: Edit|Write|Bash|Read|Glob|Grep
INPUT: {session_id, tool_name, tool_input, tool_response, ...}
OUTPUT: {} (non-blocking)

Environment variables:
- SUPABASE_URL: Supabase project URL
- SUPABASE_SERVICE_ROLE_KEY: Service role key for writes
- MENTU_BRIDGE_COMMAND_ID: Current bridge command being executed
- MENTU_WORKSPACE_ID: Workspace for the command
"""

import json
import sys
import os
import urllib.request
import urllib.error
from datetime import datetime

# Buffer for batching (global state persists across hook calls in same process)
LOG_BUFFER = []
BUFFER_SIZE = 5  # Flush after this many logs
LAST_FLUSH = None


def get_env():
    """Get required environment variables."""
    return {
        "supabase_url": os.environ.get("SUPABASE_URL", "https://nwhtjzgcbjuewuhapjua.supabase.co"),
        "supabase_key": os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        "command_id": os.environ.get("MENTU_BRIDGE_COMMAND_ID", ""),
        "workspace_id": os.environ.get("MENTU_WORKSPACE_ID", ""),
    }


def flush_to_supabase(logs: list, env: dict) -> bool:
    """Write buffered logs to Supabase spawn_logs table."""
    if not logs or not env["supabase_key"]:
        return False

    url = f"{env['supabase_url']}/rest/v1/spawn_logs"
    headers = {
        "Content-Type": "application/json",
        "apikey": env["supabase_key"],
        "Authorization": f"Bearer {env['supabase_key']}",
        "Prefer": "return=minimal",
    }

    try:
        data = json.dumps(logs).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=3) as resp:
            return resp.status < 400
    except Exception as e:
        # Log error but don't block
        sys.stderr.write(f"[spawn_logs] Failed to flush: {e}\n")
        return False


def create_log_entry(session_id: str, tool_name: str, tool_input: dict,
                     tool_response: str, env: dict) -> dict:
    """Create a spawn_log entry."""
    # Truncate long responses
    response_preview = str(tool_response)[:2000] if tool_response else ""

    entry = {
        "command_id": env["command_id"] if env["command_id"] else None,
        "workspace_id": env["workspace_id"] if env["workspace_id"] else None,
        "stream": "tool",
        "message": json.dumps({
            "tool": tool_name,
            "input": tool_input,
            "response_preview": response_preview[:500],
        }),
        "ts": datetime.utcnow().isoformat() + "Z",
    }

    # Only include command_id if we have one (skip null values for Supabase)
    return {k: v for k, v in entry.items() if v is not None}


def main():
    global LOG_BUFFER, LAST_FLUSH

    try:
        hook_input = json.load(sys.stdin)
    except Exception as e:
        sys.stderr.write(f"[spawn_logs] Failed to parse input: {e}\n")
        print(json.dumps({}))
        sys.exit(0)

    env = get_env()

    # Extract hook data
    session_id = hook_input.get("session_id", "unknown")
    tool_name = hook_input.get("tool_name", "")
    tool_input = hook_input.get("tool_input", {})
    tool_response = hook_input.get("tool_response", "")

    # Skip if no command context (not in bridge execution)
    if not env["command_id"]:
        print(json.dumps({}))
        sys.exit(0)

    # Create log entry
    log_entry = create_log_entry(session_id, tool_name, tool_input, tool_response, env)
    LOG_BUFFER.append(log_entry)

    # Flush if buffer is full
    if len(LOG_BUFFER) >= BUFFER_SIZE:
        flush_to_supabase(LOG_BUFFER, env)
        LOG_BUFFER = []

    # Always return success (non-blocking)
    print(json.dumps({}))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"[spawn_logs] Unexpected error: {e}\n")
        print(json.dumps({}))
        sys.exit(0)
