# Troubleshooting

## vscode-jsonrpc double-wraps array params
**Symptom:** You're bridging two LSP-over-stdio peers. Peer A sends `connection.sendNotification('x', [id, cmd, args])`. Your bridge receives `params: [[id, cmd, args]]` and your destructure `const [id, cmd, args] = msg.params` gets `id = [id, cmd, args]` (the whole tuple), everything downstream breaks.

**Fix:**
```js
const tuple = Array.isArray(msg.params[0]) ? msg.params[0] : msg.params;
const [id, cmd, args] = tuple;
```
When SENDING array-shaped params back to a vscode-jsonrpc peer, also wrap:
```js
send({ jsonrpc: '2.0', method: 'x', params: [[id, cmd, args]] });
```
The array wrapping is symmetric between vscode-jsonrpc peers and invisible to either side, but custom bridges must handle it manually.

## HTTP health probe vs `kill -0`
**Symptom:** Your bash wrapper uses `kill -0 "$pid" 2>/dev/null` to check if the coordinator is alive. Under some sandboxed environments (Claude Code's macOS sandbox, for example), `kill -0` returns "operation not permitted" even for processes the shell just spawned, and `/dev/tcp/host/port` returns "no such file or directory". Your alive-check always fails, wrapper spawns a duplicate coordinator every call, warmup cost dominates.

**Fix:** use HTTP as the liveness probe:
```bash
port_ready() { curl -fsS -m 2 "http://127.0.0.1:$1/health" >/dev/null 2>&1; }
```
Every coordinator in this repo exposes `GET /health` → 200. No kill signals, no `/dev/tcp`, works under every sandbox we've tested.

## Empty bash array under `set -u`
**Symptom:** Your wrapper declares `LSP_ARGS=()` (server takes no extra flags) and passes it via `"${LSP_ARGS[@]}"`. Under `set -u` (strict mode), bash errors `LSP_ARGS[@]: unbound variable`.

**Fix:** use the `${var+val}` expand-if-set pattern on the array:
```bash
LSP_ARGS=()
exec cmd "${LSP_ARGS[@]+${LSP_ARGS[@]}}"
```
Bash 4.4+ has this; older versions need a guard variable.

## csharp-ls + .NET SDK MSBuild BuildHost failure
**Symptom:** `cs-direct` starts, csharp-ls connects, but every query returns `result: null`. Log shows:
```
Microsoft.CodeAnalysis.MSBuild.BuildHostProcessManager ...
System.IO.Pipes.NamedPipeClientStream.ConnectInternal ... failed
```
This is a csharp-ls + .NET 10 SDK interaction bug on macOS (and occasionally Linux). Unrelated to `cs-direct` — the wrapper is correctly handing csharp-ls a valid `rootUri` at spawn time; csharp-ls itself can't load the project.

**Workaround:**
- Pin to .NET SDK 9.x until csharp-ls ships a fix
- Or use Roslyn LSP via the `dotnet-lsp` experimental binary (not yet wrapped in this repo)

Track progress at https://github.com/razzmatazz/csharp-language-server/issues.

## pyright-langserver not on PATH
**Symptom:** `py-direct start` errors `pyright-langserver not on PATH`.

**Fix:** `npm i -g pyright`. The binary lands at `$(npm config get prefix)/bin/pyright-langserver`. Ensure that directory is in `PATH`.

## typescript-language-server null rootUri
**Symptom:** ts-direct starts but every `textDocument/*` call hangs or returns empty.

**Fix:** `typescript-language-server` requires a non-null `rootUri` at init. `lsp-stdio-proxy.js` always sets `rootUri: 'file://' + WORKSPACE` from the `--workspace` arg, so this shouldn't hit you unless you're invoking the proxy directly without `--workspace`.

## Vue LS v3 silent hang in standalone mode
**Symptom:** Vue Language Server v3.x spawned standalone via `--stdio` responds to `initialize` but all subsequent `textDocument/*` calls hang.

**Reason:** Vue LS v3 is hybrid-mandatory — every semantic op routes through `tsserver/request` notifications expecting a paired tsserver hosting `@vue/typescript-plugin`. Standalone stdio = infinite wait.

**Fix:** Use `bin/vue-direct` (not the generic `lsp-stdio-proxy.js`). `vue-direct` dispatches to `vue-direct-coordinator.js` which spawns both children and bridges them correctly.

## jdtls fails on first start with `~/.eclipse: Operation not permitted`
**Symptom:** `java-direct start` exits within seconds, log shows `java.nio.file.FileSystemException: ~/.eclipse: Operation not permitted` followed by an Eclipse Equinox stack trace ending with `jdtls exited 15 null`.

**Reason:** The Eclipse Equinox launcher extracts JNI native libraries into `~/.eclipse/` on first run. Sandboxed environments (Claude Code's macOS sandbox is one) deny writes to that path unless explicitly allowed.

**Fix:** allow writes to `~/.eclipse` and `~/.cache/java-direct` in the sandbox config. For Claude Code, add both to `Filesystem.write.allowOnly` in `~/.claude/settings.json`. After first successful start, `~/.eclipse` is populated and the issue does not recur.

## jdtls `workspace/symbol` returns empty right after start
**Symptom:** `java-direct start` succeeds, `textDocument/documentSymbol` works, but `workspace/symbol '{"query":"X"}'` returns `[]` for a class you can clearly see.

**Reason:** jdtls runs an asynchronous "Building workspace" job after init. `workspace/symbol` indexes via that job; the rest of the LSP surface answers immediately from per-file parsing. On a small project the job settles in 5-15s; on a real Maven/Gradle project with transitive deps it can take 30-120s.

**Fix:** wait, then retry. For scripts, poll on `workspace/symbol` with a known sentinel symbol until you see a non-empty result.

## Workspace not detected
**Symptom:** `<lang>-direct start` picks the wrong workspace or says "no workspace found".

**Debug:** Each wrapper walks up from cwd for language-specific markers (see `docs/convention.md` table). If you're in a subdirectory above the intended root, it won't find the marker. Pass the workspace explicitly:
```bash
py-direct start /abs/path/to/project
py-direct call textDocument/hover '{...}' /abs/path/to/project
```

## Stale state dirs after worktree-remove cycles
**Symptom:** `<wrapper> status` shows many `dead` entries from worktrees that no longer exist on disk. Hard to tell at a glance which workspaces are actually live, and grep-based status parsers see noise.

**Reason:** Each `<wrapper> start <ws>` creates a hashed state dir under `~/.cache/<wrapper>/<hash>/`. When the workspace dir is deleted (e.g. `git worktree remove`), the state dir lingers because no event tells the wrapper to clean up.

**Fix:** Run `<wrapper> prune`. Reaps state dirs whose recorded process is dead AND whose port is unreachable. Adopted external servers (running but launched by an IDE) and live-launched servers are preserved.

```bash
scala-direct prune  # pruned 17 dead state dir(s) from /Users/me/.cache/scala-direct
ts-direct prune
py-direct prune
# … same subcommand on all wrappers
```

Safe to run any time — won't kill live processes; only removes the bookkeeping for ones that are gone.

## "lsp call failed" — what to do
**Symptom:** `<wrapper> call <method> ...` returns `curl: (22) The requested URL returned error: 500` followed by `<wrapper>: lsp call failed (method=<X>) — verify method name via '<wrapper> tools' and daemon health via '<wrapper> status'`.

**Reason:** The HTTP 500 originates from the underlying LSP, not the wrapper. Most common causes:
1. Method name typo or wrong shape (e.g. `textDocument/documentSymbols` vs `textDocument/documentSymbol`).
2. Malformed `params` JSON — missing `textDocument.uri`, missing `position`, off-by-one line/character (LSP is 0-indexed), missing `context.includeDeclaration` on `references`.
3. Daemon was alive at probe time but the underlying LSP child crashed or restarted without re-init.

**Fix:** Follow the order the error message suggests:
1. `<wrapper> tools` — confirm exact method name + canonical params shape.
2. `<wrapper> status` — confirm daemon `alive` for the workspace you're querying.
3. If both pass, retry with `--max-time 120` raised, or read `<stateDir>/log` to see what the underlying LSP said.

**Don't fall back to `grep` on a hook block** — the `enforce-lsp-over-grep` hook exists because raw text search misses semantic context. Always come back through the wrapper after fixing the method/args.

## Repo vs `~/.claude/bin/` out of sync
**Symptom:** You edited a file in `~/.claude/bin/<lang>-direct` expecting local changes; they don't show up after `git pull`.

**Reason:** `~/.claude/bin/*-direct` should be symlinks to `~/projects/claude-lsp-direct/bin/*` per `scripts/install.sh`. Edits to the wrapper should go to the repo file, not the symlink.

**Fix:** Verify symlinks exist (`ls -la ~/.claude/bin/`), re-run `scripts/install.sh` to restore.
