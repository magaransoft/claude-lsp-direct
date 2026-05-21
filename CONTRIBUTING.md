# Contributing

## Architecture overview

The coordinator is split into three modules sharing one harness:

- `bin/tool-harness.js` — six primitives: `resolveWorkspace`,
  `stateDir`, `serveHttp`, `invalidationLoop`, `callLog`, plus
  framing readers/writers (contentLength, jsonLine, tsserverMixed).
- `bin/tool-server-proxy.js` — coordinator for tools with an external
  child process (LSPs, build tools). Adapters declare `children[]`
  + `init` + `onChildMessage` + `call` + `triggers`.
- `bin/node-formatter-daemon.js` — coordinator for in-process Node
  libraries (prettier, eslint). Adapters declare `preload(workspace)`
  → pkg + `call(req, {pkg, state})`.

See `docs/architecture.md` for the full adapter contract.

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

### 9. Expose batch subcommands
Every wrapper backed by `tool-server-proxy.js` or `node-formatter-daemon.js` (i.e. anything that ships `cmd_call` posting to `/call`) MUST also ship `cmd_batch_json` posting to `/batch`. LSP-shaped wrappers (the backing protocol is per-textDocument) MUST additionally ship `cmd_batch <method> <file>...` building `{textDocument:{uri:"file://<abs>"}}` per file. Workspace MUST be derived from `dirname` of the first file (`resolve_workspace "$first_dir"`), NEVER from `$PWD` via empty `resolve_workspace ""`.

Template (LSP-shaped):
```bash
cmd_batch() {
  local method="${1:-}"; shift || true
  [ -z "$method" ] && die "usage: <lang>-direct batch <method> <file>..."
  [ "$#" -eq 0 ] && die "batch requires >=1 file path"
  local files=()
  local f abs dir base
  for f in "$@"; do
    case "$f" in
      /*) abs="$f" ;;
      *) dir="$(cd "$(dirname -- "$f")" 2>/dev/null && pwd)" || die "cannot resolve directory of $f"
         base="$(basename -- "$f")"; abs="$dir/$base" ;;
    esac
    files+=("$abs")
  done
  local first_dir ws state port calls_json payload
  first_dir="$(dirname -- "${files[0]}")"
  ws="$(resolve_workspace "$first_dir")"
  state="$(state_dir "$ws")"
  server_alive "$state" || { cmd_start "$ws" >&2; }
  port="$(state_get "$state" port)"
  calls_json="$(printf '%s\n' "${files[@]}" | jq -R -s -c --arg m "$method" '
    split("\n") | map(select(length>0)) | map({method: $m, params: {textDocument: {uri: ("file://" + .)}}})
  ')"
  payload="$(jq -cn --argjson calls "$calls_json" '{calls:$calls}')"
  curl -fsS -m 600 "http://localhost:$port/batch" -X POST -H 'Content-Type: application/json' -d "$payload"
  echo
}

cmd_batch_json() {
  local calls_json="${1-}"; shift || true
  [ -z "$calls_json" ] && die "usage: <lang>-direct batch-json '<json-array>'"
  local ws state port payload
  ws="$(resolve_workspace "${1:-}")"
  state="$(state_dir "$ws")"
  server_alive "$state" || { cmd_start "$ws" >&2; }
  port="$(state_get "$state" port)"
  payload="$(jq -cn --argjson calls "$calls_json" '{calls:$calls}')"
  curl -fsS -m 600 "http://localhost:$port/batch" -X POST -H 'Content-Type: application/json' -d "$payload"
  echo
}
```

Wire into the case statement: `batch) shift; cmd_batch "$@" ;;` and `batch-json) shift; cmd_batch_json "$@" ;;`. Update `cmd_tools` text to advertise both. Non-LSP wrappers (formatters, build tools) ship `cmd_batch_json` only — `batch <method> <file>...` makes no sense for project-grain verbs.

Transport-incompatible wrappers (e.g. scala-direct talks MCP, not `/batch`) MAY skip both — document the reason in the wrapper's `cmd_tools` block so the omission is intentional, not accidental.

## Hybrid servers (require paired processes)

If the target LSP requires a paired companion process (like Vue LS v3 + tsserver + `@vue/typescript-plugin`), the generic `lsp-stdio-proxy.js` isn't enough. Write a dedicated adapter in `bin/adapters/<name>.js` declaring two child specs:

```js
spawn(workspace) {
  return [
    { id: 'main', frame: 'contentLength', cmd: 'main-ls', args: ['--stdio'] },
    { id: 'helper', frame: 'tsserverMixed', cmd: 'node', args: [...] },
  ];
}
```

Adapter `onChildMessage(childId, msg, ctx)` handles cross-child routing;
`ctx.state` stores bridge tables. See `bin/adapters/vue-hybrid.js` for
the Vue LS v3 + tsserver bridging pattern.

Compose into `bin/<name>-direct-coordinator.js` (3-line shim):

```js
const { createProxy } = require('./tool-server-proxy.js');
const { createAdapter } = require('./adapters/<name>.js');
createProxy({ adapter: createAdapter(), workspace, port, toolName });
```

## Non-LSP tools (build tools, formatters)

The same harness accepts non-LSP tools. Two patterns:

### External-subprocess adapter (JVM CLIs, compilers)
Use `tool-server-proxy.js`. Adapter spawns a keepalive child (e.g.
`node -e 'setInterval(...)'`) so the harness's child-exit +
health-probe wiring works; each `call` runs the target CLI via
`child_process.spawn` and returns the `{exit, signal, stdout,
stderr}` quad. See `bin/adapters/sbt-oneshot.js`, `dotnet-cli.js`,
`scalafmt-cli.js`.

### In-process Node library adapter (prettier, eslint)
Use `node-formatter-daemon.js`. Adapter implements `preload(workspace)`
→ pkg + `call(req, {pkg, state})`. Prefer workspace-local resolution
via `require.resolve(pkg, {paths: [workspace]})`, fall back to global.
See `bin/adapters/prettier.js`, `bin/adapters/eslint.js`.

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
- [ ] `cmd_batch_json` wired (all wrappers); `cmd_batch <method> <file>...` wired for LSP-shaped wrappers; both advertised in `cmd_tools`
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
