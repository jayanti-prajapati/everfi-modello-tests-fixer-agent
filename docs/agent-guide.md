# Modello Tests Fixer: what's in it and how to use it

## What it does, in one paragraph

You point it at an EverFi course checkout whose generated Cypress tests fail. It runs a spec, reads the failure, searches the course source for the correct value, and changes **one leaf value** in the course's model config (`model-parameters.json`, `model-map.json`, `model-edges.json`). With `--write` it then rebuilds the specs through ECC and reruns the same spec to confirm. Without `--write` it only proposes the change. It never commits.

## What's in the agent

### The pieces

| Piece | File | Role |
|---|---|---|
| CLI | `src/cli.ts` | Parses options, runs preflight, prints the result, sets the exit code. |
| Agent loop | `src/agent.ts` | Claude Agent SDK `query()` loop plus a permission gate: only the fixer tools and Read/Grep/Glob inside the project. No Bash, Edit or Write. |
| Tools | `src/tools/index.ts` | The five actions the agent can take (below). |
| Session | `src/session.ts` | Runs the commands, applies patches, counts attempts, keeps proposals and the outcome. |
| Guard | `src/guard.ts` | Write allowlist, leaf-only patching, format-preserving JSON writer. |
| Failure parser | `src/failures.ts` | Parses the JUnit report and maps a stack frame to the `// -> page: ... block uid:` comment in the generated spec. |
| Preflight | `src/preflight.ts` | Checks `ecc`, `yq`, `modello` and the build workflow exist before any spend. |
| Prompt | `src/prompt.ts` | The agent's instructions: what is fixable, when to stop. |
| Config | `src/config.ts`, `src/shell.ts` | Defaults and the run/build command templates. |
| Tests | `test/` | 38 Vitest tests (guard, parser, session, permission gate, preflight). |

### The five tools the agent has

| Tool | What it does |
|---|---|
| `list_specs` | Lists the generated spec files. |
| `run_cypress` | Runs one spec (by file name) and returns structured failures. Counts against `--max-attempts`. |
| `set_model_value` | Sets one leaf in one of the three model files, addressed by a key path. Rejects paths that don't exist unless `create: true`. Dry-run only records it. |
| `rebuild_spec` | Runs `ecc --script test:build`, which regenerates all specs. `--write` only. |
| `report_outcome` | Ends the run with `fixed`, `proposed` or `unfixable` and a summary. |

### Safety limits (enforced in code)

- Writes only to the three model files in the model directory; path traversal and outward symlinks are rejected.
- One scalar leaf per patch. No subtree replacement, no deletes, no `__proto__`.
- The model never supplies command text. Run and build commands are operator templates.
- Capped by `--max-attempts` (Cypress runs) and `--max-budget-usd`.
- Dry-run by default; no git commits.

### Companion material in this repo

- `.claude/skills/modello-tests`: generate, run and debug Modello tests, and drive the fixer.
- `.claude/skills/ecc-course-dev`: set up and build courses with ECC/Furnace.
- `.claude/skills/course-pr`: branch, commit, push and open a PR in a course repo, after you confirm the text.
- `.claude/skills/code-review`, `wrap-up`; subagents `reviewer`, `researcher`.

## How to use it

### 1. One-time setup

```bash
npm install
npm test && npm run typecheck     # expect 38 passing, typecheck clean
```

You also need:

- Node 20+ and a Claude login (or `ANTHROPIC_API_KEY`).
- `ecc`, `yq` and `modello` on `PATH`.
- A course with compiled content and a `build-and-test.yml` (or `test/ui/regression-tests.sh`).
- For real runs, `APPLITOOLS_ENABLED: false` in the course's `test/ui/config/cypress.config.js` if you have no Applitools key (keep it out of any PR).

### 2. Dry-run first

```bash
npm run dev -- --project /Users/jay/everfi/git/courses/digital-banking \
  --spec digital-banking-m1-s3-s3.amazonaws.com.js
```

Writes nothing. The result prints a proposal like:

```
proposed: model-parameters.json ["&common","m1/a1/page-2","...","selector"] "#btn2-stale" -> "#btn2"
```

### 3. Apply and verify

```bash
npm run dev -- --project <course> --spec <spec.js> --write
```

This edits the model file, deletes and regenerates `test/ui/cypress/e2e`, and reruns the spec. Add `--local` to build against a local `ecc start` server instead of S3.

### 4. Review in the course repo

```bash
cd <course> && git diff test/ui/
```

Keep or discard the change yourself. To raise a PR, ask Claude to use the `course-pr` skill.

### Options and exit codes

| Option | Default | Meaning |
|---|---|---|
| `--project <dir>` | required | Course root. |
| `--spec <file>` | all specs | Spec file name; repeatable. |
| `--write` | off | Apply changes, rebuild, rerun. |
| `--local` | off | Use `ecc --script test:local`. |
| `--model-dir <dir>` | `test/ui` | Where the `model-*.json` files live. |
| `--max-attempts <n>` | 3 | Max Cypress runs. |
| `--max-budget-usd <n>` | 5 | Spend cap. |
| `--model <id>` | `claude-sonnet-5-5` | Claude model. |
| `--run-cmd` / `--build-cmd` | see README | Override the run/build templates (`{spec}` must be absolute). |

| Exit | Meaning |
|---|---|
| 0 | `fixed` or `proposed` |
| 2 | `unfixable` (ambiguous, not a config problem, or limit hit) |
| 3 | Agent finished without an outcome |
| 1 | Usage or preflight error |

### Reading the outcome

- **fixed**: the spec passed after the change. Still review the diff.
- **proposed**: dry-run; the change was recorded, not applied.
- **unfixable**: nothing was written. Typical reasons: the failing selector is in modello support code, the cause is environment/flake/visual, or more than one candidate value fits. The summary says what a human has to decide.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Preflight failed` | `ecc`, `yq` or `modello` missing from `PATH`, or no `build-and-test.yml`. |
| Cypress matches no spec | `--run-cmd` has a relative `{spec}`; modello runs Cypress from its own install dir. |
| Fails on Applitools | No API key; disable it locally (see setup). |
| Fails differently on rerun | Flaky spec (intro modal, random-answer assessments). Confirm it reproduces first. |
| `unfixable`, no selector found | The JUnit stack has no generated-spec frame. Read the selector and step from the Cypress screenshot, then search the generated spec. |
| Whole file reformatted | Writes re-serialize JSON with the original indent. |

## What it can't do yet

- Fix causes outside "set one leaf": selectors wrapped in translation-edit markup, or swapping a random-answer assessment for a custom-code file (both had to be done by hand on m1).
- Locate the failing page/block automatically from real runs.
- `model-map.json` / `model-edges.json` repairs are possible but little exercised.
- Not yet proven end to end on a real failure it could fix in a real checkout; m2-m4 are untested.

See `docs/progress.md` for the full list and `docs/architecture.md` for design decisions.
