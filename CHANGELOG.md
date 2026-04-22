# Changelog

All notable changes to this project will be documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [1.2.0] — 2026-04-22

### Added
- `bin/adapters/sbt-thin-client.js` — persistent-JVM sbt adapter. Activated via `SBT_DIRECT_MODE=thin-client` or `--mode thin-client`. Coordinator spawns `sbt` in server mode once per workspace and proxies each `/call` through `sbt --client "<task>"`; warm calls land in 200-500ms vs 20-40s one-shot cold. Adoption: attaches to an externally-running `sbt shell` if `target/active.json` + live socket detected. Requires `install.sh` allowlist for ipcsocket paths (pre-merged into `sandbox.filesystem.allowWrite`).
- `hooks/prewarm-direct-wrappers.py` — SessionStart hook. Iterates `~/.cache/*-direct/*/` slots, probes each with `GET /health`, fires `<wrapper>-direct start <workspace>` in the background for any dead slot. First `call` in a new session is warm.
- `install.sh` — wires the prewarm hook into `~/.claude/settings.json`'s `hooks.SessionStart` (idempotent, `unique_by(.command)`). `uninstall.sh` removes it symmetrically.
- `scripts/verify.sh VERIFY_STRICT_SHA=1` — env-gated strict mode for CI. Default (unset/0) treats sha256-body mismatch as a warning so downstream users on different pyright/tsserver/csharp-ls versions don't fail the gate; structural-shape match (top_level + total_nodes) remains hard either way. CI workflow exports `VERIFY_STRICT_SHA=1`.
- `bin/tool-harness.js` — shared coordinator primitives: `resolveWorkspace`, `stateDir`, `freePort`, `serveHttp`, `invalidationLoop`, `callLog`, plus `framing` readers/writers (contentLength, jsonLine, tsserverMixed) and a `jsonRpcClient` correlation helper
- `bin/tool-server-proxy.js` — external-child coordinator; adapters declare `children[]`, `init`, `onChildMessage`, `call`, `triggers`
- `bin/node-formatter-daemon.js` — in-process Node-library coordinator (sibling of tool-server-proxy); adapters declare `preload(workspace)` + `call(req, {pkg, state})`
- `bin/adapters/lsp-stdio.js` — LSP adapter (py/ts/cs/java); extracted from monolithic `lsp-stdio-proxy.js`
- `bin/adapters/vue-hybrid.js` — Vue LS v3 + tsserver hybrid adapter; extracted from `vue-direct-coordinator.js`
- `bin/adapters/sbt-oneshot.js` + `bin/sbt-direct` + `bin/sbt-direct-coordinator.js` + `fixtures/scala-sbt/` — per-call sbt coordinator (`task`, `reload`, `version`)
- `bin/adapters/dotnet-cli.js` + `bin/dotnet-direct` + `bin/dotnet-direct-coordinator.js` + `fixtures/dotnet-csproj/` — per-call dotnet coordinator (11 methods: build/test/restore/publish/run/pack/…); MSBuild build-server handles warm persistence transparently
- `bin/adapters/prettier.js` + `bin/prettier-direct` + `bin/prettier-direct-daemon.js` + `fixtures/node-formatter/` — in-process prettier daemon (`format`, `check`, `format-file`, `resolve-config`, `version`)
- `bin/adapters/eslint.js` + `bin/eslint-direct` + `bin/eslint-direct-daemon.js` — in-process eslint daemon (`lint-text`, `lint-files`, `fix-text`, `format-results`, `version`)
- `bin/adapters/scalafmt-cli.js` + `bin/scalafmt-direct` + `bin/scalafmt-direct-coordinator.js` — per-call scalafmt coordinator (`format-stdin`, `format-files`, `check-files`, `version`)
- `scripts/capture-baseline.sh` + `fixtures/baselines/*.json` — per-wrapper JSON baselines (cold/warm timings + response sha256 + shape summary) for 5 LSP wrappers
- `scripts/verify.sh --json` and `scripts/verify.sh --diff-baselines` modes
- `docs/per-language/sbt.md`, `docs/per-language/dotnet.md`, `docs/per-language/node-formatters.md`, `docs/per-language/scalafmt.md`
- `MIGRATION.md` — describes the refactor, back-compat guarantees, rollback tags
- `CONTRIBUTING.md` — new "Architecture overview" + rewritten "Hybrid servers" + "Non-LSP tools" sections covering the adapter contract for both module families

