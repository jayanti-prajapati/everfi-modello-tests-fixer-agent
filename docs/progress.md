# Progress log

## Status
Core agent implemented and unit-tested (29 tests, typecheck clean): guard, failure parser, session, tools, agent loop, CLI.

Smoke test done (2026-10-11) on a scratch copy of digital-banking `app/` + `test/ui` with one broken selector (`#btn2` -> `#btn2-stale`, m1/a1/page-2) and stubbed run/build commands: dry-run proposed the right one-leaf change and wrote nothing; `--write` fixed it, rebuilt, reran green, and left the model file identical to the original with nothing else touched. ~$0.10-0.13 per run. Real `modello run`/`build` (AWS, browser) not exercised yet. One extra dry-run once proposed the same fix with weaker evidence (inferred from a sibling page), so the prompt's "only when clearly unique" rule is not airtight.

## Next steps
- [ ] Run once against a real `modello run`/`modello build` on digital-banking (needs AWS creds and a browser).
- [ ] Verify the grow layout (`EVERFI-Content/grow`): `gh` token needs SAML authorization, or use a local clone. Confirm run/build commands.
- [ ] Add model-map and model-edges repair guidance/tests (selector repair in model-parameters comes first).
- [ ] Optional `--set-selector` override for cases the agent can't infer.
- [ ] Decide how to preserve hand-formatted JSON on write.
