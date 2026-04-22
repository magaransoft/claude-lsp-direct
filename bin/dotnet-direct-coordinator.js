#!/usr/bin/env node
// dotnet-direct-coordinator — per-workspace dotnet coordinator.
// Composes tool-harness + tool-server-proxy + adapters/dotnet-cli.
// CLI: --tool-name <name> --workspace <path> --port <N> [--dotnet-cmd <path>]

'use strict';

const path = require('path');
const fs = require('fs');

const { createProxy } = require('./tool-server-proxy.js');
const { createAdapter } = require('./adapters/dotnet-cli.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

function die(msg) { console.error('[dotnet-direct] fatal:', msg); process.exit(1); }

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);
const TOOL_NAME = arg('tool-name', 'dotnet-direct');
const DOTNET_CMD = arg('dotnet-cmd', 'dotnet');

if (!fs.existsSync(WORKSPACE)) die(`workspace does not exist: ${WORKSPACE}`);

createProxy({
  adapter: createAdapter({ name: TOOL_NAME, dotnetCmd: DOTNET_CMD }),
  workspace: WORKSPACE,
  port: PORT,
  toolName: TOOL_NAME,
}).then(proxy => {
  proxy.on('childExit', ({ id, code, sig }) => {
    console.error(`[dotnet-direct] child ${id} exited code=${code} sig=${sig} — exiting`);
    process.exit(1);
  });
  proxy.on('spawnError', ({ id, error }) => {
    console.error(`[dotnet-direct] child ${id} spawn error: ${error.message}`);
    process.exit(1);
  });
}).catch(e => die(e.message));
