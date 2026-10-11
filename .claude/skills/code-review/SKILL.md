---
name: code-review
description: Review the current git diff for bugs, security issues, missing tests, and unclear code. Use when the user asks for a review or before opening a PR.
---

# Code review

1. Run `git diff` (and `git diff --staged`) to see the changes.
2. Check for: correctness bugs, edge cases, security issues (secrets, injection, unsafe input), missing or weak tests, unclear naming.
3. Report findings grouped as **Must fix**, **Should fix**, **Nit**. Reference file and line.
4. If nothing is wrong, say so briefly. Do not invent issues.
5. Do not modify code unless asked.
