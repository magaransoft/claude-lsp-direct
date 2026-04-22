#!/usr/bin/env bash
# uninstall.sh — reverse of install.sh. Removes symlinks pointing into this repo;
# strips our entries from ~/.claude/settings.json. Leaves ~/.cache/<tool>-direct alone.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# CLAUDE defaults to ~/.claude; override for dry-runs (CLAUDE=/tmp/foo uninstall.sh).
CLAUDE="${CLAUDE:-$HOME/.claude}"

BIN_FILES=(
  # LSP wrappers
  metals-direct vue-direct py-direct ts-direct cs-direct java-direct
  # LSP coordinators
  vue-direct-coordinator.js lsp-stdio-proxy.js
  # Opt-in build-tool wrappers + coordinators
  sbt-direct sbt-direct-coordinator.js
  dotnet-direct dotnet-direct-coordinator.js
  scalafmt-direct scalafmt-direct-coordinator.js
  # Opt-in formatter daemons
  prettier-direct prettier-direct-daemon.js
  eslint-direct eslint-direct-daemon.js
  # Shared harness + coordinator modules
  tool-harness.js tool-server-proxy.js node-formatter-daemon.js
)
BIN_DIRS=(adapters)
HOOK_FILES=(enforce-lsp-over-grep.py enforce-lsp-workspace-root.py prewarm-direct-wrappers.py)
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
for d in "${BIN_DIRS[@]}"; do remove_symlink_into_repo "$CLAUDE/bin/$d"; done

log "removing hooks/ symlinks"
for f in "${HOOK_FILES[@]}"; do remove_symlink_into_repo "$CLAUDE/hooks/$f"; done
for f in "${TEST_FILES[@]}"; do remove_symlink_into_repo "$CLAUDE/hooks/tests/$f"; done

SETTINGS="$CLAUDE/settings.json"
if [ -f "$SETTINGS" ] && command -v jq >/dev/null; then
  log "stripping our entries from $SETTINGS"
  cp "$SETTINGS" "$SETTINGS.bak-uninstall-$(date +%s)"
  TMP="$(mktemp "${TMPDIR:-/tmp}/uninstall.XXXXXX")"
  jq '
    .permissions.allow = ((.permissions.allow // []) - [
      "Bash(~/.claude/bin/metals-direct *)",
      "Bash(~/.claude/bin/vue-direct *)",
      "Bash(~/.claude/bin/py-direct *)",
      "Bash(~/.claude/bin/ts-direct *)",
      "Bash(~/.claude/bin/cs-direct *)",
      "Bash(~/.claude/bin/java-direct *)",
      "Bash(~/.claude/bin/sbt-direct *)",
      "Bash(~/.claude/bin/dotnet-direct *)",
      "Bash(~/.claude/bin/prettier-direct *)",
      "Bash(~/.claude/bin/eslint-direct *)",
      "Bash(~/.claude/bin/scalafmt-direct *)"
    ])
    | .sandbox.filesystem.allowWrite = ((.sandbox.filesystem.allowWrite // []) - [
      "~/.cache/metals-direct/**",
      "~/.cache/vue-direct/**",
      "~/.cache/py-direct/**",
      "~/.cache/ts-direct/**",
      "~/.cache/cs-direct/**",
      "~/.cache/java-direct/**",
      "~/.cache/sbt-direct/**",
      "~/.cache/dotnet-direct/**",
      "~/.cache/prettier-direct/**",
      "~/.cache/eslint-direct/**",
      "~/.cache/scalafmt-direct/**",
      "~/.eclipse/**",
      "/private/var/folders/**/.sbt/**",
      "~/.sbt/**",
      "~/.ivy2/**",
      "~/.coursier/**",
      "/private/var/folders/**/.scala-build/**"
    ])
    | .hooks.SessionStart = (
        # Remove any SessionStart entry whose hooks[].command references our prewarm script.
        # Also drop entries that become empty after the filter.
        (.hooks.SessionStart // [])
        | map(
            if type == "object" and has("hooks") then
              .hooks |= map(select(.command != "python3 ~/.claude/hooks/prewarm-direct-wrappers.py"))
            else . end
          )
        | map(select(type != "object" or (.hooks // []) != []))
      )
  ' "$SETTINGS" > "$TMP" && mv "$TMP" "$SETTINGS"
fi

log "done. state dirs at ~/.cache/<tool>-direct/ left alone (user data)."
