#!/usr/bin/env bash
# measure-lsp-cold-start.sh — per-wrapper cold-start baseline (real-data probe, slice-0 of orphan-teardown pitch)
# Usage: ./scripts/measure-lsp-cold-start.sh [--out docs/cold-start-baseline.tsv]
# For each wrapper, kills any active coordinator for its fixture workspace, then measures spawn → first-response latency.
# Idle thresholds in tool-server-proxy.js should respect p99 + 2× buffer per this baseline.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-${REPO_ROOT}/docs/cold-start-baseline.tsv}"
ITERATIONS="${ITERATIONS:-3}"

mkdir -p "$(dirname "$OUT")"
printf "wrapper\tworkspace\tcold_ms_p50\tcold_ms_p99\tn\ttimestamp\n" > "$OUT"

# wrapper → (fixture-rel-path, probe-method, probe-args-json)
# probe-method MUST be a low-cost query that forces backend full-init.
# documentSymbol against a known file is more deterministic than workspace/symbol
# (the latter may return empty for fresh fixtures where the symbol doesn't exist).
# scala-direct uses metals-mcp tool names (NOT LSP method names) — list-modules is the
# lightest tool that exercises bloop/metals connectivity post-init.
WRAPPERS=(
  "py-direct|fixtures/python|workspace/symbol|{\"query\":\"main\"}"
  "ts-direct|fixtures/typescript|textDocument/documentSymbol|{\"textDocument\":{\"uri\":\"file://${REPO_ROOT}/fixtures/typescript/hello.ts\"}}"
  "java-direct|fixtures/java|workspace/symbol|{\"query\":\"Main\"}"
  "cs-direct|fixtures/csharp|workspace/symbol|{\"query\":\"Main\"}"
  "cs-roslyn-direct|fixtures/csharp|textDocument/documentSymbol|{\"textDocument\":{\"uri\":\"file://${REPO_ROOT}/fixtures/csharp/hello.cs\"}}"
  "vue-direct|fixtures/vue|textDocument/documentSymbol|{\"textDocument\":{\"uri\":\"file://${REPO_ROOT}/fixtures/vue/src/App.vue\"}}"
  "scala-direct|fixtures/scala-sbt|list-modules|{}"
)

percentile() {
  # $1 = sorted asc CSV of ms values, $2 = percentile (50/99/etc)
  awk -F, -v p="$2" 'BEGIN{n=0} {for(i=1;i<=NF;i++){a[++n]=$i}} END{
    if(n==0){print 0; exit}
    idx=(p/100)*(n-1); lo=int(idx); hi=lo+1; frac=idx-lo;
    if(hi>=n) hi=n-1;
    printf "%.0f", a[lo+1] + frac*(a[hi+1]-a[lo+1])
  }' <<<"$1"
}

for entry in "${WRAPPERS[@]}"; do
  IFS='|' read -r wrapper fixture method params <<<"$entry"
  ws="${REPO_ROOT}/${fixture}"
  if [ ! -d "$ws" ]; then
    echo "skip $wrapper: fixture missing at $ws" >&2
    continue
  fi
  bin="${HOME}/.claude/bin/${wrapper}"
  if [ ! -x "$bin" ]; then
    echo "skip $wrapper: wrapper missing at $bin" >&2
    continue
  fi

  echo "=== $wrapper × $ITERATIONS ==="
  samples=()
  for i in $(seq 1 "$ITERATIONS"); do
    # kill any active coordinator for this workspace before each iteration
    if [ -x "${HOME}/.claude/bin/lsp-direct-reap" ]; then
      "${HOME}/.claude/bin/lsp-direct-reap" --under "$ws" > /dev/null 2>&1 || true
    fi
    sleep 1
    t0=$(python3 -c 'import time; print(int(time.time()*1000))')
    if "$bin" call "$method" "$params" "$ws" > /dev/null 2>&1; then
      t1=$(python3 -c 'import time; print(int(time.time()*1000))')
      ms=$((t1 - t0))
      samples+=("$ms")
      echo "  iter $i: ${ms}ms"
    else
      echo "  iter $i: FAIL"
    fi
  done

  if [ ${#samples[@]} -gt 0 ]; then
    # BSD paste needs explicit -s -d ',' (GNU's `paste -sd,` is unsupported on macOS)
    sorted=$(IFS=$'\n'; echo "${samples[*]}" | sort -n | paste -s -d ',' -)
    p50=$(percentile "$sorted" 50)
    p99=$(percentile "$sorted" 99)
    printf "%s\t%s\t%s\t%s\t%d\t%s\n" "$wrapper" "$ws" "$p50" "$p99" "${#samples[@]}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"
  fi
done

echo ""
echo "=== baseline ==="
column -t -s $'\t' "$OUT"
echo ""
echo "wrote: $OUT"
echo "recommended idle threshold per ADR-001 = max(p99 × 2, 10min); update LSP_DIRECT_IDLE_MS if defaults drift > 2× from these p99 numbers"