### Changed
- `bin/lsp-stdio-proxy.js` body replaced with composition of `tool-harness` + `tool-server-proxy` + `adapters/lsp-stdio`. Steady-state response shape + state-dir layout byte-identical; CLI unchanged. External Node importers keep working — the file name and argv contract are preserved.
- `bin/vue-direct-coordinator.js` body similarly replaced, now composing `tool-harness` + `tool-server-proxy` + `adapters/vue-hybrid`. Vue LS v3 + tsserver bridging preserved verbatim (configurePlugin → warmup → init order, tsserver/request↔response tuple unwrap + double-wrap).
- `bin/py-direct`, `bin/ts-direct`, `bin/cs-direct`, `bin/java-direct` now pass `--tool-name <wrapper>` so the harness's `stateDir` resolves to the wrapper's existing slot instead of drifting to `~/.cache/lsp-stdio-proxy-direct/…`.
- `scripts/install.sh` symlinks the new shared modules + adapters dir + 5 opt-in wrappers + their coordinators. Merges new permission entries + sandbox-write allowlist entries for the new cache dirs.
- `README.md` lists the new opt-in wrappers; architecture section restructured (layout vs behavior) to describe the three-module split.

### Fixed
- Prettier/eslint adapter preload now consults `npm root -g` so globally-installed packages are picked up when the workspace has no local install.
- Stale-config bugs on existing LSP wrappers: touching `tsconfig.json`/`pyrightconfig.json`/`*.csproj`/`pom.xml`/`package.json` triggers `workspace/didChangeConfiguration` + `workspace/didChangeWatchedFiles` without a stop/start cycle. Hard-trigger files (`.env`, `.jvmopts`, `global.json`, `pnpm-lock.yaml`, `.python-version`, `.java-version`, `dotnet-tools.json`) force coordinator restart on next call.

### Added (observability)
- `<stateDir>/calls.log` — per-call JSON lines: `{ts, method, ms, adopted, invalidation_fired, outcome}`. Disable via `TOOL_DIRECT_CALLLOG=0`.
- `<stateDir>/triggers.json` — mtime baseline for invalidation.

### Verified
- `scripts/verify.sh --diff-baselines` clean on py/ts/cs/java/vue (response-body sha + shape match pre-refactor baselines; timings within machine noise).
- Invalidation smoke on all 5 LSP wrappers: soft trigger preserves PID, hard trigger restarts coordinator.
- `dotnet-direct call version {}` returns `{exit: 0, stdout: "10.0.103\n"}`.
- `prettier-direct call format-file {...}` returns `{formatted, changed}`; `eslint-direct call version {}` returns `{version: "10.2.1"}`.
- `sbt-direct call version {}` reads a real Play 3 / Scala 3 project's `build.sbt` → `{exit: 0, stdout: "sbt version in this project: 1.11.6\nsbt runner version: 1.10.11"}`.
- `sbt-direct call task {"task":"scalafmtCheckAll"}` against the same project runs the sbt-scalafmt plugin end-to-end, correctly surfaces per-file formatting diagnostics. Under Claude Bash sandbox, `install.sh` pre-allows `/private/var/folders/**/.sbt/**` + `~/.sbt/**` + `~/.ivy2/**` + `~/.coursier/**` so sbt's BootServerSocket + dependency caches write without `dangerouslyDisableSandbox`.
- `scalafmt-direct call check-files {...}` against a version-matched fixture → `{exit: 0, stdout: "All files are formatted with scalafmt :)"}`.
- `scalafmt-direct call format-stdin {source: "object A{def   x=1}", filepath: "A.scala"}` → `{exit: 0, stdout: "object A { def x = 1 }\n"}`.
- `dotnet-direct call version {}` → `{exit: 0, stdout: "10.0.103\n"}`.
- `prettier-direct call format-file {filepath}` → `{formatted, changed}`.
- `eslint-direct call version {}` → `{version: "10.2.1"}`.
- `hooks/tests/run.sh` → 97/97 pass.
- 19/19 harness + proxy smoke tests (`node --test bin/*.test.js`).

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

[1.2.0]: https://github.com/CHANGE-ME/claude-lsp-direct/releases/tag/v1.2.0
[1.1.0]: https://github.com/CHANGE-ME/claude-lsp-direct/releases/tag/v1.1.0
[1.0.0]: https://github.com/CHANGE-ME/claude-lsp-direct/releases/tag/v1.0.0
