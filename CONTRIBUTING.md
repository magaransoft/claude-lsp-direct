# Contributing

## Adding a new language

Minimal steps for a standard stdio LSP (server speaks LSP over `--stdio`, no hybrid coordination):

### 1. Copy the template
```bash
cp bin/py-direct bin/<lang>-direct
```

### 2. Update the template vars at the top of the bash file
```bash
STATE_ROOT="${<LANG>_DIRECT_STATE:-$HOME/.cache/<lang>-direct}"
PROXY="$HOME/.claude/bin/lsp-stdio-proxy.js"   # leave as-is for standalone LSPs
LSP_BIN="<language-server-binary>"             # e.g. gopls, rust-analyzer
LSP_ARGS=(--stdio)                              # or () if the server has no args
LANG_ID="<lsp-language-id>"                    # go / rust / ruby / etc.
WORKSPACE_MARKERS=(<markers in walk-up order>)  # e.g. go.mod, Cargo.toml
```

### 3. Update help banner + install-prereq message
Search `bin/<lang>-direct` for the old binary name and replace.

### 4. Add a fixture
```bash
mkdir -p fixtures/<lang>
# create a minimal 1-file sample + whatever manifest the language needs
# (e.g. fixtures/go/main.go + fixtures/go/go.mod)
```

### 5. Add a doc page
```bash
cp docs/per-language/python.md docs/per-language/<lang>.md
# rewrite: install prereq, workspace markers, invocation examples, quirks
```

### 6. Extend hook integration (optional)
`hooks/enforce-lsp-over-grep.py` → `LANG_DIRECT_WRAPPER` dict:
```python
LANG_DIRECT_WRAPPER = {
    ...
    "<lang>": ("<lang>-direct", "<binary-name>"),
}
```
Also extend `EXT_LANG`, `RG_TYPE_LANG`, and `POS_CODE_FILE_RE` to include the new file extensions.

### 7. Add CI matrix entry
`.github/workflows/ci.yml` — add a step that installs `<binary>` and runs `scripts/verify.sh` on the fixture.

### 8. Update README.md + docs/convention.md
Add the new language to the primary-path table.

## Hybrid servers (require paired processes)

If the target LSP requires a paired companion process (like Vue LS v3 + tsserver + `@vue/typescript-plugin`), the generic `lsp-stdio-proxy.js` isn't enough. Write a dedicated coordinator modeled on `bin/vue-direct-coordinator.js`:
- Spawn both children
- Bridge any custom cross-server notifications
- Expose the same HTTP surface (`POST /lsp`, `GET /health`)
- Wire the bash wrapper to point at your new coordinator instead of `lsp-stdio-proxy.js`

## Invariants

Every wrapper MUST:
- Live in `bin/<name>-direct`
- Expose `start | call | stop | status | tools [workspace]` and `call <method> '<json>' [workspace]`
- Use raw LSP method names (or the underlying tool's native command names)
- Use `curl -fsS GET /health` for liveness (never `kill -0` or `/dev/tcp`)
- Store per-workspace state in `~/.cache/<name>-direct/<hash>/{pid,port,workspace,log}`
- Work on macOS + Linux
- Not require any binary beyond `bash`, `node`, `python3`, `curl`, `jq`, standard POSIX utils, plus the language server itself

See [docs/convention.md](docs/convention.md) for the full list.

## PR checklist
- [ ] Wrapper follows the CLI contract above
- [ ] Fixture added with a minimal sample
- [ ] Doc page added under `docs/per-language/<lang>.md`
- [ ] CI job added for the new language
- [ ] README.md primary-path table updated
- [ ] `hooks/enforce-lsp-over-grep.py` extended (if the hook integration is in scope)
- [ ] `scripts/verify.sh` runs the new fixture successfully
- [ ] No personal paths, usernames, or project names in any file you touched — `grep -r "/Users/<user>\|/home/<user>\|<any real name>"` should return zero hits on your diff

## Reporting bugs
Please include:
- OS + version
- Language server name + version (`<binary> --version`)
- `~/.cache/<lang>-direct/<hash>/log` contents
- Exact command that failed
- Expected vs actual behavior
