# C# — `cs-direct`

Proxies `csharp-ls` over HTTP. One server per workspace. Handles `.cs`, `.csx`.

## Install prereq
```bash
dotnet tool install -g csharp-ls
```
The binary lands at `~/.dotnet/tools/csharp-ls`. Ensure that directory is in `PATH`.

Verify: `csharp-ls --version` (should print `csharp-ls, X.Y.Z.W`).

## Workspace markers (walk-up order)
1. `.slnx` (new XML-based solution format, SDK 9+)
2. `.sln`
3. `.csproj`

## Invocation
```bash
cs-direct start                                                  # cwd walk-up
cs-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///abs/path/to/File.cs"}}'

cs-direct call textDocument/definition \
  '{"textDocument":{"uri":"file:///abs/path/to/File.cs"},
    "position":{"line":25,"character":15}}'

cs-direct call workspace/symbol '{"query":"IUserService"}'

# multi-file fan-out (1 HTTP roundtrip + 1 tool_result for N files)
cs-direct batch textDocument/documentSymbol \
  /abs/path/to/A.cs /abs/path/to/B.cs /abs/path/to/C.cs

# raw multi-call (mixed methods)
cs-direct batch-json '[
  {"method":"workspace/symbol","params":{"query":"IUserService"}},
  {"method":"textDocument/hover","params":{"textDocument":{"uri":"file:///abs/x.cs"},"position":{"line":0,"character":0}}}
]'
```

When querying >=2 files with the same method, callers MUST use `batch` (or `batch-json`) — the `enforce-batch-on-direct-call.py` PreToolUse hook blocks 2nd same-method `call` within 60s. Per-call envelope `{ok:true,value}|{ok:false,error}` returned per sub-call so one bad uri NEVER poisons siblings.

## The rootUri-at-init fix
`csharp-ls` binds `rootUri` at the `initialize` handshake and cannot change it. Starting `csharp-ls` from a cwd outside the `.sln`/`.csproj` ancestor means the server loads an empty workspace and every query returns "no symbols found" — a hard usability bottleneck for agentic clients switching between multiple .NET projects.

`cs-direct` solves this by spawning ONE `csharp-ls` PER WORKSPACE. Each workspace hash slot gets its own server with the correct `rootUri`. Switching between projects mid-session is free — just pass the workspace arg, the matching slot gets created on first `call`.

## Quirks
- **MSBuild BuildHost pipe failure (.NET 10 macOS):** csharp-ls uses MSBuild's out-of-process `BuildHost` to load projects. On .NET SDK 10.0.x on macOS, the `NamedPipeClientStream.ConnectAsync` call fails, and `cs-direct` returns `result: null` for every query despite a live server. See `docs/troubleshooting.md` for the workaround (pin to .NET 9.x SDK or wait for a csharp-ls fix). Not a wrapper bug.
- **Cold start:** csharp-ls indexes the full solution on first query. 30-120s is normal for mid-size .NET projects. Warm calls are sub-100ms.
- **Multi-solution workspaces:** walk-up stops at the FIRST `.slnx`/`.sln`/`.csproj`. For a workspace with nested solutions, pass the intended one explicitly:
  ```bash
  cs-direct start /abs/path/to/desired-solution-dir
  ```
- **`initializationOptions.csharp.solutionPathOverride`:** csharp-ls accepts this to pick a specific solution when multiple exist under rootUri. `cs-direct` doesn't wire it through currently — open an issue if you need it.

## Timing
- Cold: 30-120s (MSBuild solution load, NuGet restore if needed)
- Warm: ~70ms per call

## State directory
`~/.cache/cs-direct/<workspace-hash>/{pid,port,workspace,log}`

Inspect `log` if cold start hangs past 180s (the coordinator's own timeout) — MSBuild issues surface there.

## Roslyn LS scaffold (experimental, not yet wired)
`bin/cs-roslyn-direct` exists as a parallel wrapper targeting Microsoft Roslyn Language Server (the binary shipped with the VS Code C# Dev Kit at `~/.vscode/extensions/ms-dotnettools.csharp-*/.roslyn/Microsoft.CodeAnalysis.LanguageServer`) instead of csharp-ls. Goal: ~10× cold-start improvement on `documentSymbol` for mid-size .NET projects. **Currently NOT installed by `scripts/install.sh`** because the integration is blocked.

### Blocker
Roslyn LS issues a server→client `workspace/configuration` request during `OnInitializedAsync`. `bin/lsp-stdio-proxy.js` + `bin/adapters/lsp-stdio.js` + `bin/tool-server-proxy.js` are uni-directional (client→server only). Without a response, Roslyn LS hits `Contract.Fail` in `DidChangeConfigurationNotificationHandler.cs:128` and SIGABRTs. csharp-ls works because it does NOT issue reverse-RPC.

### Resumption path
Extend `bin/adapters/lsp-stdio.js` to detect server-initiated requests (incoming JSON-RPC with `method`+`id` but no `result`/`error`). Inject canned responses for known reverse-RPCs:
- `workspace/configuration` → return `[{}]` per item in `params.items` (empty config object array)
- `client/registerCapability` → return `null` (accept all dynamic registrations)
- `window/workDoneProgress/create` → return `null`

Alternative: forward server-initiated requests to a side-channel HTTP endpoint so the wrapper or upstream caller can respond.

After the proxy supports reverse-RPC, wire `cs-roslyn-direct` into `scripts/install.sh` as the recommended C# wrapper, deprecate `cs-direct`. Benchmark target: csharp-ls measured at ~2.18s on `documentSymbol` warm-call against a single-file project; Roslyn LS expected to land sub-300ms based on VS Code C# Dev Kit characteristics.
