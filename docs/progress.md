# Progress log

## Status
Core agent implemented and unit-tested (35 tests, typecheck clean): guard, failure parser, session, tools, agent loop, CLI.

Smoke test done (2026-10-11) on a scratch copy of digital-banking `app/` + `test/ui` with one broken selector (`#btn2` -> `#btn2-stale`, m1/a1/page-2) and stubbed run/build commands: dry-run proposed the right one-leaf change and wrote nothing; `--write` fixed it, rebuilt, reran green, and left the model file identical to the original with nothing else touched. ~$0.10-0.13 per run. Build now defaults to ECC (`ecc --script test:build`); smoke test re-passed with a stubbed build after that change. Real `ecc`/`modello run` (AWS, browser, compiled course content) not exercised yet; preflight passes against the real digital-banking checkout. One extra dry-run once proposed the same fix with weaker evidence (inferred from a sibling page), so the prompt's "only when clearly unique" rule is not airtight.

## Next steps
- [ ] Solve "which page/block failed" for real runs: the JUnit stack has no generated-spec frame (see 2026-10-11 entry). Try Cypress `codeFrame`, default-reporter console output, or screenshots.
- [ ] Look at a failure screenshot (m3 is fastest, ~32s) to decide if the shared modal failure is course config, the deployed S3 course, or stale modello support code.
- [ ] Then run the agent for real on a throwaway copy (`~/.../scratchpad/real1/digital-banking` was used this session; scratchpad is temporary).
- [ ] Verify the grow layout (`EVERFI-Content/grow`): `gh` token needs SAML authorization, or use a local clone. Confirm ECC applies (`build-and-test.yml` with a `call-build-and-test-course` job).
- [ ] Add model-map and model-edges repair guidance/tests (selector repair in model-parameters comes first).
- [ ] Optional `--set-selector` override for cases the agent can't infer.
- [ ] Decide how to preserve hand-formatted JSON on write.

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
