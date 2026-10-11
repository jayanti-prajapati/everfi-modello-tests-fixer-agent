# My Agent Project

Starter skeleton for working with Claude Code.

## Quick start (macOS)
```bash
# 1. Install Claude Code
curl -fsSL https://claude.ai/install.sh | bash

# 2. Create the git repo (and GitHub repo if you have gh installed)
bash setup.sh

# 3. Start Claude Code in this folder, then run /init to refine CLAUDE.md
claude
```

## What's inside
| Path | Purpose |
|---|---|
| `CLAUDE.md` | Persistent project memory (keep under ~200 lines) |
| `CLAUDE.local.md` | Your personal overrides (gitignored) |
| `docs/` | Longer docs, pulled in with `@docs/file.md` |
| `.claude/settings.json` | Permissions (shared with team) |
| `.claude/skills/` | Skills: `code-review`, `wrap-up` |
| `.claude/agents/` | Subagents: `reviewer`, `researcher` |

## Next steps
1. Edit the TODOs in `CLAUDE.md`.
2. Fill in `docs/architecture.md`.
3. Optional: add MCP servers (e.g. a docs server, GitHub) with `claude mcp add`.
4. Optional: add Anthropic's skills: `/plugin marketplace add anthropics/skills`.
