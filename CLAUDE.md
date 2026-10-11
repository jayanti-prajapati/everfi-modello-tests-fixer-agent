# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# My Agent Project

An AI agent project built and maintained with Claude Code.

**Purpose:** Modello Tests Fixer: an agent that repairs a course's modello model config (`model-parameters/map/edges.json`) when its generated Cypress tests fail. For EverFi course repos (e.g. digital-banking, grow) that use the `modello` CLI. Details in `docs/architecture.md`.

## Commands
Node 20+, TypeScript, Claude Agent SDK.
- Install: `npm install`
- Run (dry-run): `npm run dev -- --project <course-root> [--spec <file>]`; add `--write` to apply changes. Needs an Anthropic credential and spends money (`--max-budget-usd`, default 5).
- Test (all): `npm test`
- Test (single): `npx vitest run test/guard.test.ts` (add `-t "<name>"` for one case)
- Typecheck: `npm run typecheck`

## Repo notes
- `setup.sh` is one-time bootstrap (git init, initial commit, optional private GitHub repo via `gh`). Don't rerun it casually.
- `.claude/settings.json` allows read-only git commands and `ls`, and denies reading `.env*` and `rm -rf`.
- Personal overrides go in `CLAUDE.local.md` (gitignored). Keep this file under ~200 lines; put longer material in `docs/` and pull it in with `@docs/file.md`.
- `.claude/skills/` holds `code-review` and `wrap-up`; `.claude/agents/` holds `reviewer` and `researcher`.

## Rules
- Plan first for any change touching more than 2 files; wait for approval. Exempt: `/init` and `/wrap-up`, which update docs and may touch several files.
- Run tests before saying a task is done (once a test command exists).
- Never commit secrets or `.env` files.
- Small, focused commits with clear messages.
- Don't add dependencies without asking.

## Docs (loaded on demand)
@docs/architecture.md
@docs/progress.md

## Session habit
At the end of a task, run `/wrap-up` so the next session has context.
