// adapters/dotnet-cli — per-workspace dotnet wrapper. Each /call invokes
// `dotnet <args>` as a subprocess. dotnet's own MSBuild build-server
// provides JVM-like warm persistence across calls automatically — our
// adapter doesn't need to manage it. `dotnet build-server shutdown`
// forces teardown; we expose it as a method for hard-invalidation paths.

'use strict';

const { spawn } = require('child_process');

function createAdapter({
  name = 'dotnet-direct',
  markers = ['global.json', '*.sln', '*.slnx', '*.csproj'],
  triggers = {
    soft: ['*.csproj', '*.sln', '*.slnx', 'Directory.Build.props', 'nuget.config'],
    hard: ['global.json', '.env', '.env.local', 'dotnet-tools.json'],
  },
  dotnetCmd = 'dotnet',
} = {}) {
  return {
    name,
    markers,
    triggers,

    // per-call subprocess adapter — no persistent child needed.
    spawn() { return []; },

    async init(ctx) {
      ctx.log(`dotnet adapter ready — dotnetCmd=${dotnetCmd}`);
    },

    onChildMessage() { /* keepalive child produces no output */ },

    async call({ method, params }, ctx) {
      const p = params || {};
      switch (method) {
        case 'version':
          return runDotnet(dotnetCmd, ctx.workspace, ['--version']);
        case 'info':
          return runDotnet(dotnetCmd, ctx.workspace, ['--info']);
        case 'build':
          return runDotnet(dotnetCmd, ctx.workspace, buildArgs('build', p));
        case 'test':
          return runDotnet(dotnetCmd, ctx.workspace, buildArgs('test', p));
        case 'restore':
          return runDotnet(dotnetCmd, ctx.workspace, buildArgs('restore', p));
        case 'publish':
          return runDotnet(dotnetCmd, ctx.workspace, buildArgs('publish', p));
        case 'run':
          return runDotnet(dotnetCmd, ctx.workspace, buildArgs('run', p));
        case 'pack':
          return runDotnet(dotnetCmd, ctx.workspace, buildArgs('pack', p));
        case 'build-server-shutdown':
          return runDotnet(dotnetCmd, ctx.workspace, ['build-server', 'shutdown']);
        case 'command':
          if (!Array.isArray(p.args)) throw new Error('dotnet call "command" requires params.args (array)');
          return runDotnet(dotnetCmd, ctx.workspace, p.args);
        default:
          throw new Error(`unknown dotnet method: ${method} — supported: version, info, build, test, restore, publish, run, pack, build-server-shutdown, command`);
      }
    },

    async reload(ctx) {
      // soft trigger fired (e.g. .csproj edit). dotnet's MSBuild build-
      // server detects project-file changes and re-evaluates on next
      // build invocation automatically. No adapter action required.
      ctx.log('dotnet soft-reload: MSBuild build-server will re-evaluate on next build');
    },
  };
}

function buildArgs(sub, params) {
  const args = [sub];
  if (params.project) args.push(params.project);
  if (params.configuration) args.push('--configuration', params.configuration);
  if (params.framework) args.push('--framework', params.framework);
  if (params.verbosity) args.push('--verbosity', params.verbosity);
  if (params.filter) args.push('--filter', params.filter);
  if (params.noRestore) args.push('--no-restore');
  if (params.noBuild) args.push('--no-build');
  if (Array.isArray(params.extraArgs)) args.push(...params.extraArgs);
  return args;
}

function runDotnet(dotnetCmd, workspace, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(dotnetCmd, args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code, sig) => {
      resolve({ exit: code, signal: sig, stdout, stderr });
    });
  });
}

module.exports = { createAdapter };
