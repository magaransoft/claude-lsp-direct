# claude-lsp-direct

Per-workspace LSP proxies over HTTP for **Python**, **TypeScript / JavaScript**, **C#**, **Vue**, **Scala**, **Java**. Sub-100ms steady-state; sidesteps the per-tool-call round-trip that agent harnesses pay. Per-workspace isolation fixes servers that bind `rootUri` at init (e.g. `csharp-ls`).

Extends the pattern Angel Blanco ([@NovaMage](https://github.com/NovaMage)) first demonstrated for Scala in [agents-metals-direct-lsp](https://github.com/NovaMage/agents-metals-direct-lsp) across the full set of language servers common in multi-stack monorepos.

## Why

Native `LSP(operation=...)` calls in Claude Code cost ~8-9s per invocation in my measurements — this is harness round-trip, not server speed. Angel's independent measurement on a 347k-LOC Scala monorepo put MCP-wrapped LSP calls at **~230× slower than direct HTTP** against the same `metals-mcp` backend ([claude-code#45132 comment](https://github.com/anthropics/claude-code/issues/45132#issuecomment-3492812921)). At that cost, any workflow doing dozens of lookups (call-hierarchy walks, rename-impact analysis, cross-package API surveys) is unusable in practice.

This repo batches: one shell call to the bash wrapper, many LSP calls over HTTP to a persistent per-workspace server. Amortizes the agent turn. Also fixes `csharp-ls`: its `rootUri`-at-init binding means tool-call clients can't switch .NET projects mid-session — per-workspace spawn here makes that free.

## Benchmarks

Direct-wrapper numbers measured 2026-04-21 on macOS 26.4.1 arm64 (see *Tested versions* below) against real workspace files. "Before" for py/ts/cs is native `LSP()` in Claude Code (per-tool-call harness round-trip included). "Before" for Scala is Angel's published benchmark on a Scala 3 / Play Framework 3 monorepo (16 build targets, ~5,600 files, 347k LOC); query = `get-usages` on a case-class field with 107 references.

| language | source of "before" | before cold | before warm | after cold | after warm | warm speedup |
|---|---|---|---|---|---|---|
| python | my measurement, `LSP()` tool | 14.4s | 9.4s | 0.14s | 0.07s | **~130×** |
| typescript | my measurement, `LSP()` tool | 9.0s | 9.6s | 0.26s | 0.07s | **~130×** |
| csharp | my measurement, `LSP()` tool * | ~9s (empty) | ~10s (empty) | 30-120s † | 0.07s | rootUri fix + **~130× warm** |
| vue | unsupported ‡ | — | — | 6.6s | 0.09s | enables capability |
| scala | [Angel Blanco benchmark](https://github.com/anthropics/claude-code/issues/45132#issuecomment-3492812921), Claude MCP/stdio | 10.7s | ~6.3s avg | 0.14s § | 0.08s | **~80×** (his direct-HTTP baseline: 0.038s, essentially the same) |
| java | my measurement, `LSP()` tool (`jdtls-lsp@claude-plugins-official`) | ~9s ¶ | ~9s ¶ | 0.91s | 0.085s | **~100×** |

\* `csharp-ls` bound to wrong `rootUri` (cwd outside `.sln` ancestor) returns empty in ~9-10s.
† cs-direct cold = MSBuild solution load + NuGet restore. Amortized across the session.
‡ Vue LS v3 is hybrid-mandatory (needs paired tsserver + `@vue/typescript-plugin`); Claude Code's plugin loader can't host the paired setup, so native `LSP()` on `.vue` isn't available.
§ metals-direct cold of 0.14s is the server-adoption path (reuses an existing `metals-mcp` via `<workspace>/.metals/mcp.json`); fresh cold with Bloop re-import is 30-120s.
¶ java "before" matches the documented `LSP()` tool harness round-trip floor (~8-9s per invocation); `jdtls-lsp@claude-plugins-official` plugin pools the server but each call still pays the per-tool-turn cost. java-direct cold of 0.91s is the first call after `start` (Eclipse "Building workspace" job runs in background); subsequent calls steady at ~85ms. On a real Maven/Gradle project, expect cold of 30-120s on first start (dependency resolution), then sub-100ms warm.

The point isn't the specific numbers — it's the order-of-magnitude gap between a persistent HTTP proxy and the minimum cost of a per-call tool turn.

## Architecture

```
CLI → <lang>-direct (bash)
        │ HTTP POST /lsp { method, params }
        ▼
      Node coordinator (persistent, per-workspace)
        │ stdio JSON-RPC (LSP or custom-framed)
        ▼
      Language server (pyright / ts-ls / csharp-ls / Vue LS / metals-mcp)
```

- Thin bash wrapper per language — workspace walk-up, state dir, curl client
- Shared generic coordinator (`lsp-stdio-proxy.js`) for py/ts/cs; dedicated hybrid coordinator (`vue-direct-coordinator.js`) for Vue v3
- One process per workspace (hashed state dir at `~/.cache/<name>-direct/<hash>/`)
- HTTP `/health` for liveness (sandboxed environments deny `kill -0` and `/dev/tcp`)
- Raw LSP method names, unmodified — except `metals-direct` which exposes `metals-mcp`'s 17-tool MCP surface

Full spec: [`docs/convention.md`](docs/convention.md) · [`docs/architecture.md`](docs/architecture.md) · [`docs/troubleshooting.md`](docs/troubleshooting.md)

Per-language: [Python](docs/per-language/python.md) · [TypeScript](docs/per-language/typescript.md) · [C#](docs/per-language/csharp.md) · [Vue](docs/per-language/vue.md) · [Scala](docs/per-language/scala.md) · [Java](docs/per-language/java.md)

## Quickstart

```bash
git clone https://github.com/<your-user>/claude-lsp-direct.git ~/projects/claude-lsp-direct
cd ~/projects/claude-lsp-direct
./scripts/install.sh                                   # symlinks to ~/.claude/ + merges settings.json
./scripts/verify.sh                                    # functional probe on bundled fixtures
```

Install only the language server(s) you need (see per-language docs for version pinning).

```bash
py-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///path/to/your.py"}}'
```

Manual install (non-Claude-Code users): `ln -s ~/projects/claude-lsp-direct/bin/* ~/.local/bin/`. Any editor or agent that can shell + curl can use this.

## Tested versions

Exact versions this was developed and benchmarked against. Other versions likely work; these are what's verified.

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

If you're running different versions, `scripts/verify.sh` is the quickest way to confirm the wrapper still works end-to-end on your stack.

## A note to the Claude platform team

The gap this repo fills exists because every `LSP()` call is a separate agent turn, and each turn has a fixed floor that's an order of magnitude larger than the underlying LSP op. From a developer trying to build agentic workflows on Claude Code, that floor — not model speed, not server speed — is the bottleneck. A few upstream changes would collapse the need for this repo:

1. **A batched `LSP()` tool** accepting an array of operations. Most semantic-navigation workflows naturally batch; today each step is its own tool turn.
2. **Persistent LSP sessions + initializationOptions in the plugin-loader schema.** `plugin.json` currently supports only `command | args | extensionToLanguage | startupTimeout` — no init options, no env, no cross-server bridging. Hybrid servers (Vue v3) are structurally unsupported; `csharp-ls`'s rootUri-at-init is un-fixable from a client that can only spawn one instance per session.
3. **Per-workspace pooling** — the natural next step once sessions are persistent.
4. **Lower the per-tool-call floor.** Even a 9s → 1s improvement would erase most of the perceived-latency advantage of direct wrappers.

Happy to chat if any of this is under consideration or if the patterns here would be useful as reference.

## Acknowledgments

- **Angel Blanco (Mago)** — [@NovaMage](https://github.com/NovaMage) — published the original [agents-metals-direct-lsp](https://github.com/NovaMage/agents-metals-direct-lsp) pattern for Scala, ran the benchmarks in [claude-code#45132](https://github.com/anthropics/claude-code/issues/45132) showing ~230× MCP overhead vs direct HTTP, and opened the [Scala contributors thread](https://contributors.scala-lang.org/t/rallying-scala-metals-lsp-native-support-in-claude-code/7437) rallying support. This repo is a generalization of his approach across more languages.
- **[Tomasz Godzik](https://github.com/tgodzik)** (Scalameta / Metals maintainer) — for `metals-mcp` and for documenting why Metals + generic LSP clients don't compose cleanly.
- **Volar.js / Vue Language Tools** — for publishing the hybrid architecture clearly enough that a bridge from outside was possible.
- **pyright**, **typescript-language-server**, **csharp-language-server** maintainers — for clean standalone stdio implementations this repo is a thin layer over.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Adding a language is usually a ~100 LOC bash wrapper + fixture + doc page + CI entry. PRs welcome for Go, Rust, Ruby, Kotlin, Swift, Elixir, …

## License

MIT — see [LICENSE](LICENSE).
