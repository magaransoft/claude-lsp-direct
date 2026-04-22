# Direct-wrapper convention

Specification for all `<lang>-direct` wrappers in this repo and any future contributions. If you're adding a new language, follow every invariant here.

## Primary path
Each supported language has a bash wrapper in `bin/` that proxies its LSP over persistent HTTP. This is the primary semantic-search path — roughly 100× faster perceived latency than tool-call-based LSP clients (HTTP round-trip sub-100ms vs ~8-9s per tool turn).

| language | wrapper | backend | workspace markers |
|---|---|---|---|
| scala | `metals-direct` | metals-mcp | `build.sbt` > `build.sc` > `build.mill` |
| vue | `vue-direct` | Vue Language Server v3 + tsserver w/ `@vue/typescript-plugin` | `package.json` |
| python | `py-direct` | pyright-langserver | `pyrightconfig.json` > `pyproject.toml` > `setup.cfg` > `setup.py` |
| typescript | `ts-direct` | typescript-language-server | `tsconfig.json` > `package.json` |
| csharp | `cs-direct` | csharp-ls | `.slnx` > `.sln` > `.csproj` |
| java | `java-direct` | jdtls (Eclipse JDT.LS) | `pom.xml` > `build.gradle.kts` > `build.gradle` > `settings.gradle.kts` > `settings.gradle` > `.project` |

### Opt-in wrappers (non-LSP)

Same CLI contract, different `call` method surface (named methods, not LSP methods).

| tool | wrapper | backend | workspace markers |
|---|---|---|---|
| sbt | `sbt-direct` | `sbt` CLI (one-shot) + `sbt --client` (persistent-JVM, see adapter) | `build.sbt` > `build.sc` > `build.mill` > `project/build.properties` |
| dotnet | `dotnet-direct` | `dotnet` CLI (per-call; MSBuild build-server handles warm persistence) | `global.json` > `*.sln` > `*.slnx` > `*.csproj` > `*.fsproj` > `*.vbproj` |
| prettier | `prettier-direct` | in-process `require('prettier')` | `.prettierrc*` > `prettier.config.*` > `package.json` |
| eslint | `eslint-direct` | in-process `require('eslint')` | `eslint.config.*` > `.eslintrc*` > `package.json` |
| scalafmt | `scalafmt-direct` | `scalafmt` native/JVM CLI | `.scalafmt.conf` > `build.sbt` > `build.sc` > `build.mill` |

## Invariants

### Location
- `bin/<name>-direct` — bash wrapper, user-scope, project-agnostic
- `bin/tool-harness.js` — shared primitives (resolveWorkspace, stateDir, serveHttp, invalidationLoop, callLog, framing)
- `bin/tool-server-proxy.js` — external-process coordinator (LSPs, sbt, dotnet, scalafmt)
- `bin/node-formatter-daemon.js` — in-process Node-library coordinator (prettier, eslint)
- `bin/adapters/<tool>.js` — per-tool behavior (spawn children, init, onChildMessage, call, triggers)
- `bin/lsp-stdio-proxy.js`, `bin/vue-direct-coordinator.js` — back-compat shim entrypoints composing harness + proxy + adapter

### CLI surface
All wrappers expose the same subcommands:
```
<name>-direct start|call|stop|status|tools [workspace]
<name>-direct call <method> '<json-params>' [workspace]
```
- `start` — spawn coordinator for workspace
- `call` — auto-starts if needed, issues LSP method, returns JSON
- `stop` — kill coordinator
- `status` — show all tracked servers
- `tools` — list LSP method surface

`textDocument/*` params MUST include `textDocument.uri` as `file://<abs-path>`.

### Op surface
Raw LSP method names, unmodified from the underlying server. No custom abstraction:
`textDocument/documentSymbol`, `textDocument/hover`, `textDocument/definition`, `textDocument/references`, `textDocument/implementation`, `textDocument/typeDefinition`, `textDocument/completion`, `textDocument/signatureHelp`, `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls`, `workspace/symbol`

Exception: `metals-direct` exposes 17 `metals-mcp` tools (`list-modules`, `inspect`, `get-docs`, `glob-search`, etc.) because the backend is not pure LSP.

### Transport
HTTP over dynamic loopback port. Per-workspace state lives in:
```
~/.cache/<name>-direct/<workspace-hash>/{pid,port,workspace,log}
```

### Workspace resolution
Walk up from cwd for the language-specific markers (table above). First match wins. Explicit workspace arg overrides walk-up.

### Alive probe
Use `curl -fsS GET /health` for liveness. NEVER `kill -0 <pid>` or `/dev/tcp/host/port` — some sandboxed environments (Claude Code's macOS sandbox, for example) deny both.

### Verification
Functional probe only — one valid LSP response on a real target file. No timing gate for acceptance. Record cold/warm timings as observations, not blockers.

## Why direct wrappers
Standard LSP clients pay a fixed per-call overhead that dominates server speed (typically 2-10s per tool turn in agentic environments). Direct wrappers let a client issue many LSP calls inside a single shell invocation, amortizing the overhead to near-zero. Per-workspace HTTP servers also fix language servers that bind rootUri at init (e.g. csharp-ls) — each workspace gets its own instance, so switching between projects in one session works without restart.

## Adding a new language
See `CONTRIBUTING.md` for the full template. Summary:
1. Copy `bin/py-direct` as a template
2. Swap `LSP_BIN`, `LSP_ARGS`, `LANG_ID`, `WORKSPACE_MARKERS`
3. Update `STATE_ROOT` env-var name
4. Add install prereq message in the `command -v` check
5. Add a fixture under `fixtures/<lang>/`
6. Add a doc page under `docs/per-language/<lang>.md`
7. Extend `hooks/enforce-lsp-over-grep.py` `LANG_DIRECT_WRAPPER` map (if using the hook)
8. Add a CI matrix entry

## Fallback discipline
grep/rg/find on source extensions is acceptable ONLY when:
- The direct wrapper cannot resolve (symbol in comment/string literal, file not indexed)
- The target is a config/data/doc file that happens to share an extension
- You explicitly state which wrapper op was tried and why it failed before falling back
