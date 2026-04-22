# Changelog

All notable changes to this project will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [1.1.0] — 2026-04-21

### Added
- `bin/java-direct` — Java via jdtls (Eclipse JDT.LS) proxy; per-workspace `-data` dir under wrapper state hash; 180s start timeout for JVM + Equinox boot
- `fixtures/java/` — minimal Maven project (`pom.xml` + `src/main/java/com/example/Hello.java`) for CI + verify
- `docs/per-language/java.md` — install (`brew install jdtls`), workspace markers, op surface, jdtls quirks (build-job latency, `~/.eclipse` write requirement)
- `docs/convention.md` — java row added to language table
- `hooks/enforce-lsp-over-grep.py` — extended `CODE_EXT`/`EXT_LANG`/`RG_TYPE_LANG`/`POS_CODE_FILE_RE`/`LANG_DIRECT_WRAPPER`/`PLUGIN_BINARY_MAP` to cover `.java`; reuses python/typescript/csharp suggestion branch
- `hooks/tests/test_enforce_lsp_over_grep.py` — java cases for bash grep/rg/find, native `Grep` tool (type/glob/path), positional code-file detection
- `scripts/install.sh` + `scripts/verify.sh` — `java-direct` symlinked + java fixture probe added
- `.github/workflows/ci.yml` — `brew install jdtls` step on macos-latest (linux skipped — no first-class jdtls package)
- `README.md` — java row in benchmarks table + per-language link list

### Verified
- functional probe: `documentSymbol` (2 symbols), `workspace/symbol "Hello"` (1 result after build settle), `references` on `greet` method (2 refs)
- timing: cold start 2.16s, cold call 907ms, warm avg ~85ms (`documentSymbol`/`workspace/symbol`/`references`)
- hook tests: 97/97 pass

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

[1.1.0]: https://github.com/CHANGE-ME/claude-lsp-direct/releases/tag/v1.1.0
[1.0.0]: https://github.com/CHANGE-ME/claude-lsp-direct/releases/tag/v1.0.0
