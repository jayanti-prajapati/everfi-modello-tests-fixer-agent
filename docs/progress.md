# Progress log

## Status
Core agent implemented and unit-tested (29 tests, typecheck clean): guard, failure parser, session, tools, agent loop, CLI. Not yet run against a real model or a real course.

## Next steps
- [ ] Smoke test: copy digital-banking `test/ui`, break one selector, run with a stub run/build command (dry-run, then `--write`). Needs Anthropic credential.
- [ ] Verify the grow layout (`EVERFI-Content/grow`): `gh` token needs SAML authorization, or use a local clone. Confirm run/build commands.
- [ ] Add model-map and model-edges repair guidance/tests (selector repair in model-parameters comes first).
- [ ] Optional `--set-selector` override for cases the agent can't infer.
- [ ] Decide how to preserve hand-formatted JSON on write.
