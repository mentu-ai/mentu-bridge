#!/usr/bin/env python3
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
"""
Tier Validator Stop Hook: Run validators in parallel before allowing stop.

Classifies commitment tier and invokes headless validators from .claude/validators/.
Validators run IN PARALLEL using ThreadPoolExecutor.
Results are captured as RESULT-Validation documents with YAML frontmatter for lineage.

HOOK EVENT: Stop
INPUT: {"stop_hook_active": bool, ...}
OUTPUT: {} or {"decision": "block", "reason": "..."}

TIER CLASSIFICATION:
  Tier 1: [routine] -> technical-validator only
  Tier 2: [database, auth, external-api, new-pattern] -> technical + safety
  Tier 3: [security, financial, production, critical] -> technical + intent + safety

Validators are headless Claude sessions defined in .claude/validators/*.sh
"""

import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, Tuple, Set, List, Any, Dict

# Import shared utilities
sys.path.insert(0, str(Path(__file__).parent))
from completion_utils import get_agent_id, get_agent_contract


# Tier classification tags
TIER_3_TAGS = {"security", "financial", "production", "critical", "compliance"}
TIER_2_TAGS = {"database", "auth", "external-api", "new-pattern", "migration"}

# Cognitive stances for failure guidance
STANCES = {
    "technical": {
        "owner": "executor",
        "stance": "This is my failure. The implementation doesn't work. I should fix it, not explain why it should work.",
        "action": "Fix the implementation immediately."
    },
    "safety": {
        "owner": "auditor",
        "stance": "I violated boundaries set by another role. I should constrain, not argue. Respect the audit.",
        "action": "Remove the violation and rebuild within scope."
    },
    "intent": {
        "owner": "architect",
        "stance": "I drifted from the vision. This is my failure to follow. Return to the HANDOFF. Read the intent again.",
        "action": "Re-read the original intent and rebuild."
    }
}

# Validators by tier (script names without .sh)
# Intent validator enabled for Tier 3 (validates work aligns with original vision)
VALIDATORS_BY_TIER = {
    1: ["technical"],
    2: ["technical", "safety"],
    3: ["technical", "safety", "intent"],  # Full triad for high-risk work
}


