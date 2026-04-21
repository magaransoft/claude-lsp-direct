# Python — `py-direct`

Proxies `pyright-langserver` over HTTP. One server per workspace.

## Install prereq
```bash
npm i -g pyright
```
Verify: `pyright-langserver --version` (actually returns the stdio connection error — pyright-langserver has no `--version`; if you see that error, the binary is reachable).

## Workspace markers (walk-up order)
1. `pyrightconfig.json`
2. `pyproject.toml`
3. `setup.cfg`
4. `setup.py`

If none found, wrapper uses current working directory.

## Invocation
```bash
py-direct start                                                   # cwd walk-up
py-direct start /abs/path/to/project                              # explicit
py-direct call textDocument/documentSymbol \
  '{"textDocument":{"uri":"file:///abs/path/to/file.py"}}'

py-direct call textDocument/hover \
  '{"textDocument":{"uri":"file:///abs/path/to/file.py"},
    "position":{"line":10,"character":5}}'

py-direct call workspace/symbol '{"query":"UserModel"}'
```

## Op surface
Standard LSP 3.17 methods pyright implements:
`textDocument/documentSymbol`, `textDocument/hover`, `textDocument/definition`, `textDocument/references`, `textDocument/implementation`, `textDocument/typeDefinition`, `textDocument/completion`, `textDocument/signatureHelp`, `textDocument/prepareCallHierarchy`, `callHierarchy/incomingCalls`, `callHierarchy/outgoingCalls`, `workspace/symbol`, `textDocument/foldingRange`, `textDocument/semanticTokens/full`.

## Quirks
- **No config fallback:** pyright works against loose `.py` files without any `pyproject.toml` by treating each file as its own inferred project. Less accurate cross-file type inference but still answers `documentSymbol` / `hover`.
- **Stub packages:** if your project uses typed stubs (e.g. `types-requests`), pyright reads `pyproject.toml` `[tool.pyright]` config. Pin `typeCheckingMode`, `venvPath`, etc. there — `py-direct` has no way to override them per call.
- **Slow on large projects:** cold start re-indexes all `.py` files in the workspace. Typical warm latency is sub-100ms; cold can be 1-5s for mid-size repos.

## Timing (rough, on a modern laptop)
- Cold: 0.1-0.5s (pyright init, per-file lazy-load)
- Warm: ~70ms per call (HTTP round-trip dominates)

## State directory
`~/.cache/py-direct/<workspace-hash>/{pid,port,workspace,log}`

Inspect `log` if startup fails.
