#!/usr/bin/env bash
# install.sh — symlink claude-lsp-direct wrappers into ~/.claude/bin/ + ~/.claude/hooks/,
#              merge required permissions + sandbox writes into ~/.claude/settings.json.
# idempotent: re-running does nothing destructive.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE="$HOME/.claude"

BIN_FILES=(metals-direct vue-direct vue-direct-coordinator.js py-direct ts-direct cs-direct java-direct lsp-stdio-proxy.js)
HOOK_FILES=(enforce-lsp-over-grep.py enforce-lsp-workspace-root.py)
TEST_FILES=(test_enforce_lsp_over_grep.py test_enforce_lsp_workspace_root.py)

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] error: %s\n' "$*" >&2; exit 1; }

# ---- preflight ----
command -v jq >/dev/null || die "jq required (brew install jq / apt-get install jq)"
command -v curl >/dev/null || die "curl required"
command -v node >/dev/null || die "node required (>=18)"
command -v python3 >/dev/null || die "python3 required (>=3.9)"

[ -d "$CLAUDE" ] || {
  log "~/.claude not found — are you using Claude Code?"
  log "manual alternative: symlink $REPO/bin/* into any dir on your PATH"
  exit 1
}

mkdir -p "$CLAUDE/bin" "$CLAUDE/hooks" "$CLAUDE/hooks/tests"

# ---- symlink bin/ ----
log "symlinking bin/"
for f in "${BIN_FILES[@]}"; do
  src="$REPO/bin/$f"
  dst="$CLAUDE/bin/$f"
  [ -f "$src" ] || die "missing repo file: $src"
  # if already a symlink to our file → skip; if a different file → back up
  if [ -L "$dst" ]; then
    current="$(readlink "$dst")"
    [ "$current" = "$src" ] && { log "  $f already linked"; continue; }
    log "  relinking $f (was $current)"
    rm "$dst"
  elif [ -f "$dst" ]; then
    mv "$dst" "$dst.bak-$(date +%s)"
    log "  backed up existing $f → $dst.bak-<ts>"
  fi
  ln -s "$src" "$dst"
  log "  linked $f"
done

# ---- symlink hooks/ (optional, only if user has hook-based LSP enforcement) ----
log "symlinking hooks/"
for f in "${HOOK_FILES[@]}"; do
  src="$REPO/hooks/$f"
  dst="$CLAUDE/hooks/$f"
  [ -f "$src" ] || die "missing repo file: $src"
  if [ -L "$dst" ]; then
    current="$(readlink "$dst")"
    [ "$current" = "$src" ] && { log "  $f already linked"; continue; }
    rm "$dst"
  elif [ -f "$dst" ]; then
    mv "$dst" "$dst.bak-$(date +%s)"
  fi
  ln -s "$src" "$dst"
  log "  linked $f"
done

log "symlinking hooks/tests/"
for f in "${TEST_FILES[@]}"; do
  src="$REPO/hooks/tests/$f"
  dst="$CLAUDE/hooks/tests/$f"
  [ -f "$src" ] || die "missing repo file: $src"
  if [ -L "$dst" ]; then
    current="$(readlink "$dst")"
    [ "$current" = "$src" ] && { log "  $f already linked"; continue; }
    rm "$dst"
  elif [ -f "$dst" ]; then
    mv "$dst" "$dst.bak-$(date +%s)"
  fi
  ln -s "$src" "$dst"
  log "  linked $f"
done

# ---- merge settings.json ----
SETTINGS="$CLAUDE/settings.json"
if [ -f "$SETTINGS" ]; then
  log "merging permissions + sandbox into $SETTINGS"
  cp "$SETTINGS" "$SETTINGS.bak-$(date +%s)"
  TMP="$(mktemp)"
  jq '
    .permissions.allow = ((.permissions.allow // []) + [
      "Bash(~/.claude/bin/metals-direct *)",
      "Bash(~/.claude/bin/vue-direct *)",
      "Bash(~/.claude/bin/py-direct *)",
      "Bash(~/.claude/bin/ts-direct *)",
      "Bash(~/.claude/bin/cs-direct *)"
    ] | unique)
    | .sandbox.filesystem.allowWrite = ((.sandbox.filesystem.allowWrite // []) + [
      "~/.cache/metals-direct/**",
      "~/.cache/vue-direct/**",
      "~/.cache/py-direct/**",
      "~/.cache/ts-direct/**",
      "~/.cache/cs-direct/**"
    ] | unique)
  ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
  log "  merged (backup at $SETTINGS.bak-<ts>)"
else
  log "no ~/.claude/settings.json found — skipping merge"
fi

# ---- next steps ----
cat <<'DONE'

[install] done.

next steps:
  1. install language server(s) you want to use:
       npm i -g pyright                                      # python
       npm i -g typescript-language-server typescript        # typescript
       npm i -g @vue/language-server@3.2.6 \
                @vue/typescript-plugin@3.2.6 typescript@5.9.3 # vue
       dotnet tool install -g csharp-ls                      # csharp
       brew install metals                                   # scala
  2. verify:
       ./scripts/verify.sh
  3. read docs/per-language/<lang>.md for each language you use
DONE