def run_mentu(args: List[str]) -> Tuple[bool, Any]:
    """Run mentu command, return (success, parsed_json)."""
    try:
        result = subprocess.run(
            ["mentu"] + args + ["--json"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode != 0:
            return False, None
        return True, json.loads(result.stdout)
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError):
        return False, None


def extract_provenance(cmt_id: str) -> Dict[str, str]:
    """Extract INTENT_ID and AUDIT_ID from commitment metadata.

    Provenance IDs are stored in commitment.meta.provenance or
    linked as memories with kind='intent' or kind='audit'.

    Returns dict with optional INTENT_ID and AUDIT_ID keys.
    """
    try:
        ok, commitment = run_mentu(["show", cmt_id])
        if not ok or not isinstance(commitment, dict):
            return {}

        provenance = {}

        # Check meta.provenance field (if stored at commit time)
        meta = commitment.get("meta", {})
        prov = meta.get("provenance", {})

        if prov.get("intent"):
            provenance["INTENT_ID"] = prov["intent"]
        if prov.get("audit"):
            provenance["AUDIT_ID"] = prov["audit"]

        # If no provenance in meta, check linked memories
        if not provenance:
            # Look for linked memories with kind='intent' or kind='audit'
            refs = commitment.get("refs", [])
            for ref in refs:
                if isinstance(ref, str) and ref.startswith("mem_"):
                    ok, mem = run_mentu(["show", ref])
                    if ok and isinstance(mem, dict):
                        kind = mem.get("kind", "")
                        if kind == "intent" and "INTENT_ID" not in provenance:
                            provenance["INTENT_ID"] = ref
                        elif kind == "audit" and "AUDIT_ID" not in provenance:
                            provenance["AUDIT_ID"] = ref

        return provenance
    except Exception as e:
        sys.stderr.write(f"[TierValidator] Provenance extraction warning: {e}\n")
        return {}


def fetch_memory_body(mem_id: str) -> str:
    """Fetch memory body via mentu show.

    Returns the body text of the memory, or empty string on failure.
    Used to pass INTENT_BODY and AUDIT_BODY to validators.
    """
    if not mem_id:
        return ""
    try:
        ok, memory = run_mentu(["show", mem_id])
        if ok and isinstance(memory, dict):
            return memory.get("body", "")
        return ""
    except Exception as e:
        sys.stderr.write(f"[TierValidator] Memory fetch warning ({mem_id}): {e}\n")
        return ""


def get_commitment_by_id(cmt_id: str) -> Optional[dict]:
    """Get commitment details by ID."""
    ok, data = run_mentu(["show", cmt_id])
    if ok and isinstance(data, dict):
        return data
    return None


def get_tier_from_feature_list() -> int:
    """Read tier from feature_list.json if it exists.

    Returns:
        Tier number (1, 2, or 3), or 0 if no feature list.
    """
    feature_file = "feature_list.json"
    if not os.path.exists(feature_file):
        return 0

    try:
        with open(feature_file) as f:
            data = json.load(f)
        tier_str = data.get("tier", "T1").upper()
        if tier_str == "T3":
            return 3
        elif tier_str == "T2":
            return 2
        elif tier_str == "T1":
            return 1
        return 1
    except (json.JSONDecodeError, IOError):
        return 0


def classify_tier(commitment: dict) -> int:
    """Classify commitment into validation tier.

    Priority:
    1. feature_list.json tier field (if present)
    2. Commitment tags
    3. Default T1
    """
    # First check feature_list.json
    feature_tier = get_tier_from_feature_list()
    if feature_tier > 0:
        return feature_tier

    # Fall back to commitment tags
    tags = set(commitment.get("tags", []))

    # Tier 3: High risk
    if tags & TIER_3_TAGS:
        return 3

    # Tier 2: Medium risk
    if tags & TIER_2_TAGS:
        return 2

    # Tier 1: Default (routine)
    return 1


def format_stance_guidance(failures: List[Dict[str, Any]]) -> str:
    """Format cognitive stance guidance for failed validators.

    Maps validator type to domain and provides reasoning guidance.
    """
    lines = ["", "## Cognitive Stance Guidance", ""]

    for v in failures:
        validator = v.get("validator", "").lower()

        # Map validator to domain
        domain = None
        if "technical" in validator:
            domain = "technical"
        elif "safety" in validator:
            domain = "safety"
        elif "intent" in validator:
            domain = "intent"

        if domain and domain in STANCES:
            stance = STANCES[domain]
            lines.append(f"**{validator} failed** (domain: {domain})")
            lines.append(f"> {stance['stance']}")
            lines.append(f"")
            lines.append(f"**Action:** {stance['action']}")
            lines.append("")

    if len(lines) > 3:  # Has actual guidance
        lines.append("Do NOT argue with the failure. Own it. Fix it.")
        return "\n".join(lines)

    return ""


def invoke_validator(script: str, cmt_id: str, cmt_body: str, source_id: str = "", provenance: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Invoke a headless validator script and return parsed verdict.

    Args:
        script: Path to validator script
        cmt_id: Commitment ID being validated
        cmt_body: Commitment body/description
        source_id: Optional source memory ID
        provenance: Optional dict with INTENT_ID, AUDIT_ID for provenance-aware validation

    Returns:
        Parsed verdict JSON with validator, verdict, summary, and optionally attribution
    """
    env = os.environ.copy()
    env["CMT_ID"] = cmt_id
    env["CMT_BODY"] = cmt_body
    if source_id:
        env["SOURCE_ID"] = source_id

    # Add provenance environment variables if available
    if provenance:
        if provenance.get("INTENT_ID"):
            env["INTENT_ID"] = provenance["INTENT_ID"]
            env["INTENT_BODY"] = fetch_memory_body(provenance["INTENT_ID"])
        if provenance.get("AUDIT_ID"):
            env["AUDIT_ID"] = provenance["AUDIT_ID"]
            env["AUDIT_BODY"] = fetch_memory_body(provenance["AUDIT_ID"])

    try:
        result = subprocess.run(
            [script],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,  # 2 minute timeout per validator
            cwd=os.getcwd()
        )

        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
        else:
            return {
                "validator": script.split("/")[-1].replace(".sh", ""),
                "verdict": "FAIL",
                "summary": f"Validator error: {result.stderr or 'no output'}"
            }
    except subprocess.TimeoutExpired:
        return {
            "validator": script.split("/")[-1].replace(".sh", ""),
            "verdict": "FAIL",
            "summary": "Validator timeout (120s)"
        }
    except (FileNotFoundError, json.JSONDecodeError) as e:
        return {
            "validator": script.split("/")[-1].replace(".sh", ""),
            "verdict": "FAIL",
            "summary": f"Validator error: {e}"
        }


def run_validators_parallel(tier: int, cmt_id: str, cmt_body: str, source_id: str = "") -> Tuple[bool, List[Dict[str, Any]]]:
    """Run validators in PARALLEL based on tier, return (all_passed, verdicts).

    Extracts provenance (INTENT_ID, AUDIT_ID) from the commitment and passes
    it to validators so they can attribute failures to the responsible author type.
    """
    validators_dir = ".claude/validators"

    # Determine which validators to run
    validator_names = VALIDATORS_BY_TIER.get(tier, ["technical"])
    scripts = [f"{validators_dir}/{name}.sh" for name in validator_names]

    # Filter to existing scripts
    scripts = [s for s in scripts if os.path.exists(s)]

    if not scripts:
        # No validators available, allow stop but note it
        return True, [{
            "validator": "none",
            "verdict": "PASS",
            "summary": "No validators configured"
        }]

    # Extract provenance for attribution
    provenance = extract_provenance(cmt_id)
    if provenance:
        sys.stderr.write(f"[TierValidator] Provenance: {provenance}\n")

    # Run ALL validators in parallel
    verdicts = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(invoke_validator, script, cmt_id, cmt_body, source_id, provenance): script
            for script in scripts
        }

        for future in as_completed(futures):
            try:
                verdict = future.result()
                verdicts.append(verdict)
            except Exception as e:
                script = futures[future]
                verdicts.append({
                    "validator": script.split("/")[-1].replace(".sh", ""),
                    "verdict": "FAIL",
                    "summary": f"Executor error: {e}"
                })

    all_passed = all(v.get("verdict") == "PASS" for v in verdicts)
    return all_passed, verdicts


def generate_validation_result(cmt_id: str, cmt_body: str, tier: int, verdicts: List[Dict[str, Any]], actor: str) -> str:
    """Generate RESULT-Validation document with YAML frontmatter for lineage."""
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    all_passed = all(v.get("verdict") == "PASS" for v in verdicts)
    overall_verdict = "PASS" if all_passed else "FAIL"

    # Build YAML frontmatter with full validation data
    frontmatter = f"""---
id: RESULT-Validation-{cmt_id}
type: result
intent: reference
commitment: {cmt_id}
task: "{cmt_body.replace('"', "'")}"
tier: {tier}
actor: {actor}
timestamp: {timestamp}
created: {date_str}
validation:
  verdict: {overall_verdict}
  parallel: true
  validators:"""

    for v in verdicts:
        validator_name = v.get('validator', 'unknown')
        verdict = v.get('verdict', 'UNKNOWN')
        summary = v.get('summary', '').replace('"', "'")

        frontmatter += f"""
    - name: {validator_name}
      verdict: {verdict}
      summary: "{summary}" """

        # Add attribution if present (provenance-aware validators)
        if 'attribution' in v:
            attr = v['attribution']
            frontmatter += f"""
      attribution:
        author_type: {attr.get('author_type', 'unknown')}
        responsible_for: {attr.get('responsible_for', 'unknown')}"""

        # Add validator-specific fields
        if 'checks' in v:
            frontmatter += f"""
      checks:
        tsc: {str(v['checks'].get('tsc', False)).lower()}
        tests: {str(v['checks'].get('tests', False)).lower()}
        build: {str(v['checks'].get('build', False)).lower()}"""
        if 'issues' in v:
            frontmatter += f"""
      issues: {json.dumps(v.get('issues', []))}
      severity: {v.get('severity', 'none')}"""
        if 'alignment' in v:
            frontmatter += f"""
      alignment: {v.get('alignment', 0)}
      scope_creep: {json.dumps(v.get('scope_creep', []))}
      missing: {json.dumps(v.get('missing', []))}"""

    frontmatter += """
mentu:
  evidence: pending
  status: captured
---"""

    # Build body
    body = f"""
# Validation Result: {cmt_id}

## Summary

| Field | Value |
|-------|-------|
| Commitment | `{cmt_id}` |
| Task | {cmt_body} |
| Tier | {tier} |
| Verdict | **{overall_verdict}** |
| Timestamp | {timestamp} |
| Actor | {actor} |

## Validator Verdicts

| Validator | Verdict | Summary |
|-----------|---------|---------|"""

    for v in verdicts:
        body += f"""
| {v.get('validator', 'unknown')} | {v.get('verdict', 'UNKNOWN')} | {v.get('summary', '')} |"""

    # Add Failure Attribution section if any validators failed
    failed_verdicts = [v for v in verdicts if v.get('verdict') == 'FAIL']
    if failed_verdicts:
        body += """

## Failure Attribution

When validation fails, accountability is attributed to the responsible author type:

| Validator | Author Type | Responsible For | Summary |
|-----------|-------------|-----------------|---------|"""
        for v in failed_verdicts:
            attr = v.get('attribution', {})
            author_type = attr.get('author_type', 'unknown')
            responsible_for = attr.get('responsible_for', 'unknown')
            summary = v.get('summary', '')
            body += f"""
| {v.get('validator', 'unknown')} | **{author_type}** | {responsible_for} | {summary} |"""

        body += """

**Mapping:**
- **technical** validator failure → **Executor** responsibility (implementation issues)
- **safety** validator failure → **Auditor** responsibility (security/boundary issues)
- **intent** validator failure → **Architect** responsibility (vision/scope issues)
"""

    body += f"""

## Lineage

This validation result provides evidence for commitment `{cmt_id}`.

- **Validators ran in parallel**: Yes
- **Tier {tier} requirements**: {'Met' if all_passed else 'Not met'}

---

*Generated automatically by tier_validator.py*
"""

    return frontmatter + body


def write_validation_result(cmt_id: str, cmt_body: str, tier: int, verdicts: List[Dict[str, Any]]) -> Optional[str]:
    """Write RESULT document and capture as Mentu evidence."""
    actor = os.environ.get("MENTU_ACTOR", "agent:claude-code")

    # Generate RESULT document
    content = generate_validation_result(cmt_id, cmt_body, tier, verdicts, actor)

    # Ensure docs directory exists
    docs_dir = Path("docs")
    docs_dir.mkdir(exist_ok=True)

    # Write to docs/
    result_path = f"docs/RESULT-Validation-{cmt_id}.md"
    try:
        with open(result_path, "w") as f:
            f.write(content)
    except IOError as e:
        sys.stderr.write(f"[TierValidator] Failed to write RESULT: {e}\n")
        return None

    # Capture as Mentu evidence
    all_passed = all(v.get("verdict") == "PASS" for v in verdicts)
    verdict_str = "PASS" if all_passed else "FAIL"
    parts = [f"{v.get('validator')}={v.get('verdict')}" for v in verdicts]

    try:
        result = subprocess.run(
            ["mentu", "capture",
             f"Validation {verdict_str} [{cmt_id}]: {', '.join(parts)}. Result: {result_path}",
             "--kind", "validation",
             "--refs", cmt_id,
             "--actor", actor,
             "--json"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            evidence_id = data.get("id")

            # Update frontmatter with evidence ID
            if evidence_id:
                updated_content = content.replace("evidence: pending", f"evidence: {evidence_id}")
                with open(result_path, "w") as f:
                    f.write(updated_content)

            return evidence_id
    except (FileNotFoundError, subprocess.TimeoutExpired, json.JSONDecodeError, IOError):
        pass

    return None


def check_validation_evidence(commitment_id: str, required_validators: List[str]) -> Tuple[bool, Set[str]]:
    """Check if validation evidence exists for required validators.

    Returns (all_found, validators_found)
    """
    ok, data = run_mentu(["log", "--limit", "50"])
    if not ok or not isinstance(data, list):
        return False, set()

    validators_found = set()

    for op in data:
        if op.get("op") != "capture":
            continue

        payload = op.get("payload", {})
        if payload.get("kind") != "validation":
            continue

        body = payload.get("body", "").lower()

        # Check for each required validator
        for validator in required_validators:
            validator_key = validator.lower().replace(" ", "-").replace("-validator", "")
            if validator_key in body and "pass" in body:
                validators_found.add(validator)

    required_set = set(required_validators)
    return validators_found >= required_set, validators_found


def format_validator_instructions(tier: int, validators: List[str], commitment: dict) -> str:
    """Format instructions for spawning validators."""
    cmt_id = commitment.get("id", "unknown")
    cmt_body = commitment.get("body", "unknown task")

    lines = [
        f"## VALIDATION REQUIRED (Tier {tier})",
        "",
        f"**Commitment:** `{cmt_id}`",
        f"**Task:** {cmt_body}",
        "",
        "Before stopping, you MUST spawn these validators using the Task tool:",
        ""
    ]

    for validator in validators:
        agent_type = validator.replace(" ", "-").lower()
        lines.extend([
            f"### {validator}",
            f"```",
            f"Use Task tool with subagent_type=\"{agent_type}\"",
            f"Prompt: \"Validate commitment {cmt_id}: {cmt_body}\"",
            f"```",
            ""
        ])

    lines.extend([
        "**Run validators in parallel.** If all return PASS, you may stop.",
        "If any return FAIL, fix the issues and run validators again.",
        "",
        "After validators pass, capture the results as evidence:",
        "```bash",
        f"mentu capture \"Validation complete: all validators passed\" --kind validation --actor {os.environ.get('MENTU_ACTOR', 'agent:claude-code')}",
        "```"
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
        # Already in a stop hook loop, allow stop to prevent infinite loop
        print(json.dumps({}))
        sys.exit(0)

    # Get agent identity and contract
    agent_id = get_agent_id()
    contract = get_agent_contract(agent_id)

    # No contract = no tier validation needed
    if not contract:
        print(json.dumps({}))
        sys.exit(0)

    # Get mentu config from contract
    mentu_config = contract.get("mentu", {})
    if not mentu_config.get("enabled", True):
        print(json.dumps({}))
        sys.exit(0)

    # Get commitment IDs from contract
    commitments_config = mentu_config.get("commitments", {})
    commitment_ids = commitments_config.get("ids", [])

    if not commitment_ids:
        # No specific commitments to validate
        print(json.dumps({}))
        sys.exit(0)

    # Check each commitment
    for cmt_id in commitment_ids:
        commitment = get_commitment_by_id(cmt_id)
        if not commitment:
            continue

        state = commitment.get("state", "unknown")

        # Skip already closed/in_review commitments
        if state in ("closed", "in_review"):
            continue

        # Only validate claimed commitments
        if state != "claimed":
            continue

        # Classify tier and get required validators
        tier = classify_tier(commitment)

        # Run validators IN PARALLEL
        all_passed, verdicts = run_validators_parallel(
            tier, cmt_id, commitment.get("body", ""), commitment.get("source", "")
        )

        # Write RESULT document with YAML frontmatter (provides lineage)
        if verdicts:
            evidence_id = write_validation_result(cmt_id, commitment.get("body", ""), tier, verdicts)
            if evidence_id:
                sys.stderr.write(f"[TierValidator] Evidence: {evidence_id}\n")
                sys.stderr.write(f"[TierValidator] Result: docs/RESULT-Validation-{cmt_id}.md\n")

        if not all_passed:
            # Format failure message
            failures = [v for v in verdicts if v.get("verdict") != "PASS"]
            failure_msgs = [f"- **{v['validator']}**: {v.get('summary', 'FAIL')}" for v in failures]

            # Add stance guidance
            stance_guidance = format_stance_guidance(failures)

            print(json.dumps({
                "decision": "block",
                "reason": f"""## VALIDATION FAILED

{chr(10).join(failure_msgs)}
{stance_guidance}

**Result document**: `docs/RESULT-Validation-{cmt_id}.md`

Fix the issues and try again."""
            }))
            sys.exit(0)

    # All commitments validated (or none need validation)
    print(json.dumps({}))
    sys.exit(0)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Fail-safe: on error, allow stop
        sys.stderr.write(f"Tier validator error: {e}\n")
        print(json.dumps({}))
        sys.exit(0)
