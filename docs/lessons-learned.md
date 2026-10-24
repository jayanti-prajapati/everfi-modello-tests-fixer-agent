# Lessons learned from real runs

Problems found while running the fixer against the real `digital-banking` checkout, and how the tool handles each one now. None of these showed up in unit tests.

| Problem | Cause | Handled by |
|---|---|---|
| Every Cypress run failed with `MODULE_NOT_FOUND` | VS Code sets `ELECTRON_RUN_AS_NODE=1`; Cypress's Electron then starts as plain Node | `runShell` removes the variable for child processes; preflight runs `cypress verify` |
| `ecc build` failed: "Could not find ContentPartnerAPI or components" | `.pnp.js` (Yarn Plug'n'Play) left over from a checkout in another folder pointed at the wrong cache path | Install stage runs `yarn install --frozen-lockfile` first |
| Cypress found no spec in a temporary course copy | On macOS `/var` is a link to `/private/var`; Cypress resolved one path and was given the other | Work happens in the real course folder by default; `--isolate` copies use resolved paths |
| "branch already exists" on a rerun | Minute-based branch names, plus a branch left behind by Ctrl-C | Seconds in the name, a `-2` suffix if taken, leftover empty branches removed, Ctrl-C restores your branch |
| Fix branches tracked `origin/develop` | `git switch -c x origin/develop` sets develop as upstream | Branches are created with `--no-track`; `git push -u` sets their own upstream |
| $0.48 spent on a run that could never pass | Agents were started on an environment failure | Environment triage and `cypress verify` run before any agent |
| `modello run` matched no spec | It starts Cypress from its own install directory, so relative paths resolve there | The spec path is always absolute |
| The agent created a stray root-level key | It left out the `&common` section of the key path | Changes to keys that don't exist are rejected with a hint showing where the key lives |
| A recipe could pick a value that only existed as `data-id` | The attribute search treated `data-id` as `id` | The search requires the exact attribute name |

Still open:
- The JUnit stack has no generated-spec frame, so the failing page/block is found from the selector in the error message.
- Specs are generated from compiled content that can be older than the deployed course.
- A real module run takes 1–6 minutes, and each rebuild regenerates every spec.
