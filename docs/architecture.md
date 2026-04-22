# Architecture

## Overview

```
      CLI caller (any shell / agent)
                 │
      ┌──────────┴──────────┐
      │ bash: <tool>-direct │
      └──────────┬──────────┘
                 │ HTTP POST /call  { method, params }
                 ▼
      ┌─────────────────────────────────────────────────────┐
      │ per-workspace Node coordinator                      │
      │                                                     │
      │   ┌─────────────────────────────────────────────┐   │
      │   │ tool-server-proxy.js  (child+framing+adopt) │   │  ← LSP, sbt, dotnet
      │   │            OR                               │   │
      │   │ node-formatter-daemon.js  (in-process)      │   │  ← prettier, eslint
      │   └───────────────────┬─────────────────────────┘   │
      │                       │ uses                        │
      │   ┌───────────────────▼─────────────────────────┐   │
      │   │ tool-harness.js                             │   │
      │   │ (resolveWorkspace, stateDir, adoptOrSpawn,  │   │
      │   │  serveHttp, invalidationLoop, callLog,      │   │
      │   │  framing readers/writers)                   │   │
      │   └─────────────────────────────────────────────┘   │
      │                       │                             │
      │                uses adapter                         │
      │   ┌───────────────────▼─────────────────────────┐   │
      │   │ adapters/<tool>.js                          │   │
      │   │ (per-tool protocol, children spec, init,    │   │
      │   │  message routing, call handler, triggers)   │   │
      │   └─────────────────────────────────────────────┘   │
      └─────────────────────────────────────────────────────┘
                 │
                 ▼ stdio / socket / in-process
      ┌─────────────────────────────────────────────────────┐
      │ backing tool(s)                                     │
      │ pyright / ts-ls / csharp-ls / jdtls / Vue LS +      │
      │ tsserver / sbt server / dotnet build-server /       │
      │ prettier lib / eslint lib / scalafmt-dynamic        │
      └─────────────────────────────────────────────────────┘
```

Three top-level node modules under `bin/`, sharing one harness:
- `tool-harness.js` — six primitives used by both the proxy and the daemon.
- `tool-server-proxy.js` — spawns and frames one or more external child processes, routes messages through an adapter. Used by LSPs (py/ts/cs/java/vue) and build servers (sbt, dotnet).
- `node-formatter-daemon.js` — loads a node library in-process (`require('prettier')`) and exposes it over HTTP. Used by formatters (prettier, eslint) and any other server-less-but-stay-open use case.

Per-tool behavior lives in `bin/adapters/<tool>.js`. New tools add an adapter, never a new coordinator.

## Harness primitives (`bin/tool-harness.js`)

```
resolveWorkspace(markers, argv) → absPath
  — walks up from cwd for any marker file; explicit --workspace arg wins.

stateDir(workspace, toolName) → path
  — ~/.cache/<toolName>-direct/<shasum12(absPath)>/. Same layout
    metals-direct and the current coordinators already use.

adoptOrSpawn({probe, spawn, stateDir}) → { children, adopted, cleanup }
  — probe() returns non-null if an external server for this workspace is
    already running (from an IDE, a prior session, etc.); if so, connect
    instead of spawning. spawn() otherwise creates new children.

serveHttp(port, onCall) → { listen, close }
  — loopback HTTP server with GET /health and POST /call { method, params }.
    onCall is adapter-provided.

invalidationLoop({ stateDir, softTriggers, hardTriggers, onSoft, onHard })
  — stat()s trigger files on every /call. mtime past stored baseline:
    soft → onSoft() (adapter-defined reload); hard → onHard() (restart
    coordinator). Baseline persisted in stateDir.

callLog(stateDir) → logger({ method, ms, adopted, invalidation_fired, outcome })
  — JSON-lines at <stateDir>/calls.log, one per /call. Zero-cost unless
    debugging; state-dir-scoped, never leaves the machine.

framing: { contentLength, jsonLine, tsserverMixed }
  — reader/writer pairs. contentLength = LSP standard.
    jsonLine = line-delimited JSON (sbt thin client style).
    tsserverMixed = tsserver's "either Content-Length-framed or plain \\n" wire.
```

The harness is pure mechanism — no policy. Adapters decide which primitives they compose.

## Server-proxy module (`bin/tool-server-proxy.js`)

`createProxy({ adapter })` wires an adapter to the harness:

1. `resolveWorkspace(adapter.markers)` from argv/cwd.
2. `adoptOrSpawn({ probe: adapter.adopt, spawn: adapter.spawn })` yields a
   list of child handles, each paired with a framed reader/writer from
   `harness.framing[adapter.children[i].frame]`.
