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

## Roslyn LS — `cs-roslyn-direct`
Alongside `cs-direct` (csharp-ls), `bin/cs-roslyn-direct` ships as a parallel wrapper targeting Microsoft Roslyn Language Server (the binary shipped with the VS Code C# Dev Kit at `~/.vscode/extensions/ms-dotnettools.csharp-*/.roslyn/Microsoft.CodeAnalysis.LanguageServer`). Both wrappers install unconditionally via `scripts/install.sh`; operators pick at INVOKE time (`cs-direct` vs `cs-roslyn-direct`). State dirs are separate (`~/.cache/cs-direct/` vs `~/.cache/cs-roslyn-direct/`), so there is no port or pid collision.

### Install prereq
```bash
# VS Code C# Dev Kit ships the Roslyn LS binary; no separate install
code --install-extension ms-dotnettools.csharp
# Or set CS_ROSLYN_BIN to point at a Microsoft.CodeAnalysis.LanguageServer absolute path.
```

### Invocation
```bash
cs-roslyn-direct start                                          # cwd walk-up for .slnx/.sln/.csproj
cs-roslyn-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///abs/path/to/File.cs"}}'
```

The CLI surface mirrors `cs-direct` — `start`, `call`, `tools`, `batch`, `batch-json`, `stop`, `status`, `prune`.

### Quirks
- **`window/showMessageRequest` null-dismissal:** Roslyn LS may issue server→client dialog requests (e.g. "Switch to Debug build? [Yes / No]"). The default response is `null` — equivalent to the user dismissing the dialog without picking an action. Every dismissal emits a stderr line:
  ```
  [cs-roslyn] showMessageRequest dismissed: title="..." actions=[0:Yes,1:No] — set CS_ROSLYN_MESSAGE_RESPONSE=<idx> to auto-pick
  ```
  Set `CS_ROSLYN_MESSAGE_RESPONSE=<idx>` to auto-pick `params.actions[idx]` for the next invocation. The env var applies per invocation and is reversible without a code edit.
- **Reverse-RPC handler set (5 methods):** `workspace/configuration` (returns `[{}]` per item), `workspace/workspaceFolders`, `client/registerCapability` (null), `window/workDoneProgress/create` (null), `window/showMessageRequest` (above). Server-initiated requests outside this set get JSON-RPC `-32601 Method not found` per the method-class-aware default (ADR-002 of `roslyn-reverse-rpc-lsp-stdio.md`). The count surfaces in `cs-roslyn-direct status` via the proxy `/status` endpoint and in `lsp-week.sh` under `unknown_server_requests`.
- **Cold start:** measured ~1.28s p50 against the fixtures/csharp single-file workspace (2026-05-25). Larger solutions remain to be benchmarked.

### Benchmarks
| wrapper | fixture | cold_ms_p50 | cold_ms_p99 | n | timestamp |
|---|---|---:|---:|---:|---|
| cs-direct (csharp-ls) | fixtures/csharp | 2440 | 2441 | 2 | 2026-05-25T14:24:49Z |
| cs-roslyn-direct (Roslyn LS) | fixtures/csharp | 1279 | 1310 | 2 | 2026-05-25T17:50:24Z |

Roslyn LS lands ~1.9× faster cold-start than csharp-ls on the single-file fixture. Real-solution measurements will be added per the 7-day post-merge observation window (ADR-005 graduation gate).

### State directory
`~/.cache/cs-roslyn-direct/<workspace-hash>/{pid,port,workspace,log}` — disjoint from `~/.cache/cs-direct/`.
