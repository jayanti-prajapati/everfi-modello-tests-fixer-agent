# Modello Tests Fixer

An AI agent that repairs the **Modello model configuration** of an EverFi course when its generated Cypress end-to-end tests fail.

> **Status:** the guard, parser, tools, agent loop and CLI are implemented and unit-tested (38 tests). The full loop has been exercised with stubbed commands, and end to end against a throwaway copy of `digital-banking` with the real ECC build and real Cypress: a deliberately broken m3 selector was found and fixed and the spec passed on rerun. It has only been proven on that one kind of failure; see [`docs/progress.md`](docs/progress.md) for details and known gaps.

Short version: [`docs/agent-guide.md`](docs/agent-guide.md) covers what's in the agent and how to use it.

---

## 1. What it is

EverFi courses (for example `digital-banking`, `grow`) generate their Cypress UI tests with **Modello**, driven through **ECC** (the EverFi Content Compiler). Modello builds a test for each course module from:

- the compiled course content (`public/content/module-content.json`, `modules.json`), and
- three hand-maintained configuration files in the course's `test/ui/` folder:

| File | What it controls |
|---|---|
| `model-parameters.json` | Selectors and parameters for specific blocks, per page (e.g. which element opens a modal). |
| `model-map.json` | Replacing a block with custom code (`"modal.js"`) or removing it from the test (`null`). |
| `model-edges.json` | How pages and blocks are wired together for navigation. |

When the course changes (a button gets a new id, a modal is restructured), a generated test can fail even though the course is fine. The fix is usually a small edit to one of those three files followed by a rebuild. That is slow, repetitive, and easy to get subtly wrong.

The Modello Tests Fixer automates that loop.

## 2. Purpose

- Run a course's generated Cypress specs and find out *why* they fail.
- Decide whether a failure is a **model-configuration problem** (stale selector, wrong parameter, bad replacement, wrong edge) or something that is not the agent's to fix (environment, flaky timing, a course bug, a visual diff).
- For configuration problems, find the correct value in the course source and change **one value at a time** in the model files, rebuild through ECC, and re-run the same spec to confirm.
- Never touch anything else: no course source, no compiled content, no generated specs, no commits.

It is a developer tool for engineers who maintain course test suites. It is **not** a replacement for reviewing the resulting diff.

## 3. How it works

```
CLI ──▶ preflight ──▶ agent loop (Claude Agent SDK)
                         │
         ┌───────────────┼───────────────────────────────┐
         ▼               ▼                               ▼
   run_cypress     set_model_value                 rebuild_spec
   (one spec,      (guarded, one leaf,             (ECC: regenerate
    JUnit report)   dry-run records only)           all specs; --write only)
         │               ▲                               │
         └─ failures ────┘◀── Read/Grep/Glob on the ──────┘
                            course source (read-only)
                         ▼
                   report_outcome → CLI exit code
```

