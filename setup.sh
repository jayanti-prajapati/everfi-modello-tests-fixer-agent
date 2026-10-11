#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
[ -d .git ] || git init -b main
git add -A
git commit -m "Initial Claude Code project skeleton" || true
if command -v gh >/dev/null 2>&1; then
  read -r -p "Create a private GitHub repo with gh? [y/N] " ans
  if [[ "$ans" =~ ^[Yy]$ ]]; then
    gh repo create "$(basename "$PWD")" --private --source=. --push
  fi
else
  echo "Tip: brew install gh && gh auth login, then re-run to create the GitHub repo."
fi
echo "Done. Run: claude"
