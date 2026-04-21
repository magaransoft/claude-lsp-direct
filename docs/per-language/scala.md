# Scala — `metals-direct`

The odd one out: proxies `metals-mcp` (Scalameta's MCP server for Metals) over HTTP rather than LSP directly. Exposes 17 semantic tools as opposed to raw LSP methods.

Metals' LSP server itself doesn't integrate cleanly in every client due to Metals-specific build-import notifications that not every LSP client handles. `metals-mcp` is the supported path for tool-augmented agents.

## Install prereq
```bash
brew install metals
```
or
```bash
coursier install metals-mcp
```
Either puts a `metals-mcp` binary on `PATH`.

Your Scala projects need the `sbt-bloop` plugin so Metals can find compiled class files:
```scala
// project/plugins.sbt
addSbtPlugin("ch.epfl.scala" % "sbt-bloop" % "2.0.12")
```
Run `sbt bloopInstall` once per project.

## Workspace markers (walk-up order)
1. `build.sbt`
2. `build.sc`
3. `build.mill`

## Invocation
```bash
metals-direct start                                              # cwd walk-up
metals-direct call list-modules '{}'
metals-direct call get-usages '{"fqcn":"com.example.Service.method","module":"core"}'
metals-direct call get-source '{"fqcn":"com.example.Service"}'
metals-direct call inspect '{"fqcn":"com.example.Service","module":"core"}'
metals-direct call glob-search '{"query":"UserService","fileInFocus":"/abs/path/to/any.scala"}'
metals-direct tools                                              # full list
```

## Op surface (17 tools, not LSP methods)
Navigation + docs:
- `get-usages` — find all call sites by fully-qualified class name
- `get-source` — read source of a symbol (with or without method bodies)
- `inspect` — members + signatures of a class/object/trait
- `get-docs` — scaladoc for a symbol

Search:
- `glob-search` — symbol name substring search
- `typed-glob-search` — substring search + kind filter (class/object/method/trait/package)
- `find-dep` — find maven coords for a dependency

Build + diagnostics:
- `list-modules` — all build targets
- `compile-file`, `compile-module`, `compile-full`
- `import-build` — re-import after `build.sbt` change

Testing:
- `test` — run a test class or method

Formatting + refactoring:
- `format-file`
- `list-scalafix-rules`, `run-scalafix-rule`, `generate-scalafix-rule`

## Quirks
- **Cold `.bloop/` import:** first `metals-direct start` on a fresh checkout takes 30-120s while Bloop imports the build. Subsequent calls are ~30ms.
- **External server adoption:** if `<workspace>/.metals/mcp.json` already exists (IDE or prior session spawned a metals-mcp), `metals-direct` adopts that server instead of spawning a new one. `metals-direct stop` unregisters but doesn't kill the external process.
- **`fileInFocus` required for some tools:** `glob-search`, `typed-glob-search`, `compile-file`, `format-file`, `get-usages` need an absolute path to any file in the target module. Without it, errors "Missing fileInFocus and failed to infer it".
- **FQCN discovery:** tools that take `fqcn` require the exact fully-qualified name. Don't guess — look at the package line at the top of the source file first.

## Timing
- Cold: 30-120s (Bloop import on fresh `.bloop/`)
- Cold with adoption: ~0.1s
- Warm: ~30ms per call

## State directory
`~/.cache/metals-direct/<workspace-hash>/{pid,port,workspace,session,log}`
