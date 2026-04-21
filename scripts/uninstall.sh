#!/usr/bin/env bash
# uninstall.sh — reverse of install.sh. Removes symlinks pointing into this repo;
# strips our entries from ~/.claude/settings.json. Leaves ~/.cache/<lang>-direct alone.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE="$HOME/.claude"

BIN_FILES=(metals-direct vue-direct vue-direct-coordinator.js py-direct ts-direct cs-direct lsp-stdio-proxy.js)
HOOK_FILES=(enforce-lsp-over-grep.py enforce-lsp-workspace-root.py)
TEST_FILES=(test_enforce_lsp_over_grep.py test_enforce_lsp_workspace_root.py)

log() { printf '[uninstall] %s\n' "$*"; }

remove_symlink_into_repo() {
  local target="$1"
  if [ -L "$target" ]; then
    local dest; dest="$(readlink "$target")"
    case "$dest" in
      "$REPO"/*) rm "$target"; log "  removed $target";;
      *) log "  kept $target (links elsewhere: $dest)";;
    esac
  fi
}

log "removing bin/ symlinks"
for f in "${BIN_FILES[@]}"; do remove_symlink_into_repo "$CLAUDE/bin/$f"; done

log "removing hooks/ symlinks"
for f in "${HOOK_FILES[@]}"; do remove_symlink_into_repo "$CLAUDE/hooks/$f"; done
for f in "${TEST_FILES[@]}"; do remove_symlink_into_repo "$CLAUDE/hooks/tests/$f"; done

SETTINGS="$CLAUDE/settings.json"
if [ -f "$SETTINGS" ] && command -v jq >/dev/null; then
  log "stripping our entries from $SETTINGS"
  cp "$SETTINGS" "$SETTINGS.bak-uninstall-$(date +%s)"
  TMP="$(mktemp)"
  jq '
    .permissions.allow = ((.permissions.allow // []) - [
      "Bash(~/.claude/bin/metals-direct *)",
      "Bash(~/.claude/bin/vue-direct *)",
      "Bash(~/.claude/bin/py-direct *)",
      "Bash(~/.claude/bin/ts-direct *)",
      "Bash(~/.claude/bin/cs-direct *)"
    ])
    | .sandbox.filesystem.allowWrite = ((.sandbox.filesystem.allowWrite // []) - [
      "~/.cache/metals-direct/**",
      "~/.cache/vue-direct/**",
      "~/.cache/py-direct/**",
      "~/.cache/ts-direct/**",
      "~/.cache/cs-direct/**"
    ])
  ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
fi

log "done. state dirs at ~/.cache/<lang>-direct/ left alone (user data)."
