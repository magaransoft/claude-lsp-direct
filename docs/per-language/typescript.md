# TypeScript / JavaScript — `ts-direct`

Proxies `typescript-language-server` over HTTP. One server per workspace. Handles `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`.

## Install prereq
```bash
npm i -g typescript-language-server typescript
```
Verify: `typescript-language-server --version` (should print semver e.g. `5.1.3`).

## Workspace markers (walk-up order)
1. `tsconfig.json`
2. `package.json`

## Invocation
```bash
ts-direct start                                                  # cwd walk-up
ts-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///abs/path/to/file.ts"}}'

ts-direct call textDocument/references \
  '{"textDocument":{"uri":"file:///abs/path/to/file.ts"},
    "position":{"line":20,"character":10},
    "context":{"includeDeclaration":true}}'

ts-direct call workspace/symbol '{"query":"UserStore"}'

# multi-file fan-out (1 HTTP roundtrip + 1 tool_result for N files)
ts-direct batch textDocument/documentSymbol \
  /abs/path/to/A.ts /abs/path/to/B.ts /abs/path/to/C.ts

# raw multi-call (mixed methods)
ts-direct batch-json '[
  {"method":"workspace/symbol","params":{"query":"UserStore"}},
  {"method":"textDocument/hover","params":{"textDocument":{"uri":"file:///abs/x.ts"},"position":{"line":0,"character":0}}}
]'
```

When querying >=2 files with the same method, callers MUST use `batch` (or `batch-json`) — the `enforce-batch-on-direct-call.py` PreToolUse hook blocks 2nd same-method `call` within 60s. Per-call envelope `{ok:true,value}|{ok:false,error}` returned per sub-call so one bad uri NEVER poisons siblings.

## Op surface
Every standard LSP 3.17 method typescript-language-server implements, plus tsserver-specific commands via `workspace/executeCommand`.

## Quirks
- **rootUri must not be null:** `typescript-language-server` rejects null rootUri at init. `lsp-stdio-proxy.js` always sets it from `--workspace`, so this is transparent when invoked via `ts-direct`.
- **Monorepo tsconfig selection:** walk-up stops at the FIRST `tsconfig.json`. In a monorepo with nested packages (`packages/foo/tsconfig.json`, `packages/bar/tsconfig.json`, plus a root `tsconfig.json`), starting from `packages/foo/src/` picks `packages/foo/tsconfig.json`. Start from the repo root to pick the root tsconfig.
- **Tsserver plugins:** `typescript-language-server` does not load tsserver plugins from `tsconfig.json compilerOptions.plugins` unless explicitly configured via `initializationOptions.plugins`. If you need a plugin (e.g. styled-components, graphql), extend the spawn call in `ts-direct` or open an issue.
- **Memory:** on large monorepos tsserver can consume 2-4GB. `lsp-stdio-proxy.js` does not pass `maxTsServerMemory` by default — add it via `initializationOptions` if you hit OOM.

## Timing
- Cold: 0.2-1s (tsserver init + tsconfig load)
- Warm: ~70ms per call

## State directory
`~/.cache/ts-direct/<workspace-hash>/{pid,port,workspace,log}`
