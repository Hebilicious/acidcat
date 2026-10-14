#!/usr/bin/env bash
# Checks that each line on stdin is a semantic title: `type(scope): subject`.
# A `!` after the scope marks a breaking change: `feat(catalog)!: drop version 1`.
set -euo pipefail

pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)\([a-z0-9][a-z0-9./-]*\)!?: [^ ].*$'
status=0

while IFS= read -r title; do
  if [[ "$title" =~ $pattern ]]; then
    echo "ok:   $title"
  else
    echo "fail: $title"
    status=1
  fi
done

if [ "$status" -ne 0 ]; then
  echo
  echo "Each title must be 'type(scope): subject', for example 'fix(catalog): reject duplicate ids'."
  echo "Types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert."
fi
exit "$status"
