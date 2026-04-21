#!/usr/bin/env node
// lsp-stdio-proxy — generic Node coordinator: spawns a standalone stdio LSP server, exposes HTTP POST /lsp + GET /health
// usage: node lsp-stdio-proxy.js --workspace <path> --port <N> --lang-id <python|typescript|csharp|...> -- <lsp-cmd> [<lsp-args>...]
// everything after `--` is the LSP server command + args to spawn

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

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

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);
const LANG_ID = arg('lang-id', 'plaintext');
const SPAWN = lspArgv();

function log(...args) { console.error('[proxy]', ...args); }
function die(msg) { console.error('[proxy] fatal:', msg); process.exit(1); }

if (!SPAWN) die('missing LSP command — pass it after --: ...proxy.js --workspace X --port N --lang-id python -- pyright-langserver --stdio');
if (!fs.existsSync(WORKSPACE)) die(`workspace does not exist: ${WORKSPACE}`);

// spawn LSP child — cwd = workspace so servers that bind rootUri at init (e.g. csharp-ls) land inside the project
const child = spawn(SPAWN.cmd, SPAWN.args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: WORKSPACE });
child.stderr.on('data', d => log(`${SPAWN.cmd}:`, d.toString().trim()));
child.on('exit', (code, sig) => { log(`${SPAWN.cmd} exited`, code, sig); process.exit(1); });
child.on('error', e => die(`spawn ${SPAWN.cmd} failed: ${e.message}`));

// ---- LSP framer (Content-Length + JSON body) ----
let buf = Buffer.alloc(0);
const pending = new Map();  // ourId -> {resolve, reject}
let nextId = 0;

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  child.stdin.write(Buffer.concat([header, body]));
}

function request(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

child.stdout.on('data', chunk => {
  buf = Buffer.concat([buf, chunk]);
  while (true) {
    const headerEnd = buf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const headers = buf.slice(0, headerEnd).toString('ascii');
    const m = headers.match(/Content-Length:\s*(\d+)/i);
    if (!m) die(`${SPAWN.cmd}: missing Content-Length header`);
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (buf.length < total) return;
    const body = buf.slice(headerEnd + 4, total).toString('utf8');
    buf = buf.slice(total);
    let msg;
    try { msg = JSON.parse(body); } catch (e) { log('parse error', e.message); continue; }
    onMessage(msg);
  }
});

function onMessage(msg) {
  // response to one of our requests
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
    return;
  }
  // request FROM server (e.g. workspace/configuration) — ack with null to avoid hanging
  if (msg.method && msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  // notification — silently drop (diagnostics, progress, logMessage); log unknowns
  if (msg.method && msg.id === undefined) {
    if (msg.method !== 'window/logMessage'
        && msg.method !== 'textDocument/publishDiagnostics'
        && msg.method !== '$/progress'
        && msg.method !== 'telemetry/event') {
      log('notification:', msg.method);
    }
  }
}

// ---- LSP initialize handshake ----
const openedUris = new Set();

async function init() {
  const initParams = {
    processId: process.pid,
    clientInfo: { name: 'lsp-stdio-proxy', version: '1.0.0' },
    rootUri: 'file://' + WORKSPACE,
    rootPath: WORKSPACE,
    workspaceFolders: [{ uri: 'file://' + WORKSPACE, name: path.basename(WORKSPACE) }],
    capabilities: {
      textDocument: {
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        definition: { dynamicRegistration: false, linkSupport: true },
        references: { dynamicRegistration: false },
        implementation: { dynamicRegistration: false, linkSupport: true },
        typeDefinition: { dynamicRegistration: false, linkSupport: true },
        completion: { dynamicRegistration: false, completionItem: { snippetSupport: false } },
        signatureHelp: { dynamicRegistration: false },
        foldingRange: { dynamicRegistration: false },
        callHierarchy: { dynamicRegistration: false },
        synchronization: { dynamicRegistration: false, didSave: true },
        publishDiagnostics: { relatedInformation: true },
      },
      workspace: {
        workspaceFolders: true,
        configuration: true,
        symbol: { dynamicRegistration: false },
      },
    },
    initializationOptions: {},
  };
  await request('initialize', initParams);
  notify('initialized', {});
  log(`initialized (${LANG_ID}) workspace=${WORKSPACE}`);
}

function langIdForExt(ext) {
  // fallback extension→langId map; explicit --lang-id wins when the opened file's extension matches the server's primary
  switch (ext) {
    case '.py': case '.pyi': return 'python';
    case '.ts': return 'typescript';
    case '.tsx': return 'typescriptreact';
    case '.js': case '.mjs': case '.cjs': return 'javascript';
    case '.jsx': return 'javascriptreact';
    case '.cs': case '.csx': return 'csharp';
    case '.vue': return 'vue';
    case '.scala': case '.sbt': case '.sc': return 'scala';
    default: return LANG_ID;
  }
}

function ensureOpen(uri) {
  if (openedUris.has(uri)) return;
  const filePath = uri.replace(/^file:\/\//, '');
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  notify('textDocument/didOpen', {
    textDocument: { uri, languageId: langIdForExt(ext), version: 1, text: content },
  });
  openedUris.add(uri);
}

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, workspace: WORKSPACE, lang: LANG_ID }));
    return;
  }
  if (req.method === 'POST' && req.url === '/lsp') {
    let body = '';
    req.on('data', c => { body += c.toString('utf8'); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
        return;
      }
      const { method, params } = payload;
      if (!method) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'missing method' }));
        return;
      }
      const uri = params && params.textDocument && params.textDocument.uri;
      if (uri) ensureOpen(uri);
      try {
        const result = await request(method, params || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

(async () => {
  await init();
  server.listen(PORT, '127.0.0.1', () => {
    const actual = server.address().port;
    log(`listening on 127.0.0.1:${actual}`);
  });
})().catch(e => die(e.message));

process.on('SIGTERM', () => { child.kill(); process.exit(0); });
process.on('SIGINT', () => { child.kill(); process.exit(0); });
