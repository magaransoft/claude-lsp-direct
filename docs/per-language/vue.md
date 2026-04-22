# Vue — `vue-direct`

Proxies Vue Language Server v3 + a paired tsserver hosting `@vue/typescript-plugin` over HTTP. Uses a dedicated hybrid coordinator (`vue-direct-coordinator.js`) rather than the generic `lsp-stdio-proxy.js`, because Vue LS v3 is hybrid-mandatory.

## Op-surface note

`textDocument/documentSymbol` is the canonical probe and is baselined
by `scripts/verify.sh`. Semantic queries that depend on the virtual-
file bridge (`textDocument/hover`, `textDocument/definition`,
`textDocument/references`) may return `null` / `[]` depending on how
long tsserver + `@vue/typescript-plugin` take to fully materialize the
.vue's virtual .ts module. This behavior is identical pre- and post-
refactor (verified by diffing against the `pre-refactor` tag on a real
Vue 3 / Quasar project — both returned null for the same hover
position). When affected, waiting 5-10s after the first `didOpen`
before issuing hover/definition usually resolves it.

## Install prereq
```bash
npm i -g @vue/language-server@3.2.6 \
         @vue/typescript-plugin@3.2.6 \
         typescript@5.9.3
```
Version pinning matters — Vue LS + TS plugin must match. Check compatibility for other versions before upgrading.

Verify: `vue-language-server --version` (should print `3.2.6`).

## Workspace markers (walk-up order)
1. `package.json`

(`tsconfig.json` is detected transitively by tsserver once the package root is known; no separate walk-up needed.)

## Invocation
```bash
vue-direct start                                                 # cwd walk-up
vue-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///abs/path/to/Component.vue"}}'

vue-direct call textDocument/hover \
  '{"textDocument":{"uri":"file:///abs/path/to/Component.vue"},
    "position":{"line":15,"character":8}}'
```

## The hybrid protocol
Vue LS v3 architecturally requires a paired tsserver with `@vue/typescript-plugin` loaded. Semantic ops (`textDocument/hover`, `textDocument/definition`, etc.) work as follows:

```
vue-direct
    ↓ HTTP POST /lsp
coordinator
    ↓ LSP textDocument/hover
Vue Language Server (stdio)
    ↓ sends notification tsserver/request [id, "_vue:hover", args]
coordinator (bridge)
    ↓ translates to tsserver JSON-RPC request { seq, type:"request", command:"_vue:hover", arguments:args }
tsserver + @vue/typescript-plugin (stdio)
    ↓ plugin handles _vue:* command, returns tsserver response
coordinator (bridge)
    ↓ sends notification tsserver/response [id, body] back to Vue LS
Vue Language Server
    ↓ resolves the LSP hover request
coordinator
    ↑ HTTP 200 { result: ... }
vue-direct
```

All of this lives inside `bin/vue-direct-coordinator.js`. No per-user config.

## Quirks
- **vscode-jsonrpc double-wrapping:** Vue LS sends `connection.sendNotification('tsserver/request', [id, cmd, args])`. vscode-jsonrpc wraps the array param, so the coordinator receives `params: [[id, cmd, args]]`. The coordinator unwraps conditionally. See `docs/troubleshooting.md`.
- **Warmup required:** the coordinator opens a seed `.ts` file from the workspace `src/` directory at startup to force tsserver to load the project; otherwise the first `textDocument/hover` on a `.vue` file may fail because the tsconfig project isn't materialized yet. Automatic — no user action required.
- **Cold start:** Vue LS + tsserver + tsconfig load + warmup scan = 5-10s first call. Warm calls are sub-100ms.
- **SFC script+template only:** Vue LS handles `<script setup>`, `<script>`, `<template>`. Style blocks (`<style>`) are passed through but not semantically analyzed.

## Timing
- Cold: 5-10s
- Warm: ~70-100ms per call (slightly higher than py/ts because Vue LS returns richer SFC-aware symbols)

## State directory
`~/.cache/vue-direct/<workspace-hash>/{pid,port,workspace,log}`