3. Harness demuxes framed messages and hands each to
   `adapter.onChildMessage(childId, msg, ctx)`. `ctx` exposes:
   - `send(childId, msg)` — write a framed message to that child.
   - `request(childId, method|command, params)` — write + return a Promise
     that resolves when a response with matching id/seq arrives.
   - `state` — adapter-scoped map for bridging tables, opened-URI sets, etc.
4. After spawn, harness awaits `adapter.init(ctx)` — adapter-owned
   orchestration (e.g. vue does configurePlugin → warmup → initVue).
5. `serveHttp(port, (req) => adapter.call(req, ctx))` — adapter handles
   each POST /call.
6. `invalidationLoop` wired to `adapter.triggers` and `adapter.reload()`;
   soft-reload unsupported → falls back to hard restart.
7. Signal handlers kill all children on SIGTERM/SIGINT.

### Adapter contract

```
{
  name: 'lsp-stdio' | 'vue-hybrid' | 'sbt-thin' | 'dotnet-bs' | …,
  markers: string[],                              // workspace walk-up
  children: [
    {
      id: string,                                  // stable key for send/onChildMessage
      cmd: string, args: string[],
      cwd?: string, env?: object,
      frame: 'contentLength' | 'jsonLine' | 'tsserverMixed',
    },
    …
  ],
  spawn(workspace, stateDir) → ChildSpec[],        // derives from `children` + workspace
  adopt?(workspace, stateDir) → ChildHandle[] | null,
  init(ctx) → Promise<void>,                       // pre-serve handshake orchestration
  onChildMessage(childId, msg, ctx) → void,        // routing + bridging
  ensureOpen?(uri, ctx) → Promise<void>,           // optional auto-open hook
  call(req, ctx) → Promise<result>,                // POST /call body
  triggers: { soft: string[], hard: string[] },
  reload?(ctx) → Promise<void>,                    // absent → hard restart on soft
  didChangeConfigurationSupported?: boolean,       // LSP-specific opt-out
}
```

### How this satisfies lsp-stdio

One child, `contentLength` framing, init sends `initialize` + `initialized`,
`onChildMessage` handles responses (match id against `ctx.pending`),
null-acks server-initiated requests, drops notifications.
`call(req)` invokes `ctx.ensureOpen(req.params.textDocument.uri)` then
`ctx.request('lsp', req.method, req.params)`.
~80 lines of adapter vs. 225 in the current monolithic proxy.

### How this satisfies vue-hybrid

Two children: `vue-ls` (contentLength) + `tsserver` (tsserverMixed).
`init` runs configurePlugin on ts, awaits `projectInfo` warmup via a
`.ts` file found under `workspace/src`, then LSP-initializes vue.
`onChildMessage('vue', msg)` for a `tsserver/request` notification unwraps
the tuple, allocates a ts seq, stores `{ tsSeq → vueReqId }` in
`ctx.state.bridge`, and calls `ctx.send('ts', { type: 'request', ... })`.
`onChildMessage('ts', msg)` for `type:'response'` looks up the seq in the
bridge map and calls `ctx.send('vue', { method: 'tsserver/response',
params: [[vueReqId, msg.body]] })` (note: double-wrap array per
vscode-jsonrpc convention, see Gotchas).
`call(req)` mirrors lsp-stdio's flow against the `vue` child.

The adapter surface accommodates vue's bidirectional bridging without any
vue-shaped primitive bleeding into the harness. If it didn't, we'd
redesign before extraction.

## Formatter-daemon module (`bin/node-formatter-daemon.js`)

`createDaemon({ adapter })` — same harness primitives minus the
child-process + framing bits:

```
{
  name: 'prettier' | 'eslint' | …,
  markers: string[],
  preload() → pkg,                                 // require('prettier') once
  call(req, { pkg, state }) → Promise<result>,
  triggers: { soft: string[], hard: string[] },
  reload?() → void,                                // `delete require.cache[...]` or re-require
}
```

`resolveWorkspace` + `stateDir` + `serveHttp` + `invalidationLoop` +
`callLog` are shared. No `adoptOrSpawn` (nothing to adopt). No framing
(in-process).

This split exists because the proxy's essential job is "frame + adopt + route";
a formatter daemon has neither external children to frame nor an existing
process to adopt. Forcing the formatter into the proxy would require stubs
(`children: []`, no-op framing) that smell worse than a second module.

## Per-workspace state

```
~/.cache/<name>-direct/<shasum-12>/
├── pid              coordinator pid
├── port             loopback port
├── workspace        absolute workspace path
├── log              coordinator stderr
├── calls.log        structured per-call JSON lines (NEW — opt-out via env)
└── triggers.json    last-seen mtime per invalidation trigger (NEW)
```

