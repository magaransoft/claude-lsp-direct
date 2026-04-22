#!/usr/bin/env node
// vue-direct-coordinator — Vue Language Server v3 + paired tsserver
// (w/ @vue/typescript-plugin) hybrid coordinator. Composes tool-harness
// + tool-server-proxy + adapters/vue-hybrid behind the original CLI:
// --workspace <path> --port <N>.
//
// Consumed by bin/vue-direct. Vue LS v3 is hybrid-mandatory — it
// cannot answer TypeScript-backed queries without a paired tsserver
// process hosting @vue/typescript-plugin. See docs/per-language/vue.md
// for the protocol details.

'use strict';

const path = require('path');
const fs = require('fs');

const { createProxy } = require('./tool-server-proxy.js');
const { createAdapter } = require('./adapters/vue-hybrid.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

function die(msg) { console.error('[coordinator] fatal:', msg); process.exit(1); }

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);
const TOOL_NAME = arg('tool-name', 'vue-direct');

if (!fs.existsSync(WORKSPACE)) die(`workspace does not exist: ${WORKSPACE}`);

createProxy({
  adapter: createAdapter({ name: TOOL_NAME }),
  workspace: WORKSPACE,
  port: PORT,
  toolName: TOOL_NAME,
}).then(proxy => {
  proxy.on('childExit', ({ id, code, sig }) => {
    console.error(`[coordinator] child ${id} exited code=${code} sig=${sig} — exiting`);
    process.exit(1);
  });
  proxy.on('spawnError', ({ id, error }) => {
    console.error(`[coordinator] child ${id} spawn error: ${error.message}`);
    process.exit(1);
  });
}).catch(e => die(e.message));
