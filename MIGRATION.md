# Migration notes

## 1.2.0 — tool-harness refactor (coordinator internals)

This release restructures the coordinator internals behind the same
CLI contract. External behavior is byte-identical for `py-direct`,
`ts-direct`, `cs-direct`, `java-direct`, `vue-direct` — steady-state
response shape + state-dir layout unchanged.

### What moved

- `bin/lsp-stdio-proxy.js` body replaced with a composition of:
  - `bin/tool-harness.js` — shared primitives (resolveWorkspace,
    stateDir, serveHttp, invalidationLoop, callLog, framing).
  - `bin/tool-server-proxy.js` — external-process coordinator.
  - `bin/adapters/lsp-stdio.js` — LSP-specific adapter (extracted
    verbatim from the old monolithic proxy).
- `bin/vue-direct-coordinator.js` body similarly replaced; logic moved
  to `bin/adapters/vue-hybrid.js` on the same harness.

### Compatibility

Both entrypoint files still exist and expose the same CLI
(`--workspace <path> --port <N>` for both; `--lang-id <id> -- <cmd>
[<args>...]` for lsp-stdio-proxy). External callers that
`require('./lsp-stdio-proxy.js')` as a Node module or spawn either
coordinator directly see no breaking change.

Wrappers (`py-direct`, etc.) go through the new composition by
default — no env toggle, no fallback path. The previous
`LSP_PROXY_IMPL=v1|v2` env var (transitional, shipped in a preview
commit) has been removed.

### New observable behavior

Features added during the refactor (documented in `docs/architecture.md`):

- **Auto-reload on config changes.** Each LSP adapter declares soft
  triggers (`tsconfig.json`, `*.csproj`, `pom.xml`, etc.); touching
  one no longer requires `stop && start`. `workspace/didChangeConfiguration`
  + `workspace/didChangeWatchedFiles` fire automatically on next call.
- **Hard-restart triggers.** Touching `.env`, `.env.local`, or
  ecosystem-specific files (`.python-version`, `.java-version`,
  `global.json`, `pnpm-lock.yaml`, …) forces a coordinator restart
  on next call — necessary because JVM/runtime env is frozen at
  spawn.
- **Per-call structured log.** Each `call` appends a JSON line to
  `<stateDir>/calls.log`: `{ts, method, ms, adopted,
  invalidation_fired, outcome}`. Disable via
  `TOOL_DIRECT_CALLLOG=0`.
- **Invalidation mtime baseline.** `<stateDir>/triggers.json` stores
  the last-seen mtime of every trigger file.

### New wrappers in this release

Opt-in additions (not auto-used):

- `sbt-direct` — per-call sbt coordinator. See
  `docs/per-language/sbt.md` (note sandbox limitation).
- `dotnet-direct` — per-call dotnet coordinator. MSBuild
  build-server handles warm persistence automatically. See
  `docs/per-language/dotnet.md`.
- `prettier-direct` — in-process prettier daemon (sibling
  `node-formatter-daemon.js` module). See
  `docs/per-language/node-formatters.md`.
- `eslint-direct` — in-process eslint daemon.
- `scalafmt-direct` — per-call scalafmt coordinator.

### Nothing to do

Existing users should notice no CLI or state-dir change. Run your
usual `py-direct call ...` (or ts/cs/java/vue) workflows; the
refactor is invisible except for the new auto-reload + calls.log
features, which activate automatically.

### Rolling back

Git tags land at each step: `pre-refactor`, `refactor-wave-1`,
`refactor-wave-2-step-{2,3,4,5}`, `refactor-wave-3-step-{6,7}`,
`refactor-wave-4`, `refactor-wave-5`, `refactor-wave-6-{A,B}`. Reset
to any of these if you need the previous state.

### Wave-6 follow-up adjustments (subtle)

Post-1.2.0 polish that doesn't change the headline contract:

- `bin/tool-server-proxy.js` — `adapter.adopt()` Promise is now awaited
  exactly once (prior pass called it via `Boolean(asyncFn(...))` which
  treated the Promise as truthy + invoked adopt a second time,
  assigning the Promise as `childSpecs`). Only `sbt-thin-client`
  exercised this path; no other adapter was affected.
- `bin/adapters/sbt-thin-client.js` — adoption probe changed from a 5s
  `sbt --client about` handshake to a two-stage check: (1) trust
  `target/active.json` if its mtime is <30min (on-disk evidence) (2)
  fall back to a 30s probe for older slots.
- `docs/per-language/sbt.md` — thin-client mode (`SBT_DIRECT_MODE=
  thin-client`) marked EXPERIMENTAL. sbt's `target/active.json` isn't
  written reliably under `-Dsbt.server.forcestart=true` across all
  builds; oneshot (default) unaffected.
- `docs/per-language/dotnet.md` — added § "Network-sandbox interaction"
  describing the NuGet-restore-under-sandbox block and the warm-cache
  / `noRestore:true` / sandbox.network whitelist resolution paths.
- `hooks/prewarm-direct-wrappers.py` — excludes `metals-direct` (races
  the IDE-spawned `metals-mcp`); probes backing-tool availability
  before firing (skips slots whose backing tool is no longer installed);
  stdout + stderr both discarded so SessionStart stays quiet.
- `scripts/uninstall.sh` — added `CLAUDE="${CLAUDE:-$HOME/.claude}"`
  env override so dry-runs can redirect against a scratch dir; sbt /
  coursier / ivy / scala-build paths included in the sandbox-strip set;
  prewarm SessionStart hook entry filtered out symmetrically.
- `scripts/verify.sh` — `VERIFY_STRICT_SHA=1` env gates sha-mismatch
  to FAIL (CI uses this). Default treats sha drift as warn-only so
  downstream users on different pyright / tsserver / csharp-ls
  versions don't false-fail the gate; structural-shape match
  (top_level + total_nodes counts) is always a hard gate.