Each workspace gets its own slot. No cross-workspace state. Switching
between projects within a session is free (`call` auto-starts the
matching slot).

## Invalidation

Every `/call` traverses `adapter.triggers`, stats each path relative to
the workspace, and compares against `triggers.json`:

- Soft trigger changed: `adapter.reload(ctx)`. LSP adapters send
  `workspace/didChangeConfiguration` and `workspace/didChangeWatchedFiles`.
  Adapter may set `didChangeConfigurationSupported: false` to fall back
  to hard restart (used where the backing server ignores the LSP
  notification).
- Hard trigger changed: coordinator restarts — all children die, the
  proxy module re-runs init, adoption is re-attempted.

Trigger sets are adapter-declared; see per-language docs.

## Design decisions

- **HTTP, not Unix socket.** Loopback HTTP adds sub-ms overhead vs.
  socket, but works everywhere (Docker, sandboxed environments, remote
  dev over a tunnel) without permission gymnastics.
- **Per-workspace process, not shared.** Backing servers accumulate
  stale state over time; isolating by workspace keeps restarts cheap
  and fixes servers that bind rootUri at init.
- **Three modules, one harness.** The proxy covers tools that expose a
  stdio or socket client protocol. The daemon covers tools whose
  "protocol" is a node library function. Forcing both into one module
  costs clarity; sharing the harness costs nothing.
- **Adapters own orchestration.** The harness provides primitives; the
  adapter decides init order, message routing, and call semantics. This
  is why vue's warmup-before-init and lsp-stdio's initialize-first fit
  the same proxy without conditional branches in the proxy itself.
- **HTTP liveness probe, not kill -0.** Sandboxed environments may deny
  cross-pid signal delivery. `curl -fsS GET /health` works everywhere.
- **Adoption-first lifecycle.** Every adapter may implement `adopt()` to
  attach to an externally-running server (IDE, prior session). Cold
  spawn is the fallback, not the default.

## Module-to-wrapper mapping

| wrapper | module | adapter | backing tool |
|---|---|---|---|
| py-direct | tool-server-proxy | adapters/lsp-stdio.js | pyright-langserver |
| ts-direct | tool-server-proxy | adapters/lsp-stdio.js | typescript-language-server |
| cs-direct | tool-server-proxy | adapters/lsp-stdio.js | csharp-ls |
| java-direct | tool-server-proxy | adapters/lsp-stdio.js | jdtls |
| vue-direct | tool-server-proxy | adapters/vue-hybrid.js | vue-language-server + tsserver |
| metals-direct | (independent MCP HTTP client) | — | metals-mcp |
| sbt-direct | tool-server-proxy | adapters/sbt-thin-client.js | sbt thin client (ipcsocket) |
| dotnet-direct | tool-server-proxy | adapters/dotnet-build-server.js | dotnet build-server |
| prettier-direct | node-formatter-daemon | adapters/prettier.js | prettier (in-process) |
| eslint-direct | node-formatter-daemon | adapters/eslint.js | eslint (in-process) |
| scalafmt-direct | tool-server-proxy | adapters/scalafmt-dynamic.js | scalafmt-dynamic JVM |

`bin/lsp-stdio-proxy.js` and `bin/vue-direct-coordinator.js` are
preserved as 3-line shims composing harness + proxy + their adapter, so
any external node importer keeps working.

## Gotchas

- **vscode-jsonrpc array-params double-wrap.** When an LSP peer sends
  `connection.sendNotification(method, [a, b, c])`, vscode-jsonrpc wraps
  the array in another array for wire transport. Receivers see
  `params: [[a, b, c]]`, not `params: [a, b, c]`. The vue-hybrid
  adapter unwraps conditionally; `tsserver/response` writes must
  double-wrap.
- **Empty bash array under `set -u`.** Expanding `"${arr[@]}"` when
  `arr=()` errors "unbound variable" under strict mode. Use
  `${arr[@]+"${arr[@]}"}` to expand-if-set.
- **ipcsocket dylib extraction.** sbt's thin client extracts a native
  `libsbtipcsocket*.dylib` to `$TMPDIR` on first invocation; sandboxed
  shells may deny execution. The sbt-thin adapter starts the
  coordinator with a relaxed-sandbox spawn hook once; subsequent
  loopback HTTP calls run fully sandboxed.
- **tsserver mixed framing.** tsserver may emit either
  `Content-Length`-framed or plain `\n`-delimited JSON. The
  `tsserverMixed` framer handles both.
- **adopt vs. spawn split.** An adopted server outlives the coordinator;
  `coordinator stop` on an adopted slot unregisters state but does not
  kill the backing process (it's the user's).

See `docs/troubleshooting.md` for the full pitfall catalog.
