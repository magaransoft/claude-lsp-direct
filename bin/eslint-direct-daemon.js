#!/usr/bin/env node
// eslint-direct-daemon — composed entrypoint for eslint-direct.
// Composes node-formatter-daemon + adapters/eslint.

'use strict';

const path = require('path');
const fs = require('fs');

const { createDaemon } = require('./node-formatter-daemon.js');
const { createAdapter } = require('./adapters/eslint.js');
const { installParentWatchdog, parseParentPidArg } = require('./lib/parent-watchdog.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

function die(msg) { console.error('[eslint-direct] fatal:', msg); process.exit(1); }

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);
const TOOL_NAME = arg('tool-name', 'eslint-direct');

if (!fs.existsSync(WORKSPACE)) die(`workspace does not exist: ${WORKSPACE}`);

installParentWatchdog({ parentPid: parseParentPidArg(process.argv), toolName: TOOL_NAME });

createDaemon({
  adapter: createAdapter({ name: TOOL_NAME }),
  workspace: WORKSPACE,
  port: PORT,
  toolName: TOOL_NAME,
}).catch(e => die(e.message));
