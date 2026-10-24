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
- `src/preflight.ts`: checks `ecc`/`yq`/`modello` on PATH and that `build-and-test.yml` (or `test/ui/regression-tests.sh`) exists, before any model spend.
- `src/prompt.ts`: system prompt.

- `src/orchestrator/`: multi-agent layer over `runFixer`. `index.ts` (`orchestrate`, `StepTracker`), `scheduler.ts` (`runPool`), `workspace.ts` (copy-on-write course copies), `merger.ts` (replays verified patches onto the checkout, detects conflicts), `events.ts` + `reducer.ts` (event model and view state, shared with the UI), `bus.ts` (event stream + JSONL log), `demo.ts` (scripted demo, replay).
- `src/orchestrate.ts`: orchestrator CLI. `src/server/index.ts`: HTTP + SSE server for the UI. `ui/`: Vite + React UI (canvas, execution matrix).

- `src/pipeline/`: local fix pipeline (milestone 1). `index.ts` (`runPipeline`: preflight -> branch -> build -> generate -> fix -> verify -> report -> commit -> push), `git.ts` (git via argument arrays; path-allowlisted commits; refuses develop/master/main), `report.ts` (report and commit message). CLI: `src/fix-course.ts`.

## Fix pipeline
Runs on the real checkout, which must be clean apart from known local-only files. Branches `test/modello-fixes-<time>` from `origin/develop` so the course's CI (`build-and-test.yml`, push to `test/**`) verifies a pushed branch against S3. Agents fix in isolated copies; verified fixes are merged and the checkout rebuilt; each fixed module is re-run in the checkout and reverted if it fails. Only the three model files are committed. Push needs a y/N answer (or `--push`). PR and merge stay with a human.

## Orchestrator
One agent per spec, `--concurrency` at a time, each in its own workspace copy (ECC's rebuild deletes `cypress/e2e`, and agents share the model files, so sharing a checkout is unsafe for parallel writes). Steps per agent are derived from tool calls and Session events: run -> diagnose -> fix -> rebuild -> verify -> report. Session emits `run`/`patch`/`rebuild` events through an optional listener; `runFixer` forwards raw SDK messages through `onMessage`. In write mode only `fixed` agents' patches are merged, serially, then the checkout is rebuilt once.

## Data flow
CLI -> `runFixer` -> agent calls `run_cypress` (`modello run -- cypress run --spec ... --reporter junit`) -> JUnit parsed and enriched with page/block/command -> agent reads course source to find the correct value -> `set_model_value` (guarded; recorded only in dry-run) -> `rebuild_spec` (`ecc --script test:build`, write mode only) -> rerun the same spec -> `report_outcome`.

## Key decisions
- Safety is enforced in code (guard, `canUseTool`, no shell tools), not only in the prompt.
- The model never supplies command text. It passes a spec file name and a scope, both validated; run/build commands are operator templates (`--run-cmd`, `--build-cmd`).
- Dry-run is default; `--write` is explicit. Never commits.
- Ambiguous or non-config failures (environment, course bug, visual) end as `unfixable`, with no write.
- Writes reserialize the whole JSON file with the original indent, so a hand-compacted file will be reformatted.
- Build uses ECC (`ecc --script test:build`, or `test:local` with `--local`). ECC's script deletes `test/ui/cypress/e2e` and regenerates every test from the course's `build-and-test.yml` `generate-tests-script` (or `test/ui/regression-tests.sh`), so a rebuild is all-or-nothing and slow; the agent is told to rebuild once per batch of changes.
- Run does NOT use `ecc --script test:headless`: it runs every spec with no filter or reporter. The fixer calls `modello run -- cypress run --spec ... --reporter junit` (what ECC calls underneath) to get one spec and a parseable report.
