# Architecture

## Goal
Given a course repo that uses `modello` to generate Cypress e2e tests, run the generated specs, work out which failures come from stale model configuration, and fix only that configuration. Dry-run by default.

## Components
- `src/cli.ts`: arguments, exit codes (0 fixed/proposed, 2 unfixable, 3 no outcome, 1 usage).
- `src/agent.ts`: runs the Claude Agent SDK `query()` loop; `makeCanUseTool` allows only the fixer tools plus Read/Grep/Glob inside the project (no `.env*`, no Bash/Edit/Write).
- `src/tools/index.ts`: in-process MCP server `fixer`: `list_specs`, `run_cypress`, `set_model_value`, `rebuild_spec`, `report_outcome`.
- `src/session.ts`: all side effects (run Cypress, patch a file, rebuild) and run state (attempt count, proposals, outcome).
- `src/guard.ts`: write allowlist (3 model files in the model dir, symlink-safe), leaf-only patches, format-preserving serializer.
- `src/failures.ts`: JUnit parser; maps a stack frame to the `// -> page: ... block uid:` comment in the generated spec.
- `src/config.ts`, `src/shell.ts`: config defaults and operator-supplied command templates.
- `src/prompt.ts`: system prompt.

## Data flow
CLI -> `runFixer` -> agent calls `run_cypress` (`modello run -- cypress run --spec ... --reporter junit`) -> JUnit parsed and enriched with page/block/command -> agent reads course source to find the correct value -> `set_model_value` (guarded; recorded only in dry-run) -> `rebuild_spec` (`modello build --scope ...`, write mode only) -> rerun the same spec -> `report_outcome`.

## Key decisions
- Safety is enforced in code (guard, `canUseTool`, no shell tools), not only in the prompt.
- The model never supplies command text. It passes a spec file name and a scope, both validated; run/build commands are operator templates (`--run-cmd`, `--build-cmd`).
- Dry-run is default; `--write` is explicit. Never commits.
- Ambiguous or non-config failures (environment, course bug, visual) end as `unfixable`, with no write.
- Writes reserialize the whole JSON file with the original indent, so a hand-compacted file will be reformatted.
- Default build command comes from digital-banking CI; other courses (grow) may need `--build-cmd`.
