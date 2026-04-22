#!/usr/bin/env bash
# capture-baseline.sh — runs verify.sh --json and writes one baseline file
# per OK wrapper to fixtures/baselines/<wrapper>.json. Idempotent; overwrites
# existing baselines. Run before starting a refactor, then `verify.sh
# --diff-baselines` after each wave to detect regressions.
#
# Wrappers that SKIP (backing tool absent) are reported but no baseline
# is written — baselines only capture tools this machine can actually exercise.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINES="$REPO/fixtures/baselines"
mkdir -p "$BASELINES"

tmp=$(mktemp "${TMPDIR:-/tmp}/capture-baseline.XXXXXX")
trap 'rm -f "$tmp"' EXIT

"$REPO/scripts/verify.sh" --json >"$tmp"

ok=0
skipped=0
while IFS= read -r line; do
  [ -z "$line" ] && continue
  wrapper=$(echo "$line" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("wrapper",""))')
  status=$(echo "$line" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("status",""))')
  [ -z "$wrapper" ] && continue
  if [ "$status" = "OK" ]; then
    python3 -c "import json,sys; json.dump(json.loads(sys.argv[1]), open(sys.argv[2],'w'), indent=2, sort_keys=True); open(sys.argv[2],'a').write('\n')" "$line" "$BASELINES/$wrapper.json"
    echo "[$wrapper] baseline captured → fixtures/baselines/$wrapper.json"
    ok=$((ok + 1))
  else
    echo "[$wrapper] $status — not baselined"
    skipped=$((skipped + 1))
  fi
done <"$tmp"

echo ""
echo "captured=$ok skipped=$skipped"
