---
name: modello-tests
description: How to generate, run and debug Modello Cypress tests for an EverFi course via ECC and the modello CLI, and how to use the Modello Tests Fixer agent in this repo. Use when asked to generate or run course tests, interpret Cypress failures from generated specs, change model-parameters/model-map/model-edges, or run the fixer.
---

# Modello tests

Modello generates Cypress specs from a course's compiled content plus model config in `test/ui/`. Courses are driven through ECC. Read `ecc-course-dev` for ECC/Furnace setup.

## Course layout (`test/ui/`)
- `modello.config.json`: platforms and environments. Example: `s3` -> `s3.amazonaws.com` with a `baseUrl` of the deployed course on S3, so runs hit the **deployed** course, not your local `app/`.
- `model-parameters.json` (selectors/params per page and block), `model-map.json` (block replacements), `model-edges.json` (navigation wiring), `customizations.json`, `custom-code/`.
- `cypress/e2e/*.js`: generated specs. Disposable output; never the source of truth. Each command is preceded by `// -> page: <page>, block uid: <uid>` plus `type:`, `replacement:`, `parameters:` comments. Block UIDs change on every build; line numbers do not.

## Generate tests
- Through ECC (what the team uses): `ecc --script test:build`.
  - It **deletes `test/ui/cypress/e2e`**, then runs every line of `generate-tests-script` from the `call-build-and-test-course` job in `.github/workflows/build-and-test.yml` (or each line of `test/ui/regression-tests.sh` if that file exists). It sleeps 6s first and always rebuilds every scope; there is no per-scope option.
  - `ecc --script test:local` does the same against a local server (`s3` -> `local`, `s3.amazonaws.com` -> `localhost`); have `ecc start` running.
  - A repo whose workflow uses a different file or job key (for example digital-banking's `generate-and-test.yml`) needs `regression-tests.sh` or a direct `modello build`.
- Direct: `modello build --scope m1 --platform s3 --environment s3.amazonaws.com` (also `--with-homeroom-survey` for homeroom platforms). Needs `public/content/module-content.json` and `modules.json`.

## Run tests
- All specs: `ecc --script test:headless` (headless Chrome, no spec filter, no machine-readable report) or `ecc --script test:cypress` (Cypress UI). Both call `modello run` underneath. `test:build:headless` / `test:build:cypress` build first.
- One spec with a report (what the fixer uses):
  `modello run -- cypress run --spec <ABSOLUTE path to spec> --reporter junit --reporter-options "mochaFile=<abs report path>,toConsole=false"`
  - **The `--spec` path must be absolute.** `modello run` starts Cypress from modello's own install dir, so a relative path resolves there and fails with "no spec files were found".
  - Run it from the course root. Cypress needs its binary cache (`~/Library/Caches/Cypress`).
  - A real module run takes about 0.5-2 min. Failed tests are retried once.

## Reading failures
- The failure stack only has webpack frames from modello's support code (for example `support/course/legacy-sdk/blocks/modal.js:11`, `assessment.js:52`), never the generated spec. This is true with the JUnit reporter AND with Cypress's default reporter (checked both), so the page and block are NOT recoverable from the stack.
- What you do have: the **selector in the message** (``Expected to find element: `#btn2-stale`, but never found it``). Search `test/ui/model-parameters.json` for that string to find the page and block key, then read the course source (`app/modules/<m>/<a>/<page>/content.yml`) for the real id.
- "Expected to find element ... never found it" after a 10s timeout is the classic stale-selector failure. It can also be a timing flake (see below) or a deployed-course change.
- Cypress clears `cypress/screenshots` and `cypress/videos` at the start of every run, so only the last run's artifacts survive. A passing run leaves none.

## How modello uses the config (digital-banking, m3 as the example)
- `model-map.json`: a block key mapped to `null` removes that block from the generated test (bypass); mapped to a filename it is replaced by that file from `test/ui/custom-code/` (for example `m1/a1/page-1` -> `modal.js`, whose body is `cy.modal(); cy.navigate();`). Many m3 pages use `addButton1.js` or per-page files such as `m3-a6-p5.js`.
- `cy.modal(open, close = '.modal__header__close button')`: when called with no arguments (as in the custom `modal.js`) it waits up to 10s for that default close button. A failure naming `.modal__header__close button` therefore comes from a no-argument `cy.modal()`, most likely the intro modal.
- `model-parameters.json` keys look like `"<section>" -> "<page>" -> "select_block_by_type(\"modal\";0)" -> { openModalSelector, closeModalSelector }`. m3 entries live under `&common` (the `s3`/`local`/`homeroom` sections only point back at it with `"...": "&common"`). A new key at the file root is NOT where the generator looks.
- Regeneration is deterministic for config: a broken selector appears in the generated spec at exactly the matching `cy.*` call and nowhere else. Only the `block uid:` comments change between builds (mask them when diffing: `sed -E 's/block uid: [0-9a-f-]+/block uid: X/'`).

## Checking "what changed in the course"
1. `app/` YAML is the source: `git fetch` and compare with `origin/develop`; check `git log -1` against the deploy time.
2. Compiled content `public/content/` is git-ignored and can be stale. Compare with what is deployed: `curl https://<s3 baseUrl>/content/module-content.json` (headers show `Last-Modified`) and deep-diff the JSON per module.
3. To regenerate tests against the deployed content without a full `yarn install`, copy the deployed `module-content.json` and `modules.json` into `public/content/` of a **scratch copy** and run `ecc --script test:build`.
- Observed 2026-10-11 (digital-banking): local `public/` was from 12 Aug while S3 `develop` was deployed 9 Oct. Only 52 differences: `m3/a7/page-2` (lottie blocks now wrapped in `container` blocks) and `m2/a6/page-2`, `m2/a3/page-3`, `m2/a3/page-5`; m1 and m4 identical. Specs generated from either content were identical after masking UIDs, so these changes did not alter generation.

## Baseline and flakiness (observed 2026-10-11, digital-banking, S3 develop)
- First runs on the unmodified course: m1 (1m49s), m2 and m3 failed at `.modal__header__close button`; m4 failed at `[data-action-type="assessment-question__container"]`.
- A later rerun of m3 PASSED (6m20s) with the same spec against the same deployed course (its `Last-Modified` pre-dated every run). So these failures are flaky, not a stable config problem. Re-run a failing spec before attributing it to config, and never "fix" a failure that does not reproduce.
- A real module run takes 1 to 6+ minutes. A deliberately broken selector on an early page fails fast (about 1 minute).

## Fixer agent (this repo)
- Dry-run: `npm run dev -- --project <course-root> [--spec <file>]`. Apply: add `--write`. `--local` builds with `ecc --script test:local`. Override commands with `--run-cmd` ({spec}, {report}) and `--build-cmd`. Docs: `docs/architecture.md`.
- It may only edit `model-parameters.json`, `model-map.json`, `model-edges.json`; it never edits course source or generated specs, and never commits. `set_model_value` edits EXISTING entries only: a path that does not exist is rejected with a hint (existing keys, and where the key does exist), unless `create: true`. (Before this guard, an agent that left out `&common` silently created a stray root key.)
- `--write` runs the ECC build, which deletes and regenerates `cypress/e2e`. Real checkouts are in `/Users/jay/everfi/git/courses`; it is fine to run there (e2e is gitignored). The fixer (`npm run dev`) never commits; the owner keeps or discards model-file changes manually. The pipeline (`npm run fix-course -- --project <root>`) does commit: on a new `test/modello-fixes-<time>` branch from origin/develop, only `test/ui/model-*.json`, then asks y/N before pushing (CI's build-and-test runs on `test/**`). A human raises the PR.
- Needs `ecc`, `yq` and `modello` on PATH; preflight checks this. Costs money (`--max-budget-usd`, default 5).
