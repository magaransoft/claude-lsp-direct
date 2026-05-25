# Node formatters — `prettier-direct`, `eslint-direct`

Per-workspace daemons wrapping node formatter/linter libraries
in-process. The library is `require()`d once at daemon start; every
`call` runs a pure-function against the warm module reference.

Share the `node-formatter-daemon.js` coordinator — sibling of
`tool-server-proxy.js` on the same `tool-harness.js` primitives.

## Install prereq

Workspace-local is preferred (so prettier/eslint pick up the project's
pinned version):

```bash
pnpm add -D prettier            # or npm i -D prettier
pnpm add -D eslint              # or npm i -D eslint
```

Global fallback — daemons fall back to globally-installed packages
if workspace resolution fails:

```bash
npm i -g prettier eslint
```

## Workspace markers

- `prettier-direct`: `.prettierrc*`, `prettier.config.*`, `package.json`
- `eslint-direct`: `eslint.config.*`, `.eslintrc*`, `package.json`

## `prettier-direct` methods

| method | params | returns |
|---|---|---|
| version | `{}` | `{version}` |
| format | `{source, filepath?, options?}` | `{formatted}` |
| check | `{source, filepath?, options?}` | `{matches}` |
| format-file | `{filepath}` | `{filepath, formatted, changed}` — resolves config + formats |
| format-files | `{files: [abs-path...]}` | `{results: [{ok:true,filepath,formatted,changed}|{ok:false,filepath,error}]}` |
| check-files | `{files: [abs-path...]}` | `{results: [{ok:true,filepath,matches}|{ok:false,filepath,error}]}` |
| resolve-config | `{filepath}` | `{config}` |

## `eslint-direct` methods

| method | params | returns |
|---|---|---|
| version | `{}` | `{version}` |
| lint-text | `{source, filepath?, engineOptions?}` | `{results}` — ESLint LintResult[] |
| lint-files | `{patterns: [glob...], engineOptions?}` | `{results}` |
| fix-text | `{source, filepath?, engineOptions?}` | `{output, changed, results}` |
| format-results | `{results, formatterName?}` | `{formatted}` — stylish text |

## Multi-call fan-out (`batch-json`)

Both daemons expose `POST /batch` via the harness. Use `batch-json` for mixed-method fan-out:

```bash
prettier-direct batch-json '[
  {"method":"format-file","params":{"filepath":"/abs/A.ts"}},
  {"method":"format-file","params":{"filepath":"/abs/B.ts"}}
]'

eslint-direct batch-json '[
  {"method":"lint-files","params":{"patterns":["src/a/**/*.ts"]}},
  {"method":"lint-files","params":{"patterns":["src/b/**/*.ts"]}}
]'
```

Returns `{results:[{ok:true,value}|{ok:false,error}]}` per sub-call so one bad path NEVER poisons siblings. The file-positional `batch <method> <file>...` convenience is NOT exposed — prettier/eslint methods already accept file lists or globs natively (`format-files`, `check-files`, `lint-files`); use those directly when applicable. The `enforce-batch-on-direct-call.py` PreToolUse hook blocks 2nd same-method `call` within 60s — switch to `batch-json` (or to a multi-file method like `format-files`/`lint-files`) instead.

## Timing

| stage | prettier | eslint |
|---|---|---|
| daemon preload | ~100ms | ~300ms |
| warm call | <50ms | <150ms |

## Invalidation matrix

| type | files | action |
|---|---|---|
| soft (both) | config files, `.prettierignore`/`.eslintignore` | next call picks up (prettier.resolveConfig per-call; eslint engine rebuilt on reload) |
| hard (both) | `.env`, `.env.local`, `package.json` | daemon restart (dependency graph changed) |

## State directory

```
~/.cache/{prettier,eslint}-direct/<workspace-hash>/
├── pid           daemon pid
├── port          loopback port
├── workspace     absolute workspace path
├── log           daemon stderr
├── calls.log     per-call JSON lines
└── triggers.json mtime baseline
```

## Quirks

- Workspace-local package resolution uses `require.resolve('prettier',
  { paths: [workspace] })`. Monorepos with hoisted deps
  (`node_modules/.pnpm/*`) may resolve to a parent directory's
  install; usually fine but can surprise if versions differ.
- `lint-files` patterns are resolved relative to the workspace cwd,
  not the caller's cwd.
