#!/bin/bash
# Executor: Creates the actual files
#
# Usage: ./run-executor.sh
#
# Reads: INSTRUCTION.md
# Creates: .mentu/genesis.key, .mentu/config.yaml
# Writes: RESULT.md

set -e

cd /Users/rashid/Desktop/Workspaces/mentu-bridge

claude -p "You are the EXECUTOR for mentu-bridge.

Your role: Execute the audited instructions exactly as specified.

## Your Task

1. Read the INSTRUCTION at .claude/craft/INSTRUCTION.md
2. Create the files EXACTLY as specified:
   - .mentu/genesis.key
   - .mentu/config.yaml
3. Validate both files are valid YAML
4. Write RESULT.md documenting what was done

## Execution Rules

- Create files with EXACT contents from INSTRUCTION.md
- Do NOT modify or interpret - execute precisely
- Validate YAML after creation
- Document everything in RESULT.md

## Output Format

Write to .claude/craft/RESULT.md with:
- Mode: Executor
- Author: agent:claude-executor
- Files created (with status)
- Validation results
- Success criteria verification

Execute now." --output-format text --max-turns 30 --dangerously-skip-permissions
