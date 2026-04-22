#!/usr/bin/env node
// sbt-direct-coordinator — per-workspace coordinator for sbt tasks.
// Composes tool-harness + tool-server-proxy + adapters/sbt-oneshot.
// CLI: --tool-name <name> --workspace <path> --port <N> [--sbt-cmd <path>]

'use strict';

const path = require('path');
const fs = require('fs');

const { createProxy } = require('./tool-server-proxy.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

function die(msg) { console.error('[sbt-direct] fatal:', msg); process.exit(1); }

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);
const TOOL_NAME = arg('tool-name', 'sbt-direct');
const SBT_CMD = arg('sbt-cmd', 'sbt');
// mode selection:
//   auto (default) — probe <ws>/.bsp/sbt.json; use bsp if present, oneshot otherwise
//   bsp            — persistent sbt via Build Server Protocol (warm calls <200ms).
//                    Requires `.bsp/sbt.json`; errors if absent.
//   oneshot        — per-call `sbt <task>` subprocess (20-40s per call; slower
//                    than bare sbt because we don't reuse sbt's launcher daemon).
//                    Fallback only — users with a working bsp descriptor
//                    should never end up here.
let MODE = arg('mode', process.env.SBT_DIRECT_MODE || 'auto');
if (MODE === 'auto') {
  const bspDescriptor = path.join(WORKSPACE, '.bsp', 'sbt.json');
  if (fs.existsSync(bspDescriptor)) {
    MODE = 'bsp';
  } else {
    MODE = 'oneshot';
    console.error(`[sbt-direct] ${bspDescriptor} not found — falling back to oneshot mode (slower). Run \`sbt bspConfig\` once in the workspace to enable bsp mode (warm calls <200ms).`);
  }
}
const adapterModule = MODE === 'bsp'
  ? './adapters/sbt-bsp.js'
  : './adapters/sbt-oneshot.js';
const { createAdapter } = require(adapterModule);
console.error(`[sbt-direct] mode=${MODE}`);

if (!fs.existsSync(WORKSPACE)) die(`workspace does not exist: ${WORKSPACE}`);

const adapterOpts = MODE === 'bsp'
  ? { name: TOOL_NAME }
  : { name: TOOL_NAME, sbtCmd: SBT_CMD };
createProxy({
  adapter: createAdapter(adapterOpts),
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
