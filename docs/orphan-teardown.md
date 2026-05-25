# Orphan teardown — process-group lifecycle for LSP coordinators

Reference doc for the 2026-05-25 orphan-teardown unified fix. Documents why every wrapper now spawns its backend as a process-group leader, when the parent-PID watchdog fires, and how the central registry + reap CLI interact.

## Why

Pre-fix observation: an 18-hour session left ~11.7 GB of LSP-stack processes on disk after claude exited. Three distinct orphan classes:

1. **LSP-backend grandchildren** (jdtls indexers, pyright workers, tsserver plugin hosts) survived coordinator SIGTERM because `proc.kill()` only signals the immediate child PID. The child's own subprocesses inherited the parent shell's process group and didn't get the signal.
2. **Bloop daemon** (3.89 GB by itself) — spawned by `metals-mcp` as a libdaemon child; metals-mcp had no idle-shutdown and was started with bare `nohup` (no setsid), so killing metals-mcp didn't propagate to bloop.
3. **Coordinators themselves** when claude crashed without a clean SIGTERM. The coordinator's idle timer eventually exits at 30 min, BUT if `LSP_DIRECT_IDLE_MS=0` or a long-lived active-call masks the idle threshold, the coordinator orphans indefinitely.

## Mechanics

### Process-group spawn (ADR-001)

`bin/tool-server-proxy.js` passes `detached: true` to every backend `spawn(...)`. On POSIX, this calls `setsid(2)` → child becomes session leader AND process group leader; its PID equals its PGID.

Shutdown paths (idle timer, SIGTERM/SIGINT handler, `close()`, `onHard` invalidation) call:

```js
killGroup(proc, signal)
  → process.kill(-proc.pid, signal)  // negative PID = process group
```

