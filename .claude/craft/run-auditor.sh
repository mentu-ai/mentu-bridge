#!/bin/bash
# Auditor: Validates PRD and produces INSTRUCTION.md
#
# Usage: ./run-auditor.sh
#
# Reads: PRD-architecture-completion.md
# Writes: INSTRUCTION.md

set -e

cd /Users/rashid/Desktop/Workspaces/mentu-bridge

claude -p "You are the AUDITOR for mentu-bridge.

Your role: Validate the Architect's PRD and produce executable instructions.

## Your Task

1. Read the PRD at .claude/craft/PRD-architecture-completion.md
2. Read the reference files:
   - /Users/rashid/Desktop/Workspaces/mentu-ai/.mentu/genesis.key (canonical schema)
   - /Users/rashid/Desktop/Workspaces/claude-code/.mentu/genesis.key (recent example)
   - /Users/rashid/Desktop/Workspaces/claude-code/.mentu/config.yaml (recent example)
3. Read the existing manifest at .mentu/manifest.yaml
4. Validate the requirements against reality
5. Write INSTRUCTION.md with EXACT file contents to create

## Output Format

Write to .claude/craft/INSTRUCTION.md with:
- Mode: Executor
- Author: agent:claude-auditor
- Exact YAML contents for genesis.key (in code block)
- Exact YAML contents for config.yaml (in code block)
- Execution checklist

## Constraints

- genesis.key actor is 'agent:bridge-daemon' (from manifest)
- Bridge is a TRUSTED EXECUTOR - needs full lifecycle permissions
- Permitted operations: capture, commit, claim, close, annotate
- Trust gradient must be enabled
- config.yaml uses environment variables, no secrets

Write the INSTRUCTION.md file now." --output-format text --max-turns 20 --dangerously-skip-permissions
