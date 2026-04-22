# .NET — `dotnet-direct`

Per-workspace dotnet coordinator. Per-call subprocess; warm-path
persistence handled by dotnet's own MSBuild build-server which persists
across `dotnet build` invocations automatically.

## Install prereq

```bash
# macOS
brew install --cask dotnet-sdk
# or direct download: https://dotnet.microsoft.com/download
```

## Workspace markers (walk-up order)

1. `global.json`
2. `*.sln` / `*.slnx`
3. `*.csproj` / `*.fsproj` / `*.vbproj`

## Invocation

```bash
dotnet-direct start                                      # cwd walk-up
dotnet-direct call version '{}'
dotnet-direct call build   '{"configuration":"Release"}'
dotnet-direct call test    '{"filter":"Category=Unit"}'
dotnet-direct call restore '{}'
dotnet-direct call command '{"args":["tool","list"]}'    # escape hatch
dotnet-direct tools                                      # full surface
```

## Method surface

| method | params | wraps |
|---|---|---|
| version | `{}` | `dotnet --version` |
| info | `{}` | `dotnet --info` |
| build | `{project?, configuration?, framework?, verbosity?, noRestore?, extraArgs?[]}` | `dotnet build [project] [flags]` |
| test | `{project?, configuration?, framework?, verbosity?, filter?, noBuild?, extraArgs?[]}` | `dotnet test [project] [flags]` |
| restore | `{project?, verbosity?, extraArgs?[]}` | `dotnet restore [project]` |
| publish | `{project?, configuration?, framework?, verbosity?, extraArgs?[]}` | `dotnet publish [project]` |
| run | `{project?, configuration?, framework?, extraArgs?[]}` | `dotnet run [project]` |
| pack | `{project?, configuration?, verbosity?, extraArgs?[]}` | `dotnet pack [project]` |
| build-server-shutdown | `{}` | `dotnet build-server shutdown` |
| command | `{args: [string, ...]}` | `dotnet <args...>` (escape hatch) |

All results are `{exit, signal, stdout, stderr}` from the subprocess.

## Timing

- Cold first build: 5-10s (SDK init + NuGet restore).
- Warm subsequent builds: sub-second for no-op, 1-3s for incremental.

dotnet's MSBuild build-server persists across invocations by default;
the adapter benefits transparently. Use `build-server-shutdown` to
force-recycle when a stale server drifts.

## Invalidation matrix

| type | files | action |
|---|---|---|
| soft | `*.csproj`, `*.sln`, `*.slnx`, `Directory.Build.props`, `nuget.config` | no-op (MSBuild build-server picks up changes automatically) |
| hard | `global.json`, `.env`, `.env.local`, `dotnet-tools.json` | coordinator restart |

## State directory

```
~/.cache/dotnet-direct/<workspace-hash>/
├── pid           coordinator pid
├── port          loopback port
├── workspace     absolute workspace path
├── log           coordinator stderr
├── calls.log     per-call JSON lines (method, ms, outcome, ...)
└── triggers.json mtime baseline for invalidation
```

## Quirks

- `dotnet build-server` on macOS uses NamedPipes in `/tmp/<uid>-<hash>`.
  Does not hit the same sandbox tmpdir issue that blocks sbt's
  BootServerSocket.
- Single-project workspaces: most methods accept an optional `project`
  parameter; omit when there's only one `.csproj` in the workspace.
- `run` with `--no-build` requires the matching configuration to be
  pre-built. Example: if you built `dotnet-direct call build
  {"configuration":"Release","noRestore":true}`, then `call run
  {"configuration":"Release","extraArgs":["--no-build","--no-restore"]}`
  succeeds; `call run {"extraArgs":["--no-build","--no-restore"]}`
  without the `Release` configuration hint fails because dotnet run
  defaults to Debug/net9.0/ which wasn't built. Pass
  `"configuration": "<matches-your-build>"` to run.

## Network-sandbox interaction

`dotnet restore` reaches `api.nuget.org` to fetch packages. The Claude
Bash default sandbox denies egress to nuget.org, so a cold `restore`
under Claude Bash fails with
`System.Net.Http.HttpRequestException: Resource temporarily unavailable`
or `Failed to download ... from nuget.org`. Paths for resolution:

- **Restore outside Claude Bash first.** Run `dotnet restore` once in a
  regular terminal so `obj/project.assets.json` + the NuGet global
  cache at `~/.nuget/packages/` are populated. Subsequent
  `dotnet-direct call build` / `test` / `publish` from Claude Bash
  reuse the warm cache without needing network.
- **Pass `noRestore: true`** in `build` / `test` / `publish` params
  when the cache is warm:
  `dotnet-direct call build '{"noRestore":true}'`.
- **Whitelist nuget.org** in `sandbox.network` in
  `~/.claude/settings.json` if you prefer restore to work directly
  (advanced — Claude Code docs cover the sandbox.network schema).

The `version`, `info`, `build-server-shutdown`, and `command --list-sdks`
methods don't touch the network and work from Claude Bash without any
configuration.