The negative-PID signal reaches the entire process group — backend + its descendants — atomically. Fallback to direct `proc.kill()` if group-kill returns ESRCH/EPERM (rare; shouldn't happen for own children).

### Shell-wrapper equivalent (ADR-001 for scala-direct)

`scala-direct` is a Bash wrapper, not Node. It spawns metals-mcp via `bin/lib/spawn-detached.py` — a 25-line Python helper that calls `os.setsid()` then `os.execvp()` to take over the child slot. macOS lacks the `setsid` CLI by default; Python's `os.setsid` ships everywhere Python ships.

Result: metals-mcp gets its own pgid; `kill -- -<metals-pid>` reaches both metals AND its bloop daemon child. `cmd_stop` does this with 3s grace + SIGKILL escalation.

### Parent-PID watchdog (ADR-002)

`tool-server-proxy.js` captures `STARTUP_PARENT_PID = process.ppid` at MODULE LOAD (not inside `server.listen()` callback — adapter init can take 60-180s for cold metals/bloop, and the original parent may have already exited by then, reparenting ppid to 1).

A `setInterval` polls `process.kill(parentPid, 0)` every `LSP_DIRECT_PARENT_WATCHDOG_MS` (default 60s). On ESRCH the coordinator's `shutdown()` runs: clear timers → killGroup all children → server.close → exit 0.

Skipped when `parentPid === 1` (already-orphaned at spawn — expected for `nohup`-detached coordinators where the wrapper, not claude, owns lifecycle). EPERM treated as alive (don't shut down on permission denied).

### Central registry (ADR-004)

Every coordinator-spawned backend appends one TSV row to `~/.cache/claude-lsp-direct/registry.tsv`:

```
spawn_ts \t coordinator_pid \t backend_pid \t wrapper \t workspace \t parent_pid
```

Atomic via POSIX O_APPEND guarantees for writes <PIPE_BUF (4096 B; rows are ~250 B). The `bin/lsp-direct-ps` CLI reads this file, signal-0 probes each PID, prints live entries. `lsp-direct-reap --by-backend-pid <pid>` uses it to reverse-lookup the owning coordinator (closes the "vue tsserver untraceable" diagnostic gap that lsof couldn't answer).

Adopted children (external instance reuse — e.g. metals via `.metals/mcp.json` probe) are NOT registered; the adoption owner manages lifecycle.

### Multi-session-aware Stop reap (ADR-005)

`~/.claude/hooks/reap-stale-lsp-on-stop.py` defers the 60-minute stale sweep when ≥1 other claude session is alive. Detection via `pgrep -lf '/claude'` excluding self + parent + grep-helpers. Override with `LSP_REAP_SKIP_SESSION_CHECK=1`.

Per-session cleanup (parent-PID watchdog) still fires when an individual claude exits, so this gate only affects the wider cross-session sweep — single-session users see identical behavior to pre-fix.

## Diagnostic flow

```bash
# what's alive?
lsp-direct-ps

# focus on one workspace
lsp-direct-ps --workspace ~/projects/foo

# what spawned this rogue tsserver?
lsp-direct-reap --by-backend-pid 12345 --dry-run

# weekly health check
lsp-week.sh 7   # JSON summary; ship-gate orphan_rate_pct < 1.0
```

## Env-var summary

| var | default | effect |
|---|---|---|
| `LSP_DIRECT_IDLE_MS` | `1800000` (30 min) | coordinator self-exit threshold |
| `LSP_DIRECT_PARENT_WATCHDOG_MS` | `60000` (60s) | parent-PID poll interval; 0 disables |
| `LSP_REAP_SKIP_SESSION_CHECK` | unset | `=1` bypasses multi-session deferral in Stop hook |
| `METALS_MCP_BIN` | `metals-mcp` (PATH) | metals-mcp binary path override |
| `<WRAPPER>_DIRECT_STATE` | `~/.cache/<wrapper>/` | per-wrapper state-dir override |

## Cold-start baseline (2026-05-25)

`scripts/measure-lsp-cold-start.sh` populates `docs/cold-start-baseline.tsv`. Baseline used to confirm 30-minute idle threshold is appropriate (cold-start cost paid only on first-call-after-idle):

| wrapper | cold p50 | cold p99 |
|---|---|---|
| py-direct | 1.2s | 1.2s |
| ts-direct | 1.3s | 1.3s |
| vue-direct | 1.2s | 1.2s |
| cs-direct | 2.4s | 2.4s |
| java-direct | 4.2s | 4.3s |
| scala-direct | 60-180s (measurement deferred — cold-start exceeds curl 120s ceiling; pre-warm via `scala-direct start <ws>` then time it) |

All non-scala wrappers cold-start in <5s; 30-min idle = ~360× the cold-start cost paid back on next use. Acceptable.

## Verified open questions

| Q | answer |
|---|---|
| Does Node `spawn({detached:true})` create a new process group on macOS? | YES — `setsid(2)` syscall; verified live: backend pgid == backend pid |
| Does `bloop exit` reliably terminate the bloop daemon? | NO — `bloop` CLI not on PATH in this env; teardown via SIGTERM to metals-mcp's process group (libdaemon socket silence → bloop self-exits) works without explicit `bloop exit` |
| Does the process-group fix reach depth-2 (e.g. vue tsserver as grandchild of vue-language-server)? | YES — verified 2026-05-25 against fixtures/vue: SIGTERM to vue-direct-coordinator atomically killed vue-language-server (pgid leader) + tsserver-with-plugin (pgid leader) + tsserver grandchild |

## Cross-refs

- pitch + ADRs: `~/.claude/plans/lsp-orphan-teardown-unified-fix.md`
- tests: `bin/tests/test-process-group-kill.mjs` (5 cases), `bin/tests/test-registry-atomicity.mjs` (2 cases), `~/.claude/hooks/tests/test_reap_stale_lsp_on_stop.py` (9 cases)
- CHANGELOG: `## [Unreleased] § Added — orphan-teardown unified fix (2026-05-25)`