1. **Preflight** checks that `ecc`, `yq` and `modello` are on `PATH` and that the course has `.github/workflows/build-and-test.yml` (or `test/ui/regression-tests.sh`) so ECC knows what to build. It fails early, before any model spend.
2. **Run.** The agent calls `run_cypress` for a spec. This runs `modello run -- cypress run --spec <absolute path> --reporter junit ...` (the same call ECC's own `test:headless` makes underneath, but for one spec and with a machine-readable report). Failures come back as structured data.
3. **Diagnose.** For each failure the agent decides if it is a configuration problem. Typical case: `Expected to find element: \`#btn2-stale\`, but never found it`. It then searches the course source (the `content.yml` / locale files) and the model files for the correct value. It changes a value only when exactly one candidate is clearly right; otherwise it stops and reports what a human must decide.
4. **Fix.** `set_model_value` changes a single leaf in one of the three model files (identified by a key path). In **dry-run** (default) the change is only *recorded and reported*. With `--write` it is applied, preserving the file's indentation and trailing newline.
5. **Rebuild and verify** (`--write` only). `rebuild_spec` runs `ecc --script test:build`, which regenerates every spec; the agent then re-runs the same spec. It repeats until the spec passes or the run limit is reached.
6. **Report.** The agent ends with `report_outcome` (`fixed`, `proposed` or `unfixable`) plus a factual summary of what failed, what changed (`file`, key path, old → new) and the result. The CLI prints this and sets the exit code.

### Safety is enforced in code, not only in the prompt

- **Write allowlist (`src/guard.ts`).** Only `model-parameters.json`, `model-map.json` and `model-edges.json` inside the model directory can be written. Path traversal and symlinks that point outside are rejected.
- **Leaf-only, existing-entries-only patches.** A patch sets one scalar value. It cannot replace a subtree, delete anything, descend through a scalar, or use keys like `__proto__`. It also cannot create keys that do not exist (unless `create: true` is set explicitly): a wrong path is rejected with a hint listing the existing keys and where the key actually lives. This was added after a real run in which the agent left out the `&common` section and silently created a stray root-level key.
- **No shell, no editing tools.** The agent has no Bash/Edit/Write. Its only side effects are the five tools above. A permission gate (`canUseTool`) also confines Read/Grep/Glob to the project directory and blocks `.env*` files.
- **The model never supplies command text.** It passes a spec *file name* (validated) to a run template, and the run/build commands themselves come from the operator (`--run-cmd`, `--build-cmd`).
- **Bounded.** A maximum number of Cypress runs (`--max-attempts`) and a spend cap (`--max-budget-usd`).
- **Dry-run by default.** Nothing is written unless you pass `--write`. The tool never commits.

## 4. Prerequisites

- Node 20+ and npm.
- Claude credentials. The Agent SDK uses your existing Claude Code login, or `ANTHROPIC_API_KEY` if set. Runs cost money (a small dry-run costs roughly $0.10; see `--max-budget-usd`).
- `ecc`, `yq` (`brew install yq`) and `modello` on your `PATH`, and a course that builds tests with them. See the `ecc-course-dev` skill for ECC/Furnace setup.
- The target course must already have compiled content (`public/content/module-content.json` and `modules.json`) and its dependencies available, because the test build reads them. Cypress needs its binary cache and a browser (Electron is used by default).
- Network access to wherever the course is served. For the `s3` environment, tests run against the **deployed** course on S3 (its `baseUrl` is in `test/ui/modello.config.json`), not against your local `app/`.

## 5. Install

```bash
git clone <this repo> && cd my-agent
npm install
npm test            # 38 unit tests
npm run typecheck
```

## 6. Usage

> ⚠️ **`--write` edits the course checkout.** `ecc --script test:build` first **deletes `test/ui/cypress/e2e`** (gitignored, regenerated) and the fixer edits the `test/ui/model-*.json` files. It never commits; review with `git diff` in the course and keep or discard the changes yourself.

```bash
# Dry-run (default): find failures, propose a fix, change nothing.
npm run dev -- --project /path/to/course --spec digital-banking-m3-s3-s3.amazonaws.com.js

# Apply the fix, rebuild with ECC, and re-run the spec to confirm.
npm run dev -- --project /path/to/course --spec digital-banking-m3-s3-s3.amazonaws.com.js --write

# Check every generated spec (slow: each module can take several minutes).
npm run dev -- --project /path/to/course

# Build against a local course server (`ecc start` running) instead of S3.
npm run dev -- --project /path/to/course --write --local
```

After a run, review the change in the course repo with `git diff test/ui/` and decide for yourself whether to keep it.

### Options

| Option | Default | Meaning |
|---|---|---|
| `--project <dir>` | (required) | Course root (where `modello` is normally run from). |
| `--spec <file>` | all specs | A generated spec file name in `test/ui/cypress/e2e`. Repeatable. |
| `--write` | off | Apply changes. Without it, changes are only proposed. |
| `--local` | off | Build with `ecc --script test:local` (course server must be running). |
| `--model-dir <dir>` | `test/ui` | Folder with the `model-*.json` files, relative to the project. |
| `--max-attempts <n>` | `3` | Maximum Cypress runs. |
| `--max-budget-usd <n>` | `5` | Spend cap for the agent. |
| `--model <id>` | `claude-sonnet-5-5` | Claude model to use. |
| `--run-cmd <template>` | `modello run -- cypress run --spec {spec} --reporter junit --reporter-options mochaFile={report},toConsole=false` | How to run one spec. `{spec}` is an **absolute** path. |
| `--build-cmd <template>` | `ecc --script test:build` | How to regenerate specs. |

Why `{spec}` is absolute: `modello run` starts Cypress from modello's own install directory, so a project-relative path would resolve there and match nothing.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | `fixed` (spec passes after the change) or `proposed` (dry-run recorded a change). |
| `2` | `unfixable`: ambiguous, not a model-config problem, or the run limit was hit. |
| `3` | The agent finished without reporting an outcome. |
| `1` | Usage error or preflight failure. |

### Example output

```
→ mcp__fixer__run_cypress
→ Grep
→ mcp__fixer__set_model_value
→ mcp__fixer__rebuild_spec
→ mcp__fixer__run_cypress

--- Result ---
fixed: The spec failed on page m1/a1/page-2: cy.button("#btn2-stale") timed out ...
applied: model-parameters.json ["&common","m1/a1/page-2","select_block_by_type(\"button\";2)","selector"] "#btn2-stale" -> "#btn2"
cost: $0.13
```

### Skills used at every step

| Step | What you're doing | Skill / subagent |
|---|---|---|
| 1. Set up ECC, `yq`, Furnace/SDK symlinks | Prerequisites before anything runs | `ecc-course-dev` |
| 2. Build the course and generate specs | `ecc --script test:build` (or `test:local`) | `ecc-course-dev`, `modello-tests` |
| 3. Run a spec and read the failure | `modello run`, JUnit, Cypress screenshots, locating the failing page/block | `modello-tests` |
| 4. Run the fixer (dry-run, then `--write`) | This tool; rebuild and rerun the spec | `modello-tests` (usage), `ecc-course-dev` (build errors) |
| 5. Handle what the fixer can't | Manual config changes to `model-*.json` | `modello-tests` |
| 6. Review the change | `git diff` in the course, or in this repo | `code-review` skill, `reviewer` subagent |
| 7. Branch, commit, push, PR in the course repo | Only via the skill, after you confirm the text | `course-pr` |
| 8. Find your way around this codebase | "Where is X / how does Y work" | `researcher` subagent |
| 9. End the session | Update `docs/progress.md` | `wrap-up` |

The fixer agent itself does not use these skills at runtime; it only has the five `fixer` tools plus read-only Read/Grep/Glob. The skills guide *you* (and Claude Code) around it.

## 6a. Fix pipeline for a real course (milestone 1)

One local command, end to end, for a real course checkout:

```bash
npm run ui:build   # once, only needed for --serve
npm run fix-course -- --project /Users/jay/everfi/git/courses/digital-banking --serve
```

| Stage | What happens |
|---|---|
| Preflight | `ecc`/`yq`/`modello`/`git` present, project is the repo root, tree clean (except local-only `test/ui/config/cypress.config.js`, more with `--allow-dirty`), `git fetch origin develop`. |
| Branch | `test/modello-fixes-<YYYYMMDD-HHMM>` from `origin/develop`. Deleted again (back to your branch) if nothing gets committed. |
| Install deps | `yarn install --frozen-lockfile --prefer-offline` (as CI on a fresh checkout). Needed because ECC resolves the course's components through it; a `.pnp.js` left over from another checkout location makes `ecc build` fail with "Could not find ContentPartnerAPI or components". `--skip-install` / `--install-cmd` to change. |
| Build course | `ecc build --split` (as CI). `--skip-course-build` reuses `public/`. |
| Generate tests | `ecc --script test:build` (S3 specs, as CI). |
| Run tests | Every module's spec runs in the course folder (`test/ui/cypress/e2e`), `--concurrency` at a time, and results are collected. Plain Cypress: no agent, no spend. |
| Fix (one by one) | Each failing module gets a Claude agent, **one at a time**, in the course folder: diagnose, change one model value, rebuild, re-run. It starts from the collected result (no second run). A change that is not verified is reverted before the next agent starts, so writes never collide. |
| Final verify | Re-runs all fixed modules together (no model spend). A fix that fails now is reverted. |
| Report | `runs/<runId>/report.md` and `report.json`: per module result, changes (old -> new), cost, what needs a human. |
| Commit | Only `test/ui/model-parameters.json`, `model-map.json`, `model-edges.json`. Refuses if any other tracked file changed. |
| Push | Shows branch, files and message, asks `Push to origin? [y/N]` (`--push` skips the question; no terminal = no push). CI (`build and test`, runs on `test/**`) then verifies the branch. |

### Cheapest step first (AI only where judgement is needed)

| Order | Step | AI? |
|---|---|---|
| 1 | Run every spec, collect results | no |
| 2 | **Environment triage**: no report, `MODULE_NOT_FOUND`, Electron, network, auth, Applitools key, disk -> "Needs human (environment)" with the evidence line | no |
| 3 | **Flaky check**: retry each failure once; passing now = flaky, nothing changed | no |
| 4 | **Recipes**, each verified by one batched rebuild + rerun, reverted if still failing: a fix from the ledger (`runs/fix-ledger.json`), translation markup `[name='x']` -> `[name*='x']`, stale `#id`/`[data-*=...]` with exactly one similar value in the course source | no |
| 5 | Re-run a failing spec if an earlier fix changed anything (it may pass now) | no |
| 6 | **Agent**, one at a time, with a **case file** (failure, selector, spec block, model entries, what was ruled out) so it starts deciding instead of exploring | yes |

Agent token savings: tools load up front (no ToolSearch turn), no re-run of a spec it already has, narrow tools (`find_in_spec`, `get_model_entries`) instead of reading 50-70 KB specs, trimmed tool output (15 stack lines, 2,000-char tails), `node_modules`/`.yarn` off limits, `maxTurns` 20. The report shows, per module, whether a rule, a recipe or an agent handled it, plus cost and turns. Verified agent fixes are added to the ledger, so the same failure is fixed without AI next time. Switches: `--skip-flaky-check`, `--skip-recipes`, `--skip-cypress-verify`. Quality check: `npm run eval -- --yes` (spends a little; see `test/eval/`).

You raise the PR (the link is printed) and merge; the tool never does. Exit codes: `0` everything passed or was fixed, `2` some modules need a human, `1` a stage failed. Options: `npm run fix-course -- --help`.

## 6b. Orchestrator and live UI

The orchestrator works in the **real course folder**: it runs every module's spec (**several in parallel**) and collects the results, then fixes the failing modules with **one agent at a time**, each going through the same steps in order: diagnose → fix → rebuild → verify → report. Everything is streamed as events to the terminal and to a web UI, the **Modello Fixer control room** (pipeline stages, agents, execution matrix). The default model is Claude Sonnet 4.5 (`claude-sonnet-4-5`) via the Claude Agent SDK.

```bash
npm run ui:build                                   # once, builds ui/dist
npm run orchestrate -- --serve --demo              # UI on http://localhost:4317, demo only (no Cypress, no spend)
npm run orchestrate -- --serve --project /path/to/course --concurrency 2   # UI with live runs enabled
npm run orchestrate -- --project /path/to/course --concurrency 2            # terminal only
npm run orchestrate -- --demo                      # scripted run in the terminal
npm run orchestrate -- --replay runs/<runId>.jsonl # replay a saved run
npm run ui:dev                                     # Vite dev server on 5173 (proxies /api to 4317)
```

- **Why one fixer at a time.** ECC deletes and regenerates `cypress/e2e` on every rebuild, and every agent edits the same model files. Running tests in parallel is safe (read-only); writing and rebuilding is done by one agent at a time, so nothing collides and no locking is needed.
- **`--isolate` (optional).** The earlier mode: every agent in parallel, each in a copy-on-write copy of the course in a temp folder (no `.git`, no Cypress media, `node_modules` symlinked; paths resolved to `/private/var/...` on macOS so Cypress finds the spec). With `--write`, only `fixed` agents' patches are replayed onto the checkout through the guard; a key another agent set differently is a `conflict` and not written.
- **Logs.** Every run is saved to `runs/<runId>.jsonl` (gitignored) and can be replayed in the terminal or the UI.
- **Verified only.** An agent that reports `fixed` without a successful rebuild and a passing rerun after its last change is downgraded to `proposed`, and its change is reverted (or, with `--isolate`, not merged).
- **Local only.** The UI server listens on `127.0.0.1` and refuses requests from other hosts or cross-site pages, because `POST /api/runs?mode=live` spends money and, with `--write`, edits the checkout.
- **`--isolate` caveats.** `--model-dir` must be relative, and model files that link out of the workspace are refused. `node_modules` is symlinked, not copied, so anything a build writes there is shared with the real checkout. `.git` is not copied, so a build step that reads git metadata behaves differently in a workspace.
- Extra options: `--concurrency` (default 2), `--isolate`, `--keep-workspaces` (with `--isolate`), `--speed`, `--port`. `--max-budget-usd` is **per agent**.

## 7. Known limitations

- **No page/block context from Cypress.** The failure stack from a real run only contains frames from modello's support code (for example `support/course/legacy-sdk/blocks/modal.js:11`), not the generated spec. The code can map a spec line to its `// -> page: ..., block uid:` comment, but real failures rarely include that line. In practice the agent works from the failing **selector in the error message**, which it searches for in the model files and course source. Failures with no selector in the message are harder.
- **Stale compiled content.** Modello generates from `public/content/*.json`, which is git-ignored and can be older than the deployed course (tests run against the deployed S3 course). Rebuild the course (`ecc build`) or compare with the deployed `module-content.json` before blaming a config problem. In our check the generated specs were identical either way, but that is not guaranteed.
- **Flaky specs.** Real specs can fail intermittently (for example the intro modal waiting for its close button). The same unmodified spec has failed and then passed on a later run. Confirm a failure reproduces before trusting a fix.
- **Slow.** A single real module run takes from about one to six minutes, and each fix triggers a full ECC rebuild of every module.
- **ECC rebuild is all-or-nothing.** `ecc --script test:build` deletes and regenerates all specs and reads the `call-build-and-test-course` job from `build-and-test.yml`. Courses that use a different workflow file or job need `test/ui/regression-tests.sh` or a `--build-cmd` override.
- **JSON reformatting.** Writes re-serialize the whole file using its original indent. A file with hand-compacted lines will be reformatted.
- **Scope of repairs.** Selector fixes in `model-parameters.json` are the primary case. `model-map.json` and `model-edges.json` repairs are possible through the same tool but less exercised.

## 8. Project layout

| Path | Purpose |
|---|---|
| `src/cli.ts` | Argument parsing, preflight, result printing, exit codes. |
| `src/agent.ts` | Agent loop over the Claude Agent SDK and the permission gate (`canUseTool`). |
| `src/tools/index.ts` | The five tools exposed to the agent (`list_specs`, `run_cypress`, `set_model_value`, `rebuild_spec`, `report_outcome`). |
| `src/session.ts` | All side effects (run, patch, rebuild) and run state. |
| `src/guard.ts` | Write allowlist, leaf-only patching, format-preserving serialization. |
| `src/failures.ts` | JUnit parsing and stack-line → spec block mapping. |
| `src/preflight.ts` | Tool/workflow checks before any run. |
| `src/config.ts`, `src/shell.ts` | Defaults and command-template execution. |
| `src/prompt.ts` | The agent's system prompt. |
| `test/` | Vitest unit tests (guard, parser, session, permission gate, preflight). |
| `docs/` | `architecture.md` (design), `progress.md` (status and next steps). |

## 9. Development

```bash
npm test                                   # all tests
npx vitest run test/guard.test.ts          # one file (add -t "<name>" for one case)
npm run typecheck
npm run dev -- --help
```

Unit tests use fake run/build commands. **They cannot catch real-run bugs** (for example the absolute `--spec` path requirement was only found by running against a real course), so verify run/build changes against a real course checkout (e.g. under `/Users/jay/everfi/git/courses`).

## 10. Working in this repo with Claude Code

This project is built and maintained with Claude Code.

- `CLAUDE.md`: project guidance and rules for Claude Code sessions (plan before multi-file changes, don't add dependencies without asking, never commit secrets).
- `.claude/skills/` (invoke with `/<skill-name>` or just ask; Claude loads them when the task matches):
  - `ecc-course-dev`: ECC and Furnace setup, building and serving courses.
  - `modello-tests`: generating, running and debugging Modello tests, and using this fixer.
  - `course-pr`: branch, commit, push and open a PR in a course repo (only sanctioned way to commit there; confirms text first).
  - `code-review`: review the current diff (Must fix / Should fix / Nit); read-only.
  - `wrap-up`: end-of-session summary appended to `docs/progress.md`.
- `.claude/agents/`: `reviewer` (read-only diff review) and `researcher` (read-only "where/how" lookups) subagents.
- `.claude/settings.json`: shared permissions (read-only git and `ls` allowed; `.env*` reads and `rm -rf` denied).
- `setup.sh`: one-time bootstrap (git init, initial commit, optional private GitHub repo via `gh`). Don't rerun it casually.
- `CLAUDE.local.md` (gitignored) is for personal overrides.
