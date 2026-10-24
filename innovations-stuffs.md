# Innovations

What is new or different about the Modello Tests Fixer, and what we learned building it. Written for sharing in Tech Thursday sessions and with the team. For usage, see [`docs/agent-guide.md`](docs/agent-guide.md); for status, see [`docs/progress.md`](docs/progress.md).

## 1. The idea

Generated UI tests break when course content changes, even though the course is fine. The repair is usually one value in a model config file plus a slow rebuild. This agent does that loop: run the spec, diagnose, fix one value, rebuild, rerun, report. It stops and hands over to a person when the cause is not a simple config value.

## 2. What is innovative

### Safety enforced in code, not in the prompt
Most agent demos rely on "please don't do X" in the system prompt. Here the limits are structural:
- **No shell, no Edit/Write.** The agent's only side effects are five purpose-built tools (`list_specs`, `run_cypress`, `set_model_value`, `rebuild_spec`, `report_outcome`).
- **A write guard** allows only three files, rejects path traversal and symlinks that point outside, and accepts one scalar leaf per patch (no subtrees, deletes or `__proto__`).
- **A permission gate** (`canUseTool`) confines Read/Grep/Glob to the project and blocks `.env*`.
- **The model never writes command text.** It passes a spec file name; run and build commands are operator templates.
- **Bounded:** max Cypress runs and a spend cap. **Dry-run by default**, and it never commits.

### Tools designed to prevent a past mistake
`set_model_value` rejects keys that don't exist unless `create: true`, and replies with a hint listing the real keys. This came from a real run where the agent left out the `&common` section and silently created a stray root-level key. The tool, not the model, now blocks that class of error.

### Structured failures instead of raw logs
The JUnit report is parsed into structured failures. Where possible a stack frame is mapped to the `// -> page: ..., block uid:` comment in the generated spec, so the agent sees page, block, parameters and command rather than a wall of Cypress output.

### "Unfixable" is a first-class, correct answer
The agent is told to change a value only when exactly one candidate is clearly right. Environment problems, flaky specs, course bugs and visual diffs end as `unfixable` with no write and a note on what a human must decide. On the real m1 failure it did exactly that.

### Reversible, reviewable output
Writes preserve the file's indent and trailing newline, and each change is reported as file, key path, old → new. Review is a normal `git diff` in the course, and PRs go through the `course-pr` skill after the text is confirmed.

### Built on the team's real tooling
It drives the existing pipeline rather than a parallel one: ECC (`ecc --script test:build`) to regenerate specs and `modello run` for a single spec with a JUnit reporter. The agent is a layer over how engineers already work.

### Skills and subagents around the agent
Repeatable knowledge lives in Claude Code skills (`ecc-course-dev`, `modello-tests`, `course-pr`, `code-review`, `wrap-up`) and read-only subagents (`reviewer`, `researcher`). New team members get the same playbook the agent was built with. The README has a table of which skill applies at each step.

## 3. Lessons learned

- **Stubbed tests hide real bugs.** All unit and smoke tests passed, but the first real run showed `modello run` needs an absolute `--spec` (it runs Cypress from its own install directory).
- **A bare `allowedTools` bypassed the permission gate** for Read/Grep/Glob. Found in the smoke test and fixed so `canUseTool` always decides.
- **Real failures rarely say where they happened.** The Cypress stack contains modello support frames, not the generated spec. The failing selector in the error message, plus the screenshot's command log, is what actually locates the page and block.
- **Not every failure is a one-value fix.** On Digital Banking m1 the causes were selectors wrapped in translation-edit markup and a random-answer assessment that flaked. Those need a multi-step config change, which the agent correctly declined.
- **Prompt rules are not airtight.** One dry-run proposed the right fix with weaker evidence (inferred from a sibling page), which is why the guard and the human review matter.
- **Cost is small.** About $0.10–0.15 per run; the slow part is Cypress and the full ECC rebuild.

## 4. Where it can go next

- Handle multi-step causes: selectors wrapped in translation-edit markup, and replacing a random-answer assessment with a deterministic custom-code file.
- Find the failing page and block automatically (screenshot command log, or a DOM dump on failure).
- Repairs for `model-map.json` and `model-edges.json`, with tests.
- An optional `--set-selector` override when the agent can't infer the value.
- Preserve hand-formatted JSON on write.
- Validate across modules (m2–m4) and courses (Adult Learning Modules, Future Smart 2, Grow), then record an end-to-end demo.
- Reuse the pattern: a narrow, guarded tool set plus a clear "stop and ask" path would fit other repair loops (lint config, snapshot updates, content-build errors).

## 5. Honest status

Built and unit-tested (38 tests). Proven end to end on a deliberately broken selector in a copy of Digital Banking. On real Digital Banking m1 the agent correctly said "unfixable", and the fix was done by hand with the same workflow. It has not yet fixed a real failure on its own in a real checkout.
