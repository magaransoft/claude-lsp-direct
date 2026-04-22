// adapters/sbt-bsp — persistent sbt via the Build Server Protocol
// (Scala-BSP 2.x). Each workspace's sbt is launched once via the
// argv declared in <ws>/.bsp/sbt.json, kept alive for the coordinator
// lifetime, and every /call rides the same JSON-RPC connection.
//
// Why BSP over sbt's own --client: BSP is a standard with a
// documented JSON-RPC stdio protocol; sbt reliably writes
// <ws>/.bsp/sbt.json (unlike target/active.json) and exposes
// buildTarget/compile, buildTarget/test, etc. as first-class methods.
// contentLength framing + jsonRpcClient in tool-harness cover the
// wire protocol verbatim.
//
// See: https://build-server-protocol.github.io/

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createAdapter({
  name = 'sbt-direct',
  markers = ['build.sbt', 'project/build.properties'],
  triggers = {
    soft: ['build.sbt', 'project/build.properties', 'project/plugins.sbt'],
    hard: ['.env', '.env.local', '.sbtopts', '.jvmopts'],
  },
} = {}) {
  return {
    name,
    markers,
    triggers,
    didChangeConfigurationSupported: false,  // BSP uses buildTarget/didChange instead

    spawn(workspace) {
      const bspFile = path.join(workspace, '.bsp', 'sbt.json');
      if (!fs.existsSync(bspFile)) {
        throw new Error(`BSP descriptor not found at ${bspFile} — run 'sbt bspConfig' in the workspace first, or use the sbt-oneshot adapter`);
      }
      const desc = JSON.parse(fs.readFileSync(bspFile, 'utf8'));
      if (!Array.isArray(desc.argv) || desc.argv.length === 0) {
        throw new Error(`BSP descriptor ${bspFile} has no argv`);
      }
      return [{
        id: 'bsp',
        frame: 'contentLength',
        cmd: desc.argv[0],
        args: desc.argv.slice(1),
        cwd: workspace,
      }];
    },

    async init(ctx) {
      const rpc = ctx.rpc.bsp;
      ctx.state.set('notificationSink', (msg) => {
        // drop noisy log/progress, surface compile diagnostics
        if (msg.method === 'build/logMessage' || msg.method === 'build/publishDiagnostics' ||
            msg.method === 'build/taskStart' || msg.method === 'build/taskProgress' ||
            msg.method === 'build/taskFinish') return;
        ctx.log('bsp notification:', msg.method);
      });

      // BSP initialize handshake
      const initParams = {
        displayName: 'sbt-direct',
        version: '1.2.0',
        bspVersion: '2.1.0-M1',
        rootUri: 'file://' + ctx.workspace,
        capabilities: {
          languageIds: ['scala', 'java'],
        },
      };
      await rpc.request('build/initialize', initParams);
      rpc.notify('build/initialized', {});
      ctx.log(`bsp initialized workspace=${ctx.workspace}`);

      // cache build targets for project/target resolution
      const result = await rpc.request('workspace/buildTargets', {});
      ctx.state.set('buildTargets', result.targets || []);
      ctx.log(`bsp build targets: ${(result.targets || []).length}`);
    },

    onChildMessage(childId, msg, ctx) {
      if (childId !== 'bsp') return;
      if (msg.method && msg.id === undefined) {
        const sink = ctx.state.get('notificationSink');
        if (sink) sink(msg);
        return;
      }
      ctx.rpc.bsp.handleMessage(msg);
    },

    async call({ method, params }, ctx) {
      const p = params || {};
      const rpc = ctx.rpc.bsp;
      switch (method) {
        case 'version':
          return rpc.request('workspace/buildTargets', {});
        case 'build-targets':
          return rpc.request('workspace/buildTargets', {});
        case 'compile': {
          const targets = resolveTargetIds(ctx, p.target || p.project);
          return rpc.request('buildTarget/compile', { targets });
        }
        case 'test': {
          const targets = resolveTargetIds(ctx, p.target || p.project);
          return rpc.request('buildTarget/test', {
            targets,
            originId: `sbt-direct-test-${Date.now()}`,
            dataKind: 'scala-test',
            data: p.filter ? { testClasses: [{ target: targets[0], classes: [p.filter] }] } : {},
          });
        }
        case 'clean': {
          const targets = resolveTargetIds(ctx, p.target || p.project);
          return rpc.request('buildTarget/cleanCache', { targets });
        }
        case 'run': {
          const targets = resolveTargetIds(ctx, p.target || p.project);
          if (targets.length !== 1) throw new Error('run requires exactly one target');
          return rpc.request('buildTarget/run', {
            target: targets[0],
            originId: `sbt-direct-run-${Date.now()}`,
            arguments: p.args || [],
          });
        }
        case 'sources': {
          const targets = resolveTargetIds(ctx, p.target || p.project);
          return rpc.request('buildTarget/sources', { targets });
        }
        case 'dependency-sources': {
          const targets = resolveTargetIds(ctx, p.target || p.project);
          return rpc.request('buildTarget/dependencySources', { targets });
        }
        case 'reload':
          return rpc.request('workspace/reload', {});
        default:
          throw new Error(`unknown sbt-bsp method: ${method} — supported: version, build-targets, compile, test, run, clean, sources, dependency-sources, reload`);
      }
    },

    async reload(ctx) {
      ctx.log('bsp workspace/reload');
      try { await ctx.rpc.bsp.request('workspace/reload', {}); }
      catch (e) { ctx.log('reload failed — exiting for restart:', e.message); process.exit(2); }
    },
  };
}

// resolveTargetIds — accept either a bare target name ("root"),
// a sbt-style path ("root/Compile"), or an explicit BuildTargetIdentifier
// uri. Returns an array of {uri} targets. Undefined input → all targets.
function resolveTargetIds(ctx, selector) {
  const all = ctx.state.get('buildTargets') || [];
  if (!selector) return all.map(t => t.id);
  const uri = typeof selector === 'string' && selector.startsWith('file:')
    ? selector : null;
  if (uri) return [{ uri }];
  // match by displayName or last path segment of id.uri
  const hit = all.filter(t => {
    const name = t.displayName || '';
    const tail = (t.id && t.id.uri || '').split('/').pop() || '';
    return name === selector || tail.startsWith(selector);
  });
  if (hit.length === 0) throw new Error(`no build target matched "${selector}" (known: ${all.map(t => t.displayName).join(', ')})`);
  return hit.map(t => t.id);
}

module.exports = { createAdapter };
