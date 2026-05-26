# Java — `java-direct`

Proxies `jdtls` (Eclipse JDT.LS launcher) over HTTP. One server per workspace.

## Install prereq
```bash
brew install jdtls          # macOS — bundles Eclipse JDT.LS + launcher
# Linux: yay -S jdtls (Arch AUR), or download from https://download.eclipse.org/jdtls/snapshots/
java -version               # MUST report 17 or later (JDK, not JRE)
```
Verify: `command -v jdtls` (Homebrew formula installs a wrapper script that handles the Equinox bootstrap).

## Workspace markers (walk-up order)
1. `pom.xml`
2. `build.gradle.kts`
3. `build.gradle`
4. `settings.gradle.kts`
5. `settings.gradle`
6. `.project`

If none found, wrapper uses current working directory.

## Invocation
```bash
java-direct start                                                   # cwd walk-up
java-direct start /abs/path/to/project                              # explicit
java-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///abs/path/to/Foo.java"}}'

java-direct call textDocument/hover \
  '{"textDocument":{"uri":"file:///abs/path/to/Foo.java"},
    "position":{"line":10,"character":5}}'

java-direct call workspace/symbol '{"query":"UserService"}'

# multi-file fan-out (1 HTTP roundtrip + 1 tool_result for N files)
java-direct batch textDocument/documentSymbol \
  /abs/path/to/A.java /abs/path/to/B.java /abs/path/to/C.java

# raw multi-call (mixed methods)
java-direct batch-json '[
  {"method":"workspace/symbol","params":{"query":"UserService"}},
  {"method":"textDocument/hover","params":{"textDocument":{"uri":"file:///abs/x.java"},"position":{"line":0,"character":0}}}
]'
```

When querying >=2 files with the same method, callers MUST use `batch` (or `batch-json`) — the `enforce-batch-on-direct-call.py` PreToolUse hook blocks 2nd same-method `call` within 60s. Per-call envelope `{ok:true,value}|{ok:false,error}` returned per sub-call so one bad uri NEVER poisons siblings.

## Op surface
Standard LSP 3.17 methods jdtls implements:
`textDocument/documentSymbol`, `textDocument/hover`, `textDocument/definition`, `textDocument/references`, `textDocument/implementation`, `textDocument/typeDefinition`, `textDocument/completion`, `textDocument/signatureHelp`, `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls`, `workspace/symbol`, `textDocument/foldingRange`, `textDocument/codeAction`, `textDocument/rename`.

## Quirks
- **Background "Building workspace" job:** jdtls runs an asynchronous indexer after start. `workspace/symbol` may return empty for the first few seconds even though the server responds. Typical settle time: 5-15s on a small project, longer for Maven/Gradle imports that resolve transitive deps.
- **Eclipse `~/.eclipse` directory:** Equinox launcher extracts native libraries to `~/.eclipse` on first run. Sandboxed environments must allow writes there.
- **Per-workspace `-data` dir:** wrapper passes `-data $STATE_DIR/jdt-data` so each workspace's Eclipse metadata is isolated and removed on `stop`.
- **JDK 17+ required:** jdtls uses Java 17 language features. JDK 21 (LTS) is fine. JRE-only installs fail at startup.
- **Maven/Gradle imports:** first start of a real project triggers dependency resolution. For projects with hundreds of deps, expect cold start of 30-120s; subsequent starts are seconds (Eclipse caches the resolved model under `jdt-data`).

## Timing (rough, on a modern laptop, fixture project)
- Cold start (server boot to `/health` ready): ~2s
- Cold call (first request after start): ~900ms (incl. file load + indexing)
- Warm: ~80-100ms per call (HTTP round-trip dominates)

## State directory
`~/.cache/java-direct/<workspace-hash>/{pid,port,workspace,log,jdt-data/}`

Inspect `log` if startup fails (Eclipse stack traces are verbose; look for `!STACK` or `Operation not permitted`).
