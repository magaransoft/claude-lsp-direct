# sbt — `sbt-direct`

Per-workspace sbt coordinator. Default mode is **auto**: on `start`,
the coordinator probes `<workspace>/.bsp/sbt.json` and selects:

| detected state | selected mode | cold first call | warm call |
|---|---|---|---|
| `.bsp/sbt.json` present | `bsp` (persistent JVM) | 15-30s (JVM boot + BSP init) | **~130ms** |
| `.bsp/sbt.json` absent | `oneshot` (per-call subprocess) | 4-5s | 3-4s |

`bsp` mode is strictly faster whenever it's available. If your
workspace doesn't have `.bsp/sbt.json`, run `sbt bspConfig` once to
generate it — every subsequent `sbt-direct call` in that workspace
switches to the warm path automatically.

Override auto-detection with `SBT_DIRECT_MODE=bsp` (force; errors if
descriptor absent) or `SBT_DIRECT_MODE=oneshot` (force; useful only
for a deliberate test of the fallback path).

Prereq for either mode: `sbt` on `PATH`. `bsp` adds the one-time
`sbt bspConfig` step per workspace.

The bsp mode uses the Build Server Protocol (Scala-BSP 2.x). sbt writes
`.bsp/sbt.json` describing how to launch itself in BSP server mode; the
coordinator reads that descriptor, spawns the JVM, runs the BSP
`build/initialize` handshake, and keeps the process alive for the
coordinator lifetime. Every `call` rides the same JSON-RPC connection.

### Verified smokes (fixtures/scala-sbt, BSP mode)

- `sbt-direct start` under `SBT_DIRECT_MODE=bsp` — coordinator up in
  ~15s on a warm Ivy cache.
- `call build-targets {}` → 3 targets (`root`, `root-test`,
  `root-build`) with capabilities `{canCompile, canTest, canRun}`.
- `call compile {}` × 3 consecutive calls: 159ms / 196ms / 138ms;
  coordinator PID unchanged across all three (persistent JVM).
- `call test {}` → `{statusCode: 1, originId: "sbt-direct-test-<ts>"}`.
- `call run {target: "root"}` → `{statusCode: 1, originId: "sbt-direct-run-<ts>"}`.
- `call clean {}` → `{cleaned: true}`.
- `call sources {}` → 15 source-file entries across targets.
- `call dependency-sources {}` → classpath items including Coursier
  cache paths.
- `call reload {}` → result null (BSP workspace/reload).
- soft-reload on `touch build.sbt` mid-session → PID preserved,
  coordinator log shows `[sbt-direct] bsp workspace/reload`.
- error paths: `call run {}` (no target) → `{"error":"run requires
  exactly one target"}`; `call compile {target:"does-not-exist"}` →
  `{"error":"no build target matched \"does-not-exist\" (known:
  root, root-test, root-build)"}`.
- cold without `.bsp/sbt.json` → coordinator fatal log: `BSP
  descriptor not found at <ws>/.bsp/sbt.json — run 'sbt bspConfig'
  in the workspace first, or use the sbt-oneshot adapter`.

### Earlier attempt: sbt's own `sbt --client`

An adapter using sbt's proprietary thin-client transport (watching for
`target/active.json` + connecting via the ipcsocket) was tried first
and withdrawn. `active.json` isn't written reliably under
`-Dsbt.server.forcestart=true` across builds (tested against fixture +
a real Play 3 project — sbt boots cleanly, reaches shell prompt,
never writes the file). BSP sidesteps that entirely: `.bsp/sbt.json`
is created via the explicit `sbt bspConfig` task and the protocol
itself is documented + standardized across Scala build tools.

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

### oneshot mode

| method  | params                                   | result                                        |
|---------|------------------------------------------|-----------------------------------------------|
| version | `{}`                                     | `{exit, signal, stdout, stderr}` from sbt --version |
| reload  | `{}`                                     | `{exit, signal, stdout, stderr}` from sbt reload |
| task    | `{task: "<name>", project?: "<module>"}` | `{exit, signal, stdout, stderr}` from `sbt <task>` or `sbt <project>/<task>` |

### bsp mode

Mapped to BSP 2.1.0-M1 methods. `target` accepts the build-target
displayName (e.g. `"root"`, `"root-test"`) OR the full
`file:///...#<name>/<conf>` uri.

| method              | params                                       | wraps                       |
|---------------------|----------------------------------------------|-----------------------------|
| version             | `{}`                                         | workspace/buildTargets      |
| build-targets       | `{}`                                         | workspace/buildTargets      |
| compile             | `{target?: "<name>" \| "<uri>"}`             | buildTarget/compile         |
| test                | `{target?, filter?: "<fqcn>"}`               | buildTarget/test            |
| run                 | `{target: "<name>", args?: [string, ...]}`   | buildTarget/run             |
| clean               | `{target?}`                                  | buildTarget/cleanCache      |
| sources             | `{target?}`                                  | buildTarget/sources         |
| dependency-sources  | `{target?}`                                  | buildTarget/dependencySources |
| reload              | `{}`                                         | workspace/reload            |

Omit `target` to apply to all build targets. Compile returns BSP
`{statusCode}` (1 = OK, 2 = ERROR, 3 = CANCELLED).

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
