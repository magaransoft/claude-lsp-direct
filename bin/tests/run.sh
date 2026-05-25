#!/usr/bin/env bash
# bin/tests/run.sh — collect + run all bin-side JS tests using node:test built-in.
# usage: ./bin/tests/run.sh [pattern]
set -euo pipefail
cd "$(dirname "$0")"
pattern="${1:-*.mjs}"
fail=0
for t in $pattern; do
  [ -f "$t" ] || continue
  echo "=== $t ==="
  if node --test "$t"; then
    :
  else
    fail=$((fail + 1))
  fi
done
if [ "$fail" -gt 0 ]; then
  echo "FAIL: $fail test file(s)"
  exit 1
fi
echo "OK: all tests passed"
