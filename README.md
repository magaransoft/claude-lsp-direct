# claude-lsp-direct

Per-workspace proxies over HTTP for language servers, build tools, and formatters:

- **LSPs** — Python, TypeScript / JavaScript, C#, Vue, Scala, Java.
  Sub-100ms steady-state; sidesteps the per-tool-call round-trip that
  agent harnesses pay. Per-workspace isolation fixes servers that
  bind `rootUri` at init (e.g. `csharp-ls`).
- **Opt-in build tools** — sbt, dotnet.
- **Opt-in formatters** — prettier, eslint, scalafmt.

Extends the pattern Angel Blanco ([@NovaMage](https://github.com/NovaMage))
first demonstrated for Scala in
[agents-metals-direct-lsp](https://github.com/NovaMage/agents-metals-direct-lsp)
across the full set of language servers common in multi-stack
monorepos.

## Why

Native `LSP(operation=...)` calls in Claude Code cost ~8-9s per
invocation in my measurements — this is harness round-trip, not
server speed. Angel's independent measurement on a 347k-LOC Scala
monorepo put MCP-wrapped LSP calls at **~230× slower than direct
HTTP** against the same `metals-mcp` backend
([claude-code#45132 comment](https://github.com/anthropics/claude-code/issues/45132#issuecomment-3492812921)).
At that cost, any workflow doing dozens of lookups (call-hierarchy
walks, rename-impact analysis, cross-package API surveys) is
unusable in practice.

This repo batches: one shell call to the bash wrapper, many LSP calls
over HTTP to a persistent per-workspace server. Amortizes the agent
turn. Also fixes `csharp-ls`: its `rootUri`-at-init binding means
tool-call clients can't switch .NET projects mid-session —
per-workspace spawn here makes that free.

## Benchmarks

Direct-wrapper numbers measured 2026-04-21 on macOS 26.4.1 arm64
(see *Tested versions* below) against real workspace files. "Before"
for py/ts/cs is native `LSP()` in Claude Code (per-tool-call harness
round-trip included). "Before" for Scala is Angel's published
benchmark on a Scala 3 / Play Framework 3 monorepo (16 build targets,
~5,600 files, 347k LOC); query = `get-usages` on a case-class field
with 107 references.

| language | source of "before" | before cold | before warm | after cold | after warm | warm speedup |
|---|---|---|---|---|---|---|
| python | my measurement, `LSP()` tool | 14.4s | 9.4s | 0.14s | 0.07s | **~130×** |
| typescript | my measurement, `LSP()` tool | 9.0s | 9.6s | 0.26s | 0.07s | **~130×** |
| csharp | my measurement, `LSP()` tool * | ~9s (empty) | ~10s (empty) | 30-120s † | 0.07s | rootUri fix + **~130× warm** |
| vue | unsupported ‡ | — | — | 6.6s | 0.09s | enables capability |
| scala | [Angel Blanco benchmark](https://github.com/anthropics/claude-code/issues/45132#issuecomment-3492812921), Claude MCP/stdio | 10.7s | ~6.3s avg | 0.14s § | 0.08s | **~80×** (his direct-HTTP baseline: 0.038s, essentially the same) |
| java | my measurement, `LSP()` tool (`jdtls-lsp@claude-plugins-official`) | ~9s ¶ | ~9s ¶ | 0.91s | 0.085s | **~100×** |

\* `csharp-ls` bound to wrong `rootUri` (cwd outside `.sln` ancestor)
returns empty in ~9-10s.
† cs-direct cold = MSBuild solution load + NuGet restore. Amortized
across the session.
‡ Vue LS v3 is hybrid-mandatory (needs paired tsserver +
`@vue/typescript-plugin`); Claude Code's plugin loader can't host the
paired setup, so native `LSP()` on `.vue` isn't available.
§ metals-direct cold of 0.14s is the server-adoption path (reuses an
existing `metals-mcp` via `<workspace>/.metals/mcp.json`); fresh cold
with Bloop re-import is 30-120s.
¶ java "before" matches the documented `LSP()` tool harness
round-trip floor (~8-9s per invocation); `jdtls-lsp@claude-plugins-official`
plugin pools the server but each call still pays the per-tool-turn
cost. java-direct cold of 0.91s is the first call after `start`
(Eclipse "Building workspace" job runs in background); subsequent
calls steady at ~85ms. On a real Maven/Gradle project, expect cold
of 30-120s on first start (dependency resolution), then sub-100ms
warm.

The point isn't the specific numbers — it's the order-of-magnitude
gap between a persistent HTTP proxy and the minimum cost of a
per-call tool turn.

### Opt-in wrappers (sbt, dotnet, prettier, eslint, scalafmt)

Measured 2026-04-22 on macOS 26.4.1 arm64, N=3 iterations each. Cold
= fresh coordinator (state dir wiped); warm = coordinator already
running. "Bare" = invoking the underlying tool directly from a shell
(whatever caching that tool's launcher does is already included).

| wrapper | bare tool avg | direct cold avg | direct warm avg | warm vs bare |
|---|---|---|---|---|
| `sbt-direct` oneshot | 1661ms ¹ | 4922ms | 3600ms | **slower** — see note |
| `sbt-direct` bsp | 1661ms ¹ | 1285ms ² | **131ms** | **~13× faster** |
| `dotnet-direct` | 1172ms ³ | 1739ms | 555ms | **~2× faster** |
| `prettier-direct` | 211ms | 1278ms | 95ms | **~2× faster** |
| `eslint-direct` | 274ms | 1252ms | 88ms | **~3× faster** |
| `scalafmt-direct` | 86ms | 1243ms | 112ms | **~same** (native already fast) |

¹ sbt's own launcher daemon caches classpath across invocations, so
"bare sbt" numbers range from 207ms (daemon hot) to 4.5s (daemon
cold). 1661ms is the 3-run average.

² `bsp cold` here measures only the first `/call` after a fresh state
dir. The underlying sbt JVM was still warm from a prior session on
this machine. **Genuine from-scratch cold** (new Ivy/Coursier
resolve + JVM boot + BSP init) is 15-90s on a fresh checkout — once,
per workspace. All subsequent calls land in the 131ms warm band.

³ MSBuild's build-server persists across invocations automatically, so
"bare dotnet" is already warm on the 2nd+ call. 1172ms is the average
of one cold + two warm runs.

### Where direct wrappers actually help

- **sbt bsp warm path** — 131ms vs bare sbt's unpredictable
  207ms-4.5s range. Biggest win by far.
- **prettier + eslint warm** — 2-3× faster than bare because the
  daemon keeps `require('prettier')` / `new ESLint(...)` cached in
  memory.
- **LSP wrappers** (py/ts/cs/java/vue) — covered by the LSP table
  above; the argument is against `LSP()` tool-harness round-trips,
  not against bare language-server invocation.

### Where direct wrappers don't help (or hurt)

- **sbt oneshot mode** — no persistence, so it strictly adds
  coordinator overhead on top of bare sbt. Exists only as a fallback
  for when BSP isn't configured in the workspace. **Use `bsp` mode
  (`SBT_DIRECT_MODE=bsp`) whenever possible.**
- **dotnet-direct** — MSBuild's build-server gives bare dotnet the
  same warm-path benefit. Direct wrapper is within 2× of bare;
  shipping it is about uniform CLI contract + `calls.log` observability,
  not speed.
- **scalafmt-direct** — scalafmt's native binary is already
  sub-200ms cold. Direct adds coordinator round-trip overhead that
  cancels the win. Ship it for consistency (and for access to
  scalafmt from the same harness as the other tools), not speed.

## Architecture

```
CLI → <tool>-direct (bash)
        │ HTTP POST /call { method, params }   (/lsp alias kept for back-compat)
        ▼
      Per-workspace Node coordinator
        │ tool-harness + tool-server-proxy OR node-formatter-daemon
        ▼
      Backing tool (LSP, build server, formatter library)
```

### Layout

- One bash wrapper per tool — workspace walk-up, state dir, curl client.
- Shared primitives in `bin/tool-harness.js`: `resolveWorkspace`,
  `stateDir`, `serveHttp`, `invalidationLoop`, `callLog`, framing
  readers/writers.
- Two coordinator modules built on the harness:
  - `bin/tool-server-proxy.js` — external-process tools with stdio
    framing (LSPs, sbt, dotnet, scalafmt).
  - `bin/node-formatter-daemon.js` — in-process Node libraries
    (prettier, eslint).
- Per-tool behavior in `bin/adapters/<tool>.js`. New tools = new
  adapter; coordinators unchanged.

### Behavior

- One process per workspace (hashed state dir at
  `~/.cache/<name>-direct/<hash>/`).
- Auto-reload on config-file changes (`tsconfig.json`, `*.csproj`,
  etc.) via `workspace/didChangeConfiguration`.
- Hard-restart on env-frozen triggers (`.env`, `.jvmopts`,
  `global.json`, …).
- Per-call JSON log at `<stateDir>/calls.log`.
- HTTP `/health` for liveness — sandboxed environments deny
  `kill -0` and `/dev/tcp`.
- Method-name contract: raw LSP method names for LSPs (unmodified
  from the underlying server), except `metals-direct` which exposes
  `metals-mcp`'s 17-tool MCP surface. Named methods for build tools
  and formatters (`task`, `build`, `format`, `lint-files`, …).

Full spec: [`docs/convention.md`](docs/convention.md) ·
[`docs/architecture.md`](docs/architecture.md) ·
[`docs/troubleshooting.md`](docs/troubleshooting.md) ·
[`MIGRATION.md`](MIGRATION.md)

Per-language: [Python](docs/per-language/python.md) ·
[TypeScript](docs/per-language/typescript.md) ·
[C#](docs/per-language/csharp.md) ·
[Vue](docs/per-language/vue.md) ·
[Scala (LSP)](docs/per-language/scala.md) ·
[Java](docs/per-language/java.md)

Per-tool (opt-in): [sbt](docs/per-language/sbt.md) ·
[dotnet](docs/per-language/dotnet.md) ·
[prettier + eslint](docs/per-language/node-formatters.md) ·
[scalafmt](docs/per-language/scalafmt.md)

## Quickstart

```bash
git clone https://github.com/<your-user>/claude-lsp-direct.git ~/projects/claude-lsp-direct
cd ~/projects/claude-lsp-direct
./scripts/install.sh                                   # symlinks to ~/.claude/ + merges settings.json
./scripts/verify.sh                                    # functional probe on bundled fixtures
```

Install only the language server(s) you need (see per-language docs
for version pinning).

### Single-wrapper install (e.g. only Java, only sbt, only prettier)

You still run `./scripts/install.sh` — it's idempotent, only symlinks
files, costs nothing extra, and keeps updates consistent across all
wrappers. Then install only the backend(s) your wrapper needs:

| wrapper | install the backend |
|---|---|
| `py-direct` | `npm i -g pyright` |
| `ts-direct` | `npm i -g typescript-language-server typescript` |
| `cs-direct` | `dotnet tool install -g csharp-ls` |
| `vue-direct` | `npm i -g @vue/language-server@3.2.6 @vue/typescript-plugin@3.2.6 typescript@5.9.3` |
| `java-direct` | `brew install jdtls` (macOS) — any JDK 17+ |
| `metals-direct` | `brew install metals` |
| `sbt-direct` | `brew install sbt` (or sdkman) |
| `dotnet-direct` | .NET SDK already present if you use csharp |
| `prettier-direct` | `npm i -g prettier` (or workspace-local `pnpm add -D prettier`) |
| `eslint-direct` | `npm i -g eslint` (or workspace-local) |
| `scalafmt-direct` | native binary via `curl -L https://github.com/scalameta/scalafmt/releases/latest/download/scalafmt-aarch64-apple-darwin.zip` — see [scalafmt docs](docs/per-language/scalafmt.md) |

Then call only the wrapper you want:

```bash
java-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///path/to/File.java"}}'
```

Wrappers whose backing binary isn't installed no-op cleanly —
`java-direct` won't interfere with a Python-only workflow and vice
versa. `scripts/verify.sh` reports SKIP for those languages, which is
the intended behavior, not a failure.

```bash
py-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///path/to/your.py"}}'
```

Manual install (non-Claude-Code users):
`ln -s ~/projects/claude-lsp-direct/bin/* ~/.local/bin/`. Any editor
or agent that can shell + curl can use this.

## What `install.sh` changes on your system

Full transparency — `scripts/install.sh` is idempotent and only
touches paths under `~/.claude/`. Inspect the script before running
if you'd rather apply changes manually.

| change | scope | reversible |
|---|---|---|
| symlinks `bin/*` → `~/.claude/bin/<wrapper>` (19 files + `adapters/` dir): 11 wrappers, 5 coordinators, 3 shared modules (tool-harness, tool-server-proxy, node-formatter-daemon); `adapters/` linked as a directory | filesystem | `scripts/uninstall.sh` removes them; pre-existing files are backed up to `<file>.bak-<ts>` |
| symlinks `hooks/*` → `~/.claude/hooks/<hook>` (3 hooks: enforce-lsp-over-grep, enforce-lsp-workspace-root, prewarm-direct-wrappers) | filesystem | same — uninstall + backups |
| merges into `~/.claude/settings.json` `permissions.allow`: `Bash(~/.claude/bin/<wrapper> *)` for each wrapper | Claude Code permission allowlist | `~/.claude/settings.json.bak-<ts>` written before merge; revert by restoring the backup |
| merges into `~/.claude/settings.json` `sandbox.filesystem.allowWrite`: `~/.cache/<wrapper>/**` for each wrapper, plus `~/.eclipse/**` (jdtls JNI extraction), plus sbt/ivy/coursier paths (sbt-direct ipcsocket + dependency caches) | Claude Code sandbox | same backup |
| merges into `~/.claude/settings.json` `hooks.SessionStart` a pre-warm entry that probes + restarts cached direct-wrapper servers | Claude Code hooks | same backup; `unique_by(.command)` idempotent |

Why each sandbox write is needed:

- `~/.cache/<wrapper>/**` — per-workspace state dir each wrapper uses
  for `pid/port/workspace/log/calls.log/triggers.json` files. Hash-
  scoped; no shared writes.
- `~/.eclipse/**` — only for `java-direct`. Eclipse Equinox launcher
  extracts JNI native libraries here on first jdtls start. One-time
  write, then read-only. Standard Eclipse-tooling path; same dir
  VSCode-Java, IntelliJ Eclipse plugin, etc. write to.
- `/private/var/folders/**/.sbt/**`, `~/.sbt/**`, `~/.ivy2/**`,
  `~/.coursier/**` — only for `sbt-direct`. sbt's BootServerSocket is
  created under the macOS per-user tmpdir regardless of `$TMPDIR` env,
  and Ivy/Coursier cache dependency jars here on first resolve. Native
  sbt behavior; same dirs any Scala toolchain writes to.
- `/private/var/folders/**/.scala-build/**` — only for Scala CLI /
  scala-cli users; safe no-op if you don't use it.

`install.sh` does NOT touch: shell rc files, your PATH, system
directories, network configs, secrets, plugins outside `~/.claude/`.
Skip the script entirely if you only want the wrappers — `ln -s`
them into any PATH dir and the rest is no-op for non-Claude-Code
agents.

Do it at your own discretion — the changes are small and visible,
but you own your sandbox config.

## Tested versions

Exact versions this was developed and benchmarked against. Other
versions likely work; these are what's verified.

| component | version |
|---|---|
| macOS | 26.4.1 arm64 (Darwin 25.4.0) |
| Node.js | 24.14.1 (via nvm) |
| Python | 3.9.6 |
| bash | 3.2.57 / GNU bash on Linux |
| pyright | 1.1.409 |
| typescript-language-server | 5.1.3 |
| typescript | 5.9.3 |
| @vue/language-server | 3.2.6 |
| @vue/typescript-plugin | 3.2.6 |
| csharp-ls | 0.24.0.0 |
| metals-mcp | 1.6.7 (Angel's benchmark); `brew install metals` (latest) otherwise |
| jdtls | 1.58.0 (`brew install jdtls`) |
| OpenJDK | 21.0.5 LTS (Corretto) — any JDK 17+ works |
| .NET SDK | 9.x recommended (10.x has an MSBuild BuildHost pipe issue with csharp-ls on macOS — see [csharp docs](docs/per-language/csharp.md)) |

If you're running different versions, `scripts/verify.sh` is the
quickest way to confirm the wrapper still works end-to-end on your
stack.

## A note to the Claude platform team

The gap this repo fills exists because every `LSP()` call is a
separate agent turn, and each turn has a fixed floor that's an
order of magnitude larger than the underlying LSP op. From a
developer trying to build agentic workflows on Claude Code, that
floor — not model speed, not server speed — is the bottleneck. A
few upstream changes would collapse the need for this repo:

1. **A batched `LSP()` tool** accepting an array of operations. Most
   semantic-navigation workflows naturally batch; today each step is
   its own tool turn.
2. **Persistent LSP sessions + initializationOptions in the
   plugin-loader schema.** `plugin.json` currently supports only
   `command | args | extensionToLanguage | startupTimeout` — no init
   options, no env, no cross-server bridging. Hybrid servers (Vue v3)
   are structurally unsupported; `csharp-ls`'s rootUri-at-init is
   un-fixable from a client that can only spawn one instance per
   session.
3. **Per-workspace pooling** — the natural next step once sessions
   are persistent.
4. **Lower the per-tool-call floor.** Even a 9s → 1s improvement
   would erase most of the perceived-latency advantage of direct
   wrappers.

Happy to chat if any of this is under consideration or if the
patterns here would be useful as reference.

## Acknowledgments

- **Angel Blanco (Mago)** — [@NovaMage](https://github.com/NovaMage)
  — published the original
  [agents-metals-direct-lsp](https://github.com/NovaMage/agents-metals-direct-lsp)
  pattern for Scala, ran the benchmarks in
  [claude-code#45132](https://github.com/anthropics/claude-code/issues/45132)
  showing ~230× MCP overhead vs direct HTTP, and opened the
  [Scala contributors thread](https://contributors.scala-lang.org/t/rallying-scala-metals-lsp-native-support-in-claude-code/7437)
  rallying support. This repo is a generalization of his approach
  across more languages.
- **[Tomasz Godzik](https://github.com/tgodzik)** (Scalameta / Metals
  maintainer) — for `metals-mcp` and for documenting why Metals +
  generic LSP clients don't compose cleanly.
- **Volar.js / Vue Language Tools** — for publishing the hybrid
  architecture clearly enough that a bridge from outside was possible.
- **pyright**, **typescript-language-server**,
  **csharp-language-server** maintainers — for clean standalone
  stdio implementations this repo is a thin layer over.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Adding a language is usually
a ~100 LOC bash wrapper + fixture + doc page + CI entry. PRs welcome
for Go, Rust, Ruby, Kotlin, Swift, Elixir, …

## License

MIT — see [LICENSE](LICENSE).
