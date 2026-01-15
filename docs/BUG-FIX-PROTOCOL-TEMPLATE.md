# Bug Fix Protocol

> **Copy this file to your repository as `BUG-FIX-PROTOCOL.md` and customize it.**

This file tells Claude how to fix bugs in this repository. When a bug execution is triggered, Claude will read this file first.

---

## Tech Stack

- **Framework**: [React/Vue/Node/etc.]
- **Language**: TypeScript
- **Database**: [Supabase/PostgreSQL/etc.]
- **Build Tool**: [npm/yarn/pnpm]

---

## Codebase Structure

```
src/
├── components/    # UI components
├── hooks/         # React hooks
├── utils/         # Utility functions
├── services/      # API/database services
└── types/         # TypeScript types
```

> **Customize this section** with your actual codebase structure.

---

## Investigation Steps

1. **Read CLAUDE.md** to understand the codebase structure and conventions
2. **Search for related files** using Grep/Glob tools with keywords from the bug report
3. **Read the relevant code** to understand the current behavior
4. **Form a hypothesis** about the root cause before making changes

---

## Fix Guidelines

### DO:
- Make minimal, focused changes
- Follow existing code patterns
- Add comments only where logic is non-obvious
- Run verification commands before committing

### DO NOT:
- Modify unrelated code
- Add new dependencies without necessity
- Change configuration files (package.json, tsconfig.json, etc.)
- Refactor code that isn't broken
- Add new features - only fix the bug

---

## Verification Commands

Run these commands to verify your fix:

```bash
# Type check
npx tsc --noEmit

# Run tests (if applicable)
npm test

# Build
npm run build
```

> **Customize these commands** for your project.

---

## Mentu Protocol

After fixing the bug, follow these steps **in order**:

### 1. Commit Your Changes

```bash
git add -A && git commit -m "fix: <brief description of what was fixed>" && git push origin HEAD
```

### 2. Capture Evidence

```bash
mentu capture "Fixed: <summary of what you fixed and how>" --kind evidence --actor agent:claude-vps
```

This outputs a memory ID like `mem_XXXXXXXX`. Copy that ID.

### 3. Close the Commitment

Use the memory ID from step 2 as evidence:

```bash
mentu close <commitment_id> --evidence mem_XXXXXXXX --actor agent:claude-vps
```

---

## If You're Blocked

If you cannot fix the bug:

1. **Document what you found** - what you investigated, what the issue appears to be
2. **Annotate the commitment** with the blocker:

```bash
mentu annotate <commitment_id> "Blocked: <specific reason why you cannot proceed>"
```

3. **Do NOT claim success** if you haven't actually fixed the bug

---

## Constraints

- **Maximum 5 files changed** per bug fix
- **No package.json modifications** unless explicitly required
- **No configuration file changes** unless explicitly required
- **Stay focused** on the reported bug only

---

## Additional Context

> **Add any project-specific context here**, such as:
> - How to access the database
> - Special environment variables needed
> - Links to relevant documentation
> - Known quirks or gotchas

---

*This protocol ensures consistent, verifiable bug fixes across the team.*
