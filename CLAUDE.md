# My Agent Project

<!-- TODO: replace with 2-3 lines describing what this project does -->
An AI agent project built and maintained with Claude Code.

## Commands
<!-- TODO: fill in real commands once you have a stack -->
- Install: `TODO`
- Test: `TODO`
- Run: `TODO`

## Project layout
- `docs/architecture.md` - how the system fits together
- `docs/progress.md` - running log of status and next steps
- `.claude/skills/` - reusable workflows (code-review, wrap-up)
- `.claude/agents/` - subagents (reviewer, researcher)

## Rules
- Plan first for any change touching more than 2 files; wait for approval.
- Run tests before saying a task is done.
- Never commit secrets or `.env` files.
- Small, focused commits with clear messages.
- Don't add dependencies without asking.

## Docs (loaded on demand)
@docs/architecture.md
@docs/progress.md

## Session habit
At the end of a task, run `/wrap-up` so the next session has context.
