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
| resolve-config | `{filepath}` | `{config}` |

## `eslint-direct` methods

| method | params | returns |
|---|---|---|
| version | `{}` | `{version}` |
| lint-text | `{source, filepath?, engineOptions?}` | `{results}` — ESLint LintResult[] |
| lint-files | `{patterns: [glob...], engineOptions?}` | `{results}` |
| fix-text | `{source, filepath?, engineOptions?}` | `{output, changed, results}` |
| format-results | `{results, formatterName?}` | `{formatted}` — stylish text |

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
