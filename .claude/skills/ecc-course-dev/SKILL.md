---
name: ecc-course-dev
description: How to set up and use ECC (EverFi Content Compiler) to build, serve and run EverFi courses, including Furnace (v6) vs legacy (v4/v5 bower) courses. Use when asked to run/start/build a course, set up ecc or Furnace, symlink the SDK/components, or fix an ecc build/install error.
---

# ECC course development

Source of truth: `~/.ecc/readme.md` (installed with ecc). Re-read it if something here looks stale; `ecc --help` lists every command and flag.

## Install and prerequisites
- Install: `curl -o- https://everfi.github.io/EverFi-Content-Compiler/install.sh | bash` (binary ends up at `~/.local/bin/ecc`, support files in `~/.ecc` and `~/.local/etc/ecc`).
- `yq` is required for the test scripts: `brew install yq`.
- A GitHub token authorized for EverFI and EverFi-Content SSO (scopes at least `repo`, `packages:read`) exported as `GITHUB_TOKEN` and/or `PERSONAL_GITHUB_TOKEN` in `~/.zshrc`.
- Furnace (v6) courses: `~/.yarnrc.yml` with an `npmRegistries` entry for `https://npm.pkg.github.com` using `${PERSONAL_GITHUB_TOKEN}`.
- Legacy v4/v5 bower courses: `~/.npmrc` with the literal token (no variables) for `npm.pkg.github.com` and `@everfi:registry`.
- Without these, installs fail. Observed: `ecc build` in a course with no `node_modules` fails with "Could not find ContentPartnerAPI or components in node_modules ... did the yarn or bower installation fail?". Run the install (`yarn`) first; this needs the tokens above.

## Everyday commands (run in the course root)
- `ecc start`: build, then watch and serve (default port 9000). `ecc start:all course-one,course-two` for several.
- `ecc build`: build only. `ecc build --split`: split modules / async components.
- `ecc --watch --serve`: watch and serve without building.
- `ecc start --ssl`: HTTPS at `https://course.fidev.net:{port}` for platform/foundry testing.
- `ecc --build-production --course` (add `--split`): production build, as on CI.
- Single tasks: `ecc locales`, `ecc json scripts styles`, etc. Several can run at once.
- `ecc --script <name>` runs a named npm script from ECC (used for the test scripts and `bower:install` / `bower:link`).

## Furnace (v6) courses
- Create `~/.ecc-settings`:
  ```ini
  [settings]
  sdk=<HOME>/<path to Furnace>/packages/everfi-sdk
  components=<HOME>/<path to Furnace>/packages/components
  port = 3000   ; default 9000
  scan = true   ; default true
  ```
- In the course: `ecc symlink components` and/or `ecc symlink sdk`; then `ecc start` rebuilds when Furnace changes. ECC does not refresh the browser for you.
- Regression-test the current Furnace by pushing any branch named `test/...` (documented in the ECC readme).

## Legacy (v4/v5 bower) courses
- All bower installs go through ECC: `ecc --script bower:install` (needs the tokens and `.npmrc` above).
- `ecc start` runs `ecc --dev legacy-course build` under the hood.
- `ecc symlink` does not work here. SDK: run `bower link` in the old ContentPartnerAPI repo, then `ecc --script bower:link everfi-sdk` in the course. Components: `npm link` in the components project, then `npm link @everfi/components` in the course.

## Output the tests depend on
`ecc build` compiles the course into `public/` (git-ignored), including `public/content/module-content.json` and `modules.json`. `modello build` reads those. If they are missing, build the course first. They can already exist from an earlier build; check before rebuilding.

For generating and running Cypress tests, use the `modello-tests` skill.
