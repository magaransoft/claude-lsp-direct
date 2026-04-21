# Changelog

All notable changes to this project will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [1.0.0] — 2026-04-21

### Added
- `bin/metals-direct` — Scala via metals-mcp over HTTP (17 semantic tools)
- `bin/vue-direct` + `bin/vue-direct-coordinator.js` — Vue LS v3 hybrid bridge (Vue LS + tsserver + `@vue/typescript-plugin`)
- `bin/py-direct` — pyright-langserver proxy
- `bin/ts-direct` — typescript-language-server proxy
- `bin/cs-direct` — csharp-ls proxy; fixes rootUri-at-init binding via per-workspace spawn
- `bin/lsp-stdio-proxy.js` — shared generic coordinator for standalone stdio LSPs
- `hooks/enforce-lsp-over-grep.py` — Claude Code hook redirecting source-code grep to direct wrappers
- `hooks/enforce-lsp-workspace-root.py` — C# workspace root enforcement; bypasses when cs-direct is installed
- `scripts/install.sh`, `scripts/uninstall.sh`, `scripts/verify.sh`
- `docs/convention.md`, `docs/architecture.md`, `docs/troubleshooting.md`, and per-language pages for all 5 supported languages
- `fixtures/` — minimal sample projects for CI + local verification
- GitHub Actions CI on macOS + Ubuntu

[1.0.0]: https://github.com/CHANGE-ME/claude-lsp-direct/releases/tag/v1.0.0
