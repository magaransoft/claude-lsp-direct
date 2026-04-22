# sbt — `sbt-direct`

Per-workspace sbt coordinator with two modes:

| mode | activation | cold call | warm call | requires |
|---|---|---|---|---|
| `oneshot` (default) | `SBT_DIRECT_MODE=oneshot` or unset | 20-40s | 20-40s | sbt on PATH |
| `thin-client` (experimental) | `SBT_DIRECT_MODE=thin-client` | 20-40s (first call boots server) | 200-500ms (`sbt --client`) | sbt on PATH + `install.sh` allowlist (or `dangerouslyDisableSandbox`) |

> **thin-client mode is experimental.** `target/active.json` detection is
> unreliable across sbt configurations — builds with certain plugin
> combinations don't write the file under `-Dsbt.server.forcestart=true`,
> and the coordinator's 90s init timeout may elapse with no server
> available. If thin-client mode fails for your project, fall back to
> oneshot (default) while the adoption protocol is hardened.

The thin-client adapter keeps a persistent sbt server alive per
workspace. On start, the coordinator spawns `sbt` with
`-Dsbt.server.forcestart=true` and waits for
`<workspace>/target/active.json` to appear (up to 90s on fresh
checkouts). Each `call` thereafter invokes `sbt --client "<cmd>"`
which reuses that server via the ipcsocket. Adoption: if
`target/active.json` already exists and its socket responds to a
5-second probe, the coordinator attaches to the existing server
instead of spawning a new one — lets `sbt shell` in a terminal
share state with `sbt-direct` calls.

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
