#!/usr/bin/env bash
# install.sh — symlink claude-lsp-direct wrappers into ~/.claude/bin/ + ~/.claude/hooks/,
#              merge required permissions + sandbox writes into ~/.claude/settings.json.
# idempotent: re-running does nothing destructive.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# CLAUDE defaults to ~/.claude; override for dry-runs (CLAUDE=/tmp/foo install.sh).
CLAUDE="${CLAUDE:-$HOME/.claude}"

# bin files (wrappers + coordinators + shared harness modules)
BIN_FILES=(
  # LSP wrappers
  metals-direct vue-direct py-direct ts-direct cs-direct java-direct
  # LSP coordinators (shim entrypoints)
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
# adapters dir symlinked as a whole (one entry per adapter would balloon; the dir is stable)
BIN_DIRS=(adapters)
HOOK_FILES=(enforce-lsp-over-grep.py enforce-lsp-workspace-root.py prewarm-direct-wrappers.py)
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

# ---- symlink bin/ directories (adapters/) ----
for d in "${BIN_DIRS[@]}"; do
  src="$REPO/bin/$d"
  dst="$CLAUDE/bin/$d"
  [ -d "$src" ] || die "missing repo dir: $src"
  if [ -L "$dst" ]; then
    current="$(readlink "$dst")"
    [ "$current" = "$src" ] && { log "  $d/ already linked"; continue; }
    rm "$dst"
  elif [ -e "$dst" ]; then
    mv "$dst" "$dst.bak-$(date +%s)"
    log "  backed up existing $d → $dst.bak-<ts>"
  fi
  ln -s "$src" "$dst"
  log "  linked $d/"
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
  TMP="$(mktemp "${TMPDIR:-/tmp}/install.XXXXXX")"
  jq '
    .permissions.allow = ((.permissions.allow // []) + [
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
    ] | unique)
    | .sandbox.filesystem.allowWrite = ((.sandbox.filesystem.allowWrite // []) + [
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
    ] | unique)
    | .hooks.SessionStart = (
        # append only if our command isnt already registered under any existing entrys hooks array.
        # Claude Code hook schema: each SessionStart entry is {matcher?, hooks: [{type, command, async?}, ...]}
        if ((.hooks.SessionStart // []) | map(.hooks // []) | flatten | map(.command) | index("python3 ~/.claude/hooks/prewarm-direct-wrappers.py")) then
          (.hooks.SessionStart // [])
        else
          (.hooks.SessionStart // []) + [{
            "hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/prewarm-direct-wrappers.py"}]
          }]
        end
      )
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
       brew install jdtls                                    # java
  2. (optional) install build tools / formatters for the opt-in wrappers:
       brew install sbt                                      # sbt-direct
       # dotnet-direct — already have dotnet from csharp-ls step
       npm i -g prettier eslint                              # prettier-direct, eslint-direct
       # scalafmt-direct: native binary (arch-specific — picks the right asset from
       #   https://github.com/scalameta/scalafmt/releases/latest)
       #   macOS arm64:
       #     curl -L -o /tmp/sf.zip https://github.com/scalameta/scalafmt/releases/download/v3.11.0/scalafmt-aarch64-apple-darwin.zip \
       #       && unzip -o /tmp/sf.zip -d ~/.local/bin && chmod +x ~/.local/bin/scalafmt
       #   macOS x86_64: scalafmt-x86_64-apple-darwin.zip
       #   Linux:        scalafmt-linux-glibc  (or scalafmt-aarch64-pc-linux.zip on arm)
       #   alternative:  cs install scalafmt  (requires coursier)
  3. verify:
       ./scripts/verify.sh
  4. read docs/per-language/<lang>.md for each language you use
DONE
