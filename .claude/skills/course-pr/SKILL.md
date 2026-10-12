---
name: course-pr
description: Create a branch in an EverFi course repo, commit the model/test config changes with a clear message, push, and open a pull request with a detailed description. Use when the user asks to branch, commit, push or raise a PR for changes made in a course under /Users/jay/everfi/git/courses (for example after the fixer or a manual fix changed test/ui model files).
---

# Course branch, commit and PR

Course repos live in `/Users/jay/everfi/git/courses/<course>` and merge PRs into `develop` (origin `EVERFI-Content/<course>`). This skill is the only sanctioned way to commit in a course repo. Run every git command with `git -C <course-root>`.

## 1. Look before touching anything
- `git -C <root> status -sb` and `git diff` (also `git diff --stat`). Note the current branch and whether it is behind `origin/develop`.
- Decide what belongs in the change. Normally only these, under `test/ui/`: `model-parameters.json`, `model-map.json`, `model-edges.json`, `customizations.json`, `custom-code/*`.
- **Exclude** local-only edits and artifacts: `test/ui/config/cypress.config.js` (for example `APPLITOOLS_ENABLED: false`), `.pnp.js`, `yarn.lock`, anything under `test/ui/cypress/` (gitignored, generated), `node_modules`. If a file is ambiguous, ask the user which to include. Stage files by name; never `git add -A` or `git add .`.
- If nothing relevant is changed, stop and say so.

## 2. Branch
- Ask for the ticket id if the user has not given one (course branches look like `AB#37563-A11y-Blanks` or `ADO-39124`). Name the branch `<ticket>-<short-kebab-description>`, for example `ADO-12345-modello-m1-assessment-selectors`. With no ticket, use `modello-<short-description>` and say so.
- Branch from `develop`: if the user is on `develop` with a dirty tree, `git switch -c <branch>` carries the changes over. If on another branch, ask before switching. Never discard or stash their changes without asking. Never commit on `develop` or `master`.
- Do not `pull`/`reset` the working tree to catch up with origin. If the branch is behind, mention it in the PR notes.

## 3. Commit
- Stage only the agreed files by name, then show `git diff --cached --stat`.
- Message: imperative subject of 72 characters or fewer, conventional style (`fix(test): ...`, `chore(test): ...`), prefixed with the ticket id when there is one. Body (wrapped at about 72) explains why: what failed, how it was diagnosed, what changed. One logical change per commit; split if the diff mixes unrelated fixes.
- End the message with the attribution trailer the session gives for commits.
- Never `--no-verify`, never `--amend` a pushed commit, never commit secrets or `.env*`.

## 4. Confirm before anything leaves the machine
Push and PR creation are outward-facing. Show the user the branch name, the commit message(s), the file list, and the full PR title and body, and wait for a yes. A general "raise a PR" request is not approval of text they have not seen.

## 5. Push and open the PR
```bash
git -C <root> push -u origin <branch>
gh pr create --repo EVERFI-Content/<course> --base develop --head <branch> \
  --title "<title>" --body-file <scratchpad>/pr-body.md
```
- Write the body to a file with the Write tool first and pass `--body-file`. An inline `--body "$(cat <<'EOF' ...)"` heredoc breaks the shell's quoting when the body contains apostrophes or quotes.
- A SAML error (`Resource protected by organization SAML enforcement`) means the `gh` token is not authorized for `EVERFI-Content`. The push still works over SSH. Tell the user to authorize the token (the SSO link in the error, or `gh auth refresh`) or open the PR in the browser at `https://github.com/EVERFI-Content/<course>/pull/new/<branch>` with the saved body.
- Never force-push, never push to `develop`/`master`, never merge or auto-merge. Open as a normal PR unless the user asks for a draft.
- Return the PR URL. If the push or `gh` call fails (SSH key, SAML authorization, no permission), report the exact error and stop; do not try another remote or another way to publish.

## 6. PR description
Title: same shape as the commit subject. Body sections, concrete and honest:

```markdown
## Summary
One or two sentences: what changes and what it fixes.

## Why
The failure that prompted it: spec name, error message (exact), page/block
(for example `m1/a2/page-4`), how it was diagnosed (screenshot, DOM dump,
source or deployed content comparison). Say whether it reproduced every run
or was flaky.

## Changes
- `test/ui/<file>`: what changed and where (page/block keys), one line each.

## Verification
- Commands run (`ecc --script test:build`, `modello run ... --spec ...`),
  environment (s3 / local), and results with durations, for example
  "m1: passed, 4m33s". State what was NOT run (other modules, other
  environments) and that other pages touched by the same edit are untested.

## Risks and notes for reviewers
- Behaviour assumptions (for example "first answer is assumed correct on s3").
- Anything found but not changed (for example a deploy or course issue).
- Local-only edits deliberately left out of this PR.

## Follow-ups
- Remaining failing specs or open questions.
```

Do not claim a test passed unless this session saw it pass. Do not paste tokens, API keys or internal URLs beyond the public course URL.
