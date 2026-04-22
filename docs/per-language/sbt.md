# sbt — `sbt-direct`

Per-workspace sbt coordinator. Per-call subprocess mode: each `call`
runs `sbt <task>` as a fresh subprocess. 20-40s per call (JVM boot +
Ivy/Coursier resolution + task execution).

A persistent-JVM path via sbt's thin client (`sbt --client`) was
attempted and withdrawn — under Claude Bash (and in isolated
reproductions on a real Play 3 project) sbt boots cleanly but
`target/active.json` is never written, even with
`-Dsbt.server.forcestart=true` and a `shell` subcommand. Root cause
unconfirmed; candidates include sbt's tty detection, sandbox-
suppressed file creation under the JVM's `java.io.tmpdir`, or
plugin-specific interference. Until the adoption protocol is
reproducible, per-call subprocess is the only sbt path.

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

## Sandbox interaction

The JVM uses the macOS per-user tmp dir (`/private/var/folders/.../T/`)
for sbt's BootServerSocket regardless of shell `$TMPDIR`, and for
dependency-cache writes during Ivy / Coursier resolution. Claude
Bash default sandbox denies writes there. `scripts/install.sh` pre-
allows the minimum set automatically:

```json
"sandbox": { "filesystem": { "allowWrite": [
  "/private/var/folders/**/.sbt/**",
  "~/.sbt/**",
  "~/.ivy2/**",
  "~/.coursier/**"
]}}
```

With `install.sh` run, sbt-direct works under Claude Bash without any
per-call bypass flag. Verified against a real multi-module Play 3 /
Scala 3 project: `sbt-direct call version` reads the project's
`build.sbt` correctly; `sbt-direct call task
{"task":"scalafmtCheckAll"}` runs the sbt-scalafmt plugin end-to-end
and surfaces per-file formatting diffs.

Users who don't run `install.sh` (stand-alone deployment, bespoke
sandbox config) can either merge the same entries into their
`~/.claude/settings.json` manually, or call sbt-direct with
`dangerouslyDisableSandbox: true`. The coordinator, bash wrapper, and
adapter are all sandbox-neutral — the socket write is the only
block, and it's strictly in sbt's own boot code.

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
