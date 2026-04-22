// adapters/scalafmt-cli — per-call `scalafmt` CLI subprocess. The
// scalafmt-dynamic Scala API would enable in-JVM warm runs (single
// coursier-resolved JVM, stay-open classloader), but requires a
// Scala-side bridge that's out of scope for the first pass.

'use strict';

const { spawn } = require('child_process');

function createAdapter({
  name = 'scalafmt-direct',
  markers = ['.scalafmt.conf'],
  triggers = {
    soft: ['.scalafmt.conf'],
    hard: ['.env', '.env.local'],
  },
  scalafmtCmd = 'scalafmt',
} = {}) {
  return {
    name,
    markers,
    triggers,

    // per-call subprocess adapter — no persistent child needed.
    spawn() { return []; },

    async init(ctx) {
      ctx.log(`scalafmt adapter ready — scalafmtCmd=${scalafmtCmd}`);
    },

    onChildMessage() {},

    async call({ method, params }, ctx) {
      const p = params || {};
      switch (method) {
        case 'version':
          return runScalafmt(scalafmtCmd, ctx.workspace, ['--version'], null);
        case 'format-stdin': {
          if (typeof p.source !== 'string') throw new Error('scalafmt.format-stdin requires params.source (string)');
          // scalafmt native (v3.8+) uses --stdin as default mode; the file
          // hint flag is --assume-filename. scalafmt-dynamic JVM accepts
          // both; prefer --assume-filename for compatibility across modes.
          const args = ['--stdin'];
          if (p.filepath) args.push('--assume-filename', p.filepath);
          return runScalafmt(scalafmtCmd, ctx.workspace, args, p.source);
        }
        case 'format-files': {
          if (!Array.isArray(p.files) || p.files.length === 0) {
            throw new Error('scalafmt.format-files requires params.files (non-empty array of paths)');
          }
          const args = ['--non-interactive', ...p.files];
          return runScalafmt(scalafmtCmd, ctx.workspace, args, null);
        }
        case 'check-files': {
          if (!Array.isArray(p.files) || p.files.length === 0) {
            throw new Error('scalafmt.check-files requires params.files');
          }
          const args = ['--test', '--non-interactive', ...p.files];
          return runScalafmt(scalafmtCmd, ctx.workspace, args, null);
        }
        default:
          throw new Error(`unknown scalafmt method: ${method} — supported: version, format-stdin, format-files, check-files`);
      }
    },

    async reload(ctx) {
      ctx.log('scalafmt soft-reload: .scalafmt.conf re-read on next call (no-op in per-call mode)');
    },
  };
}

function runScalafmt(scalafmtCmd, workspace, args, stdinText) {
  return new Promise((resolve, reject) => {
    const child = spawn(scalafmtCmd, args, {
      cwd: workspace,
      stdio: [stdinText !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code, sig) => {
      resolve({ exit: code, signal: sig, stdout, stderr });
    });
    if (stdinText !== null) {
      child.stdin.end(stdinText);
    }
  });
}

module.exports = { createAdapter };
