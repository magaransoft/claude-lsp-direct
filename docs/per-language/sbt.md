# sbt — `sbt-direct`

Per-workspace sbt coordinator. One-shot mode in v1 — each `call`
spawns `sbt <task>` as a subprocess. Persistent-JVM adapter (sbt thin
client over ipcsocket) is future work.

## Install prereq

```bash
brew install sbt            # or sdkman: sdk install sbt
```

## Workspace markers (walk-up order)

1. `build.sbt`
2. `build.sc` (mill)
3. `build.mill`
4. `project/build.properties`

## Invocation

```bash
sbt-direct start                                  # cwd walk-up
sbt-direct call task    '{"task":"compile"}'
sbt-direct call task    '{"task":"test","project":"core"}'
sbt-direct call task    '{"task":"assembly"}'
sbt-direct call reload  '{}'
sbt-direct call version '{}'
sbt-direct tools                                  # full surface
```

## Method surface

| method  | params                                   | result                                        |
|---------|------------------------------------------|-----------------------------------------------|
| version | `{}`                                     | `{exit, signal, stdout, stderr}` from sbt --version |
| reload  | `{}`                                     | `{exit, signal, stdout, stderr}` from sbt reload |
| task    | `{task: "<name>", project?: "<module>"}` | `{exit, signal, stdout, stderr}` from `sbt <task>` or `sbt <project>/<task>` |

## Timing

Each `call` spawns a fresh sbt subprocess. Cold-start costs:

- first run on a fresh checkout: 30-120s (Ivy/Coursier resolution + Bloop generation on first compile).
- subsequent runs: 15-40s (JVM boot + sbt init + task execution).

Persistent-JVM adoption via sbt's thin client (`sbt --client`) would
drop warm calls to <200ms but requires ipcsocket native-library loading
from `$TMPDIR/.sbt/` which Claude's Bash sandbox denies (see "Sandbox
limitation" below).

## Invalidation matrix

| type | files                                                                   | action |
|------|-------------------------------------------------------------------------|--------|
| soft | `build.sbt`, `project/build.properties`, `project/plugins.sbt`          | next call re-reads (no-op in one-shot mode) |
| hard | `.env`, `.env.local`, `.sbtopts`, `.jvmopts`                            | coordinator restart (wrapper re-spawns on next call) |

## Sandbox limitation (important)

Running under a sandbox that confines file writes to a custom
`$TMPDIR` (e.g. Claude Code's Bash tool setting `TMPDIR=/tmp/claude-<uid>`)
will cause sbt to fail at launcher-init:

```
java.nio.file.FileSystemException:
  /var/folders/.../T/.sbt/sbt-socket-<pid>: Operation not permitted
  at sbt.internal.BootServerSocket.<init>
```

The JVM reads `java.io.tmpdir` from the macOS per-user tmp dir, not
the `TMPDIR` env var, and sbt creates its boot-server socket there.
The socket creation fails under the sandbox even though the socket
isn't strictly required for one-shot `sbt <task>` invocations.

Workarounds tried (and their limits):

- `SBT_OPTS="-Djava.io.tmpdir=$TMPDIR"` — not propagated into the
  launcher's socket path.
- `JAVA_TOOL_OPTIONS` — same outcome.

What works:

- **non-sandboxed shell** (regular terminal) — sbt boots cleanly.
- **Claude Bash with `dangerouslyDisableSandbox: true`** — verified
  working against a real multi-module Play 3 / Scala 3 project:
  `sbt-direct call version` reads the project's `build.sbt` correctly;
  `sbt-direct call task {"task":"scalafmtCheckAll"}` runs the
  sbt-scalafmt plugin end-to-end and surfaces per-file formatting
  diffs.
- **explicit sandbox allowlist** — add
  `/private/var/folders/**/.sbt/**` to
  `sandbox.filesystem.allowWrite` in `~/.claude/settings.json`;
  untested but should unblock the socket path.

The coordinator, bash wrapper, and adapter are sandbox-neutral —
the block is strictly in sbt's own boot code. SBT_OPTS
`-Djava.io.tmpdir=$TMPDIR` propagation was attempted and does not
reach the BootServerSocket path.

## State directory

```
~/.cache/sbt-direct/<workspace-hash>/
├── pid           coordinator pid
├── port          loopback port
├── workspace     absolute workspace path
├── log           coordinator stderr
├── calls.log     per-call JSON lines (method, ms, outcome, ...)
└── triggers.json mtime baseline for invalidation
```

## Future work

- Persistent-JVM adapter via sbt's `--client` thin-client path.
  Needs: sandbox bypass for the ipcsocket dylib extraction, adoption
  probe for externally-running `sbt shell` sessions, restart on hard
  triggers.
- Structured task output parsing (sbt's log events → structured
  JSON) so callers can distinguish warning vs error without regex.
