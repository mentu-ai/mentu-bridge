#!/usr/bin/env python3
"""
SessionEnd Hook: Final flush of spawn_logs to Supabase.

This hook runs when a Claude session ends, ensuring all buffered logs are written.

HOOK EVENT: SessionEnd
INPUT: {session_id, reason, ...}
OUTPUT: {} (non-blocking)

Environment variables:
- SUPABASE_URL: Supabase project URL
- SUPABASE_SERVICE_ROLE_KEY: Service role key for writes
- MENTU_BRIDGE_COMMAND_ID: Current bridge command being executed
"""

import json
import sys
import os
import urllib.request
from datetime import datetime


def get_env():
    """Get required environment variables."""
    return {
        "supabase_url": os.environ.get("SUPABASE_URL", "https://nwhtjzgcbjuewuhapjua.supabase.co"),
        "supabase_key": os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
        "command_id": os.environ.get("MENTU_BRIDGE_COMMAND_ID", ""),
        "workspace_id": os.environ.get("MENTU_WORKSPACE_ID", ""),
    }


def write_session_end_log(session_id: str, reason: str, env: dict) -> bool:
    """Write session end marker to spawn_logs."""
    if not env["supabase_key"] or not env["command_id"]:
        return False

    url = f"{env['supabase_url']}/rest/v1/spawn_logs"
    headers = {
        "Content-Type": "application/json",
        "apikey": env["supabase_key"],
        "Authorization": f"Bearer {env['supabase_key']}",
        "Prefer": "return=minimal",
    }

    log_entry = {
        "command_id": env["command_id"],
        "workspace_id": env["workspace_id"],
        "stream": "system",
        "message": json.dumps({
            "event": "session_end",
            "session_id": session_id,
            "reason": reason,
        }),
        "ts": datetime.utcnow().isoformat() + "Z",
    }

    try:
        data = json.dumps([log_entry]).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status < 400
    except Exception as e:
        sys.stderr.write(f"[spawn_logs_flush] Failed: {e}\n")
        return False


def main():
    try:
        hook_input = json.load(sys.stdin)
    except Exception as e:
        sys.stderr.write(f"[spawn_logs_flush] Failed to parse input: {e}\n")
        print(json.dumps({}))
        sys.exit(0)

    env = get_env()
    session_id = hook_input.get("session_id", "unknown")
    reason = hook_input.get("reason", "unknown")

    # Write session end marker
    write_session_end_log(session_id, reason, env)

    print(json.dumps({}))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        sys.stderr.write(f"[spawn_logs_flush] Unexpected error: {e}\n")
        print(json.dumps({}))
        sys.exit(0)
