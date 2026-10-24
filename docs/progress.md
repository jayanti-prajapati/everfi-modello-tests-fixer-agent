# Progress log

## Status
Core agent implemented and unit-tested (35 tests, typecheck clean): guard, failure parser, session, tools, agent loop, CLI.

Smoke test done (2026-10-11) on a scratch copy of digital-banking `app/` + `test/ui` with one broken selector (`#btn2` -> `#btn2-stale`, m1/a1/page-2) and stubbed run/build commands: dry-run proposed the right one-leaf change and wrote nothing; `--write` fixed it, rebuilt, reran green, and left the model file identical to the original with nothing else touched. ~$0.10-0.13 per run. Build now defaults to ECC (`ecc --script test:build`); smoke test re-passed with a stubbed build after that change. Real `ecc`/`modello run` (AWS, browser, compiled course content) not exercised yet; preflight passes against the real digital-banking checkout. One extra dry-run once proposed the same fix with weaker evidence (inferred from a sibling page), so the prompt's "only when clearly unique" rule is not airtight.

## Next steps
- [ ] First real `npm run fix-course -- --project /Users/jay/everfi/git/courses/digital-banking --serve` (not run yet; user asked not to test). Check: `ecc build --split` and `test:build` in the checkout, workspace copies build without `.git`, final verify, commit contents, y/N push, CI on the `test/**` branch.
- [ ] Remove the leftover workspace `$TMPDIR/modello-orchestrator/m3-dEsUjB` (from a stopped run; `rm -rf` is denied in this repo's settings).
- [ ] Open the PR for branch `modello-m1-config-fixes` (pushed, commit `4e7085fd`): `gh` is still blocked by SAML on `EVERFI-Content`, so use the browser link or authorize the token. Body is ready (see 2026-10-12 entry).
- [ ] Rerun m1 to check the green run holds; run m2 (the `m2/a4/page-4` selector change is untested), then m3 and m4.
- [ ] Solve "which page/block failed" for real runs: the JUnit stack has no generated-spec frame. The failure screenshot's command log plus a search of the generated spec for the failing selector works manually; automate it or add a DOM dump on failure.
- [ ] Teach the fixer about config-level causes it could not handle on m1: selector wrapped in translation-edit markup (`[name*=...]`), and replacing a random-answer assessment with a deterministic custom-code file. Neither fits the current "set one leaf" tool.
- [ ] Run the fixer end to end on a failure it can actually fix, on a real checkout in `/Users/jay/everfi/git/courses` (changes are reviewed and kept/discarded manually).
- [ ] Verify the grow layout (`EVERFI-Content/grow`): needs the `gh` token SAML-authorized, or a local clone. Confirm ECC applies (`build-and-test.yml` with a `call-build-and-test-course` job).
- [ ] Add model-map and model-edges repair guidance/tests (selector repair in model-parameters comes first).
- [ ] Optional `--set-selector` override for cases the agent can't infer.
- [ ] Decide how to preserve hand-formatted JSON on write.
- [ ] Push this repo's 3 local commits when ready (`212411a`, `ce6b802`, `12e7da8` on `main`; nothing pushed).

## 2026-10-11 session
**Done**
- Built the Modello Tests Fixer: guard, JUnit parser, session, MCP tools, agent loop, CLI, preflight (35 tests). Commits `89ba151`, `d84488e`, `1b406d8`, `ceb7723`, `b3e5434`.
- Stubbed smoke test passed (dry-run proposes, `--write` fixes). Found and fixed a permission-gate bug (bare `allowedTools` bypassed `canUseTool` for Read/Grep/Glob).
- Switched the default build to ECC (`ecc --script test:build`, `--local` for `test:local`); run stays `modello run ... --reporter junit`.
- Real runs on a throwaway full copy of digital-banking: `ecc --script test:build` works (4 specs, 14s). Fixed a bug the stubs hid: `{spec}` must be an absolute path.
- Real baseline on the unmodified course (S3 develop): m1, m2, m3 fail at `.modal__header__close button`; m4 fails at `[data-action-type="assessment-question__container"]`.
- Added skills `ecc-course-dev` and `modello-tests` (uncommitted).

**In progress**
- Real end-to-end fixer run: blocked on the spec-line problem and on having no passing baseline.

**Next steps**
- See Next steps above. Also commit the two new skills and update the `.claude/skills/` line in `CLAUDE.md`.

**Open questions**
- Are the baseline failures real course/environment problems or stale modello support code? Deployed S3 `develop` may differ from the local `app/`.
- Grow (`EVERFI-Content/grow`) is unreadable until the `gh` token is SAML-authorized (or a local clone path is given).

## 2026-10-12 session
**Done**
- Moved to real course checkouts in `/Users/jay/everfi/git/courses` (digital-banking, adult-learning-modules, future-smart-2); updated CLAUDE.md, README, modello-tests skill and this log to drop the throwaway-copy rule.
- Ran m1 on the cleaned digital-banking: first failed on Applitools (no API key; set `APPLITOOLS_ENABLED: false` locally in `test/ui/config/cypress.config.js`, uncommitted, not in the PR). Fixer dry-run on m1: `unfixable`, $0.10, no writes (the failing selector lives in modello support code).
- Diagnosed from screenshots, modello's `assessment.js` and a DOM dump: (1) `m1/a2/page-4` inputs have `name` set to translation-edit markup (`<span data-forgeaction='editlocale' ...>formField1</span>`) so `[name='formField1']` never matched, deterministic; (2) modello's one-at-a-time assessment clicks random answers and on a failed attempt does go back/forward, landing on the page-5 intro, so it flaked.
- Config fix: `model-parameters.json` `[name='formFieldN']` -> `[name*='formFieldN']` (m1/a2/page-4, m2/a4/page-4); `model-map.json` s3 section maps `m1/a1/page-6` assessment to `prod-assesment-5.js`. After `ecc --script test:build`, m1 passed from the regenerated spec (4m31s, one run). A hand-patched spec with the same fixes also passed (4m33s).
- Added skill `course-pr` (branch, commit, push, PR with detailed description, confirm before push); branch `modello-m1-config-fixes` committed (`4e7085fd`) and pushed.
- Committed this repo's pending work: `ce6b802` (set_model_value rejects non-existent keys unless `create: true`; 38 tests, typecheck clean) and `12e7da8` (real-checkout docs, `course-pr` skill, progress).

**In progress**
- PR not created: `gh pr create` and `gh pr list` both return the SAML enforcement error for `EVERFI-Content` (checked again at wrap-up). The pushed branch is fine.

**Open questions**
- Is the first choice correct in every s3 assessment question? m1 passed once with `prod-assesment-5.js`, not confirmed from source.
- Is translation-edit mode on in the deployed `develop` build (wrapped `name` attributes)? Possibly a deploy issue for the course team.
- Is m1 stable across reruns, and do m2-m4 pass with these changes?

## 2026-10-24 session
**Done**
- Multi-agent orchestrator over `runFixer` (`src/orchestrator/`): one agent per module spec, parallel (`--concurrency`), steps run -> diagnose -> fix -> rebuild -> verify -> report, each agent in a copy-on-write workspace; only verified fixes merged (all-or-nothing per agent, conflicts detected); events to terminal, JSONL (`runs/`) and SSE.
- Live UI (`ui/`, Vite + React, dark theme modelled on the QA Guardian screenshot): orchestration canvas, agent cards with progress rings, execution matrix, pipeline stage bar. `npm run orchestrate -- --serve --demo` for an offline demo. Server is local-only (127.0.0.1, Host/Origin checks).
- Milestone 1 pipeline `npm run fix-course` (`src/pipeline/`): preflight -> branch `test/modello-fixes-<time>` from origin/develop -> `ecc build --split` -> `ecc --script test:build` -> parallel fix -> final verify in checkout (revert on failure) -> report -> commit only `test/ui/model-*.json` -> push after y/N. PR/merge stay human. CLAUDE.md, `course-pr` and `modello-tests` skills updated for this.
- Found: VS Code sets `ELECTRON_RUN_AS_NODE=1`; inherited by Cypress it made every run fail with MODULE_NOT_FOUND (also in the real checkout). `runShell` now drops it (`childEnv`).
- Reviewer findings fixed (merge of unverified values, partial merges, absolute `--model-dir` bypassing isolation, unauthenticated server, crash on bad URL, agent-claimed success, workspace leak, stuck UI, step regressions). 66 tests, typecheck clean. Default model for orchestrator/pipeline: `claude-sonnet-4-5`. New dev deps: react, react-dom, vite, @vitejs/plugin-react, @types/react, @types/react-dom.

**Open questions**
- Does `ecc --script test:build` need `.git` (workspaces exclude it)? Does any build step write into `node_modules` (symlinked into workspaces)?
- Real per-module cost/time with Sonnet 4.5 in parallel (one interrupted dry-run cost $0.48 for 2 modules, but Cypress never started because of the Electron env bug).

