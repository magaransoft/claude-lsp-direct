#!/usr/bin/env node
// cs-roslyn-direct-coordinator — Microsoft Roslyn Language Server coordinator.
// Composes tool-harness + tool-server-proxy + adapters/cs-roslyn behind the
// same CLI as lsp-stdio-proxy.js:
//   --tool-name <name> --workspace <path> --port <N> --lang-id <id>
//   -- <lsp-cmd> [<lsp-args>...]
//
// Consumed by bin/cs-roslyn-direct. lsp-stdio-proxy.js untouched — generic
// single-adapter coordinator stays single-adapter. cs-roslyn requires reverse-RPC
// handlers for workspace/configuration etc. that csharp-ls / pyright / tsserver
// do not need (see roslyn-reverse-rpc-lsp-stdio plan ADR-001/003).

'use strict';

const path = require('path');
const fs = require('fs');

const { createProxy } = require('./tool-server-proxy.js');
const { createAdapter } = require('./adapters/cs-roslyn.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

function lspArgv() {
  const sep = process.argv.indexOf('--');
  if (sep < 0) return null;
  const rest = process.argv.slice(sep + 1);
  if (rest.length < 1) return null;
  return { cmd: rest[0], args: rest.slice(1) };
}

function die(msg) { console.error('[cs-roslyn-coordinator] fatal:', msg); process.exit(1); }

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);
const LANG_ID = arg('lang-id', 'csharp');
const TOOL_NAME = arg('tool-name', 'cs-roslyn-direct');
const SPAWN = lspArgv();

if (!SPAWN) die('missing LSP command — pass it after --: ...coordinator.js --workspace X --port N --lang-id csharp -- /path/to/Microsoft.CodeAnalysis.LanguageServer --stdio');
if (!fs.existsSync(WORKSPACE)) die(`workspace does not exist: ${WORKSPACE}`);

// invalidation matrix — mirror csharp entry in lsp-stdio-proxy.js
const triggers = {
  soft: ['*.csproj', '*.sln', '*.slnx', 'Directory.Build.props'],
  hard: ['global.json', '.env', '.env.local'],
};

const adapter = createAdapter({
  name: TOOL_NAME,
  cmd: SPAWN.cmd,
  args: SPAWN.args,
  langId: LANG_ID,
  markers: [],
  triggers,
  didChangeConfigurationSupported: true,
});

createProxy({
  adapter,
  workspace: WORKSPACE,
  port: PORT,
  toolName: TOOL_NAME,
}).then(proxy => {
  proxy.on('childExit', ({ id, code, sig }) => {
    console.error(`[cs-roslyn-coordinator] child ${id} exited code=${code} sig=${sig} — exiting`);
    process.exit(1);
  });
  proxy.on('spawnError', ({ id, error }) => {
    console.error(`[cs-roslyn-coordinator] child ${id} spawn error: ${error.message}`);
    process.exit(1);
  });
}).catch(e => die(e.message));
