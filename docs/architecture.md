# Architecture

## Overview

```
         CLI caller (any shell / agent)
                    │
         ┌──────────┴──────────┐
         │ bash: <lang>-direct │
         └──────────┬──────────┘
                    │ HTTP POST /lsp
                    │  { method, params }
                    ▼
         ┌──────────────────────┐
         │ Node coordinator     │    (shared: lsp-stdio-proxy.js
         │ per-workspace        │     OR vue-direct-coordinator.js
         │ loopback HTTP server │     for hybrid case)
         └──────────┬───────────┘
                    │ stdio JSON-RPC (Content-Length framed)
                    ▼
         ┌──────────────────────┐
         │ LSP server           │
         │ (pyright / ts-ls /   │
         │  csharp-ls / Vue LS) │
         └──────────────────────┘
```

## Components

### `bin/<lang>-direct` — bash wrapper
Thin layer. Resolves workspace (walk-up for language-specific markers), derives per-workspace state dir from `shasum` of the absolute path, manages lifecycle (start/stop/status), shells `curl` against the coordinator for `call`.

Why bash: zero runtime, works out of the box on macOS + Linux, no package install.

### `bin/lsp-stdio-proxy.js` — shared Node coordinator
Generic coordinator for any STANDALONE stdio LSP (python, typescript, csharp, and future additions like Go/Rust/Ruby). Args:
```
node lsp-stdio-proxy.js --workspace <path> --port <N> --lang-id <id> -- <lsp-cmd> [<lsp-args>...]
```
Responsibilities:
- Spawn the LSP child with workspace as cwd
- Frame LSP traffic (Content-Length + JSON body)
- Run LSP `initialize` handshake with proper `rootUri`, `rootPath`, `workspaceFolders`
- Expose `POST /lsp { method, params }` → forward to server → return result
- Expose `GET /health` → 200
- Auto-open referenced files via `textDocument/didOpen` before the first query (derives `languageId` from file extension)
- Handle server-initiated requests with null-ack (so the server doesn't hang on workspace/configuration)

### `bin/vue-direct-coordinator.js` — hybrid coordinator
Specific to Vue Language Server v3, which architecturally requires a paired tsserver hosting `@vue/typescript-plugin`. Spawns both children, bridges `tsserver/request` ↔ `tsserver/response` LSP notifications between them, warms the project via a seed `.ts` file from the workspace.

See `docs/per-language/vue.md` for the hybrid protocol.

## Per-workspace state
```
~/.cache/<name>-direct/<shasum-12>/
├── pid         coordinator pid
├── port        loopback port
├── workspace   absolute workspace path
└── log         coordinator stderr (for debugging failed starts)
```
Each workspace gets its own slot. No cross-workspace state. Switching between projects within a session is free (`call` auto-starts the matching slot).

## Design decisions
- **HTTP, not Unix socket.** Loopback HTTP adds sub-ms overhead vs socket, but works everywhere (Docker, sandboxed environments, remote dev over a tunnel) without permission gymnastics.
- **Per-workspace process, not shared.** LSP servers accumulate stale state over time; isolating by workspace keeps restarts cheap and fixes servers that bind rootUri at init.
- **Auto-open files.** The coordinator reads the referenced file and sends `didOpen` before the first `textDocument/*` call. Removes a boilerplate step the caller would otherwise have to do.
- **No session persistence.** Each `call` is stateless from the caller's perspective. The server process is persistent; the CLI call isn't.
- **HTTP liveness probe, not kill -0.** Sandboxed environments may deny cross-pid signal delivery. `curl -fsS GET /health` works everywhere.

## Gotchas
- **vscode-jsonrpc array-params double-wrap.** When an LSP peer sends `connection.sendNotification(method, [a, b, c])`, vscode-jsonrpc wraps the array in another array for wire transport. Receivers see `params: [[a, b, c]]`, not `params: [a, b, c]`. Vue coordinator unwraps conditionally.
- **Empty bash array under `set -u`.** Expanding `"${arr[@]}"` when `arr=()` errors "unbound variable" under strict mode. Use `${arr[@]+"${arr[@]}"}` to expand-if-set.

See `docs/troubleshooting.md` for the full pitfall catalog.
