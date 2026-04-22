// adapters/sbt-oneshot — minimal sbt wrapper: each /call invokes
// `sbt <task>` as a one-shot subprocess. Trades persistent-JVM warm
// wins for zero sandbox exposure (sbt --client extracts libipcsocket
// native dylib to $TMPDIR which Claude's Bash sandbox denies).
//
// Intended ceiling: demonstrates harness compatibility for non-LSP
// tools and codifies the sbt task surface. A persistent-server adapter
// (sbt-thin-client over ipcsocket) is future work once a live-sandbox
// bypass flow is agreed with the user.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function createAdapter({
  name = 'sbt-direct',
  markers = ['build.sbt', 'project/build.properties'],
  triggers = {
    soft: ['build.sbt', 'project/build.properties', 'project/plugins.sbt'],
    hard: ['.env', '.env.local', '.sbtopts', '.jvmopts'],
  },
  sbtCmd = 'sbt',
} = {}) {
  return {
    name,
    markers,
    triggers,

    // one-shot adapter: no persistent backing process. Harness accepts
    // empty children since v1.2.1; the coordinator's HTTP surface +
    // invalidationLoop + callLog all work without a child.
    spawn() { return []; },

    async init(ctx) {
      ctx.log(`sbt adapter ready (per-call mode) — sbtCmd=${sbtCmd}`);
    },

    onChildMessage() { /* keepalive child produces no output */ },

    async call({ method, params }, ctx) {
      // method shape: one of 'task' | 'reload' | 'version'
      // params:
      //   task:    { task: 'compile', project?: 'core' }
      //   reload:  {}
      //   version: {}
      if (method === 'version') {
        return runSbt(sbtCmd, ctx.workspace, ['--version']);
      }
      if (method === 'reload') {
        return runSbt(sbtCmd, ctx.workspace, ['reload']);
      }
      if (method === 'task') {
        const task = params && params.task;
        const project = params && params.project;
        if (!task || typeof task !== 'string') {
          throw new Error('sbt call "task" requires params.task (string)');
        }
        const cmd = project ? `${project}/${task}` : task;
        return runSbt(sbtCmd, ctx.workspace, [cmd]);
      }
      throw new Error(`unknown sbt method: ${method} — supported: task, reload, version`);
    },

    async reload() {
      // soft trigger fires sbt reload via next call — the one-shot
      // model re-reads build.sbt on every invocation anyway, so this
      // is a no-op. Left explicit for parity with LSP adapters.
    },
  };
}

function runSbt(sbtCmd, workspace, args) {
  return new Promise((resolve, reject) => {
    // JVM ignores env TMPDIR and uses the OS default for java.io.tmpdir.
    // Under sandboxed shells that override TMPDIR to a writable path
    // (e.g. Claude Bash sandbox sets TMPDIR=/tmp/claude-<uid>), sbt's
    // UnixDomainSocket creation fails EPERM on /var/folders/.../.sbt/.
    // Propagate -Djava.io.tmpdir explicitly so sbt uses the writable dir.
    const env = { ...process.env };
    const tmp = process.env.TMPDIR;
    if (tmp && !/(-D|^-D)java\.io\.tmpdir/.test(env.SBT_OPTS || '')) {
      env.SBT_OPTS = `${env.SBT_OPTS || ''} -Djava.io.tmpdir=${tmp}`.trim();
    }
    const child = spawn(sbtCmd, args, { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', (code, sig) => {
      resolve({
        exit: code,
        signal: sig,
        stdout,
        stderr,
      });
    });
  });
}

module.exports = { createAdapter };
