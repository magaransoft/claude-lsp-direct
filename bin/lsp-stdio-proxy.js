#!/usr/bin/env node
// lsp-stdio-proxy — generic coordinator entrypoint for stdio-LSP servers.
// Composes tool-harness + tool-server-proxy + adapters/lsp-stdio behind
// the original CLI: --tool-name <name> --workspace <path> --port <N>
// --lang-id <id> -- <lsp-cmd> [<lsp-args>...]
//
// Consumed by bin/py-direct, bin/ts-direct, bin/cs-direct, bin/java-direct
// (and any future standalone-stdio LSP wrapper). Vue uses
// bin/vue-direct-coordinator.js because Vue LS v3 is hybrid-mandatory.

'use strict';

const path = require('path');
const fs = require('fs');

const { createProxy } = require('./tool-server-proxy.js');
const { createAdapter } = require('./adapters/lsp-stdio.js');

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

function die(msg) { console.error('[proxy] fatal:', msg); process.exit(1); }

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);
const LANG_ID = arg('lang-id', 'plaintext');
const TOOL_NAME = arg('tool-name', 'lsp-stdio-proxy');
const SPAWN = lspArgv();

if (!SPAWN) die('missing LSP command — pass it after --: ...proxy.js --workspace X --port N --lang-id python -- pyright-langserver --stdio');
if (!fs.existsSync(WORKSPACE)) die(`workspace does not exist: ${WORKSPACE}`);

// invalidation matrix keyed on LANG_ID. Same binary drives py/ts/cs/java
// with per-language trigger sets.
//  soft — reload via workspace/didChangeConfiguration + didChangeWatchedFiles
//  hard — restart coordinator (JVM/runtime env frozen at spawn)
const TRIGGERS_BY_LANG = {
  python: {
    soft: ['pyrightconfig.json', 'pyproject.toml', 'setup.cfg', 'setup.py'],
    hard: ['.env', '.env.local', '.python-version'],
  },
  typescript: {
    soft: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    hard: ['.env', '.env.local', 'pnpm-lock.yaml', 'node_modules/.modules.yaml'],
  },
  csharp: {
    soft: ['*.csproj', '*.sln', '*.slnx', 'Directory.Build.props'],
    hard: ['global.json', '.env', '.env.local'],
  },
  java: {
    soft: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'],
    hard: ['.env', '.env.local', '.java-version'],
  },
};
const triggers = TRIGGERS_BY_LANG[LANG_ID] || { soft: [], hard: ['.env', '.env.local'] };

const adapter = createAdapter({
  name: TOOL_NAME,
  cmd: SPAWN.cmd,
  args: SPAWN.args,
  langId: LANG_ID,
  markers: [], // caller resolved workspace already
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
    console.error(`[proxy] child ${id} exited code=${code} sig=${sig} — exiting`);
    process.exit(1);
  });
  proxy.on('spawnError', ({ id, error }) => {
    console.error(`[proxy] child ${id} spawn error: ${error.message}`);
    process.exit(1);
  });
}).catch(e => die(e.message));
