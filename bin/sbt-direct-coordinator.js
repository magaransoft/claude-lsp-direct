#!/usr/bin/env node
// sbt-direct-coordinator — per-workspace coordinator for sbt tasks.
// Composes tool-harness + tool-server-proxy + adapters/sbt-oneshot.
// CLI: --tool-name <name> --workspace <path> --port <N> [--sbt-cmd <path>]

'use strict';

const path = require('path');
const fs = require('fs');

const { createProxy } = require('./tool-server-proxy.js');
const { createAdapter } = require('./adapters/sbt-oneshot.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

function die(msg) { console.error('[sbt-direct] fatal:', msg); process.exit(1); }

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);
const TOOL_NAME = arg('tool-name', 'sbt-direct');
const SBT_CMD = arg('sbt-cmd', 'sbt');

if (!fs.existsSync(WORKSPACE)) die(`workspace does not exist: ${WORKSPACE}`);

createProxy({
  adapter: createAdapter({ name: TOOL_NAME, sbtCmd: SBT_CMD }),
  workspace: WORKSPACE,
  port: PORT,
  toolName: TOOL_NAME,
}).then(proxy => {
  proxy.on('childExit', ({ id, code, sig }) => {
    console.error(`[sbt-direct] child ${id} exited code=${code} sig=${sig} — exiting`);
    process.exit(1);
  });
  proxy.on('spawnError', ({ id, error }) => {
    console.error(`[sbt-direct] child ${id} spawn error: ${error.message}`);
    process.exit(1);
  });
}).catch(e => die(e.message));
