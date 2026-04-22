#!/usr/bin/env bash
# verify.sh — runs a functional probe per available wrapper; skips when the
# language server isn't installed. Prints cold + warm timing as observation.

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$REPO/fixtures"

probe() {
  local lang="$1" wrapper="$2" binary="$3" fixture_dir="$4" target_file="$5"
  local uri="file://$fixture_dir/$target_file"
  printf '[%s] ' "$lang"
  if ! command -v "$binary" >/dev/null; then
    printf 'SKIP (%s not on PATH)\n' "$binary"
    return 0
  fi
  if [ ! -x "$REPO/bin/$wrapper" ]; then
    printf 'FAIL (wrapper missing: %s)\n' "$REPO/bin/$wrapper"
    return 1
  fi

  local t0 t1 cold warm
  t0=$(python3 -c 'import time;print(time.time())')
  "$REPO/bin/$wrapper" call textDocument/documentSymbol \
    "{\"textDocument\":{\"uri\":\"$uri\"}}" "$fixture_dir" >/dev/null 2>&1 || {
    printf 'FAIL (cold call errored)\n'
    return 1
  }
  t1=$(python3 -c 'import time;print(time.time())')
  cold=$(python3 -c "print(round($t1-$t0,3))")

  t0=$(python3 -c 'import time;print(time.time())')
  "$REPO/bin/$wrapper" call textDocument/documentSymbol \
    "{\"textDocument\":{\"uri\":\"$uri\"}}" "$fixture_dir" >/dev/null 2>&1
  t1=$(python3 -c 'import time;print(time.time())')
  warm=$(python3 -c "print(round($t1-$t0,3))")

  printf 'OK  cold=%ss warm=%ss\n' "$cold" "$warm"

  "$REPO/bin/$wrapper" stop "$fixture_dir" >/dev/null 2>&1 || true
}

echo "claude-lsp-direct verify — per-wrapper functional probe"
echo ""

probe python     py-direct      pyright-langserver         "$FIXTURES/python"     hello.py
probe typescript ts-direct      typescript-language-server "$FIXTURES/typescript" hello.ts
probe csharp     cs-direct      csharp-ls                  "$FIXTURES/csharp"     hello.cs
probe vue        vue-direct     vue-language-server        "$FIXTURES/vue"        hello.vue
probe java       java-direct    jdtls                      "$FIXTURES/java"       src/main/java/com/example/Hello.java
# scala skipped here — metals-mcp fixture requires bloop import, non-trivial
command -v metals-mcp >/dev/null && echo "[scala]  metals-mcp detected but skipped in verify (needs sbt project)" \
                                 || echo "[scala]  SKIP (metals-mcp not on PATH)"

echo ""
echo "done."
