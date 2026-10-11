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
- The JUnit `<failure>` stack only has webpack frames from modello's support code (for example `support/course/legacy-sdk/blocks/modal.js:13`, `assessment.js:52`), not the generated spec. So the page and block are NOT recoverable from the stack alone (open problem in this repo). Screenshots land in `test/ui/cypress/screenshots/<spec>/`, videos in `cypress/videos/`.
- "Expected to find element ... never found it" after a 10s timeout is the classic stale-selector failure, but it can also mean the deployed course changed, or the support code is stale.

## Baseline (observed 2026-10-11, digital-banking, S3 develop, a scratch copy)
All four specs failed on the unmodified course: m1, m2, m3 at `.modal__header__close button`, m4 at `[data-action-type="assessment-question__container"]`. Check a spec's baseline before attributing a failure to your own change.

## Fixer agent (this repo)
- Dry-run: `npm run dev -- --project <course-root> [--spec <file>]`. Apply: add `--write`. `--local` builds with `ecc --script test:local`. Override commands with `--run-cmd` ({spec}, {report}) and `--build-cmd`. Docs: `docs/architecture.md`.
- It may only edit `model-parameters.json`, `model-map.json`, `model-edges.json`; it never edits course source or generated specs, and never commits.
- `--write` runs the ECC build, which deletes and regenerates `cypress/e2e`. Use a throwaway copy of the course for experiments.
- Needs `ecc`, `yq` and `modello` on PATH; preflight checks this. Costs money (`--max-budget-usd`, default 5).
