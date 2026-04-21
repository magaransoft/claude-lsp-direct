#!/usr/bin/env node
// vue-direct-coordinator — bridges @vue/language-server (LSP stdio) to raw tsserver (JSON-line stdio)
// exposes HTTP POST /lsp + GET /health on --port; spawns both children, proxies tsserver/request <-> tsserver/response

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : def;
}

const WORKSPACE = path.resolve(arg('workspace', process.cwd()));
const PORT = parseInt(arg('port', '0'), 10);

const NODE_PREFIX = path.dirname(path.dirname(process.execPath));
const GLOBAL_MODULES = path.join(NODE_PREFIX, 'lib', 'node_modules');
const TSSERVER = path.join(GLOBAL_MODULES, 'typescript', 'lib', 'tsserver.js');

if (!fs.existsSync(TSSERVER)) die(`tsserver.js not found at ${TSSERVER} — install 'npm i -g typescript@5.9.3'`);
if (!fs.existsSync(path.join(GLOBAL_MODULES, '@vue', 'typescript-plugin'))) die(`@vue/typescript-plugin not installed globally — 'npm i -g @vue/typescript-plugin@3.2.6'`);

function log(...args) { console.error('[coordinator]', ...args); }
function die(msg) { console.error('[coordinator] fatal:', msg); process.exit(1); }

// ---- child A: vue-language-server (LSP framed) ----
const vue = spawn('vue-language-server', ['--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
vue.stderr.on('data', d => log('vue-ls:', d.toString().trim()));
vue.on('exit', (code, sig) => { log('vue-ls exited', code, sig); if (ts) ts.kill(); process.exit(1); });

// ---- child B: tsserver w/ @vue/typescript-plugin (JSON-line) ----
const ts = spawn(process.execPath, [
  TSSERVER,
  '--useSingleInferredProject',
  '--useInferredProjectPerProjectRoot',
  '--globalPlugins', '@vue/typescript-plugin',
  '--pluginProbeLocations', GLOBAL_MODULES,
  '--allowLocalPluginLoads',
], { stdio: ['pipe', 'pipe', 'pipe'], cwd: WORKSPACE });
ts.stderr.on('data', d => log('tsserver:', d.toString().trim()));
ts.on('exit', (code, sig) => { log('tsserver exited', code, sig); if (vue) vue.kill(); process.exit(1); });

// ---- LSP framer (Content-Length) for vue-ls ----
let vueBuf = Buffer.alloc(0);
const vuePendingRequests = new Map();  // ourId -> {resolve, reject}
let vueOurId = 0;

function vueSend(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  vue.stdin.write(Buffer.concat([header, body]));
}

function vueRequest(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++vueOurId;
    vuePendingRequests.set(id, { resolve, reject });
    vueSend({ jsonrpc: '2.0', id, method, params });
  });
}

function vueNotify(method, params) {
  vueSend({ jsonrpc: '2.0', method, params });
}

function vueNotifyArrayParams(method, tuple) {
  // mirror Vue LS's own connection.sendNotification(method, [id, ...]) wire shape
  // wrapped by vscode-jsonrpc so peer's onNotification receives params[0] = tuple
  vueSend({ jsonrpc: '2.0', method, params: [tuple] });
}

vue.stdout.on('data', chunk => {
  vueBuf = Buffer.concat([vueBuf, chunk]);
  while (true) {
    const headerEnd = vueBuf.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const headers = vueBuf.slice(0, headerEnd).toString('ascii');
    const m = headers.match(/Content-Length:\s*(\d+)/i);
    if (!m) die('vue-ls: missing Content-Length header');
    const len = parseInt(m[1], 10);
    const total = headerEnd + 4 + len;
    if (vueBuf.length < total) return;
    const body = vueBuf.slice(headerEnd + 4, total).toString('utf8');
    vueBuf = vueBuf.slice(total);
    let msg;
    try { msg = JSON.parse(body); } catch (e) { log('vue-ls parse error', e.message); continue; }
    onVueMessage(msg);
  }
});

function onVueMessage(msg) {
  // response
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = vuePendingRequests.get(msg.id);
    if (p) {
      vuePendingRequests.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
    return;
  }
  // notification
  if (msg.method && msg.id === undefined) {
    if (msg.method === 'tsserver/request') {
      // Vue LS sends connection.sendNotification(m, [id,cmd,args]); vscode-jsonrpc wraps the array in params
      // so msg.params shape is [[id,cmd,args]] — unwrap if first element is itself the tuple
      const tuple = Array.isArray(msg.params[0]) ? msg.params[0] : msg.params;
      const [vueReqId, command, args] = tuple;
      const tsSeq = tsNextSeq();
      tsRequests.set(tsSeq, vueReqId);
      tsSend({ seq: tsSeq, type: 'request', command, arguments: args });
      return;
    }
    // other notifications (window/logMessage, textDocument/publishDiagnostics, etc.) — log and drop
    if (msg.method !== 'window/logMessage' && msg.method !== 'textDocument/publishDiagnostics') {
      log('vue-ls notification:', msg.method);
    }
    return;
  }
  // request from server (rare — window/workDoneProgress/create etc.) — ack blindly
  if (msg.method && msg.id !== undefined) {
    vueSend({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
}

// ---- tsserver framer (JSON-line) ----
let tsBuf = '';
let tsSeq = 0;
const tsRequests = new Map();  // tsSeq -> vueReqId (bridge path)
const tsLocalPending = new Map();  // tsSeq -> {resolve} (coordinator's own calls)

function tsNextSeq() { return ++tsSeq; }

function tsSend(msg) {
  ts.stdin.write(JSON.stringify(msg) + '\n');
}

function tsLocalRequest(command, args) {
  return new Promise(resolve => {
    const seq = tsNextSeq();
    tsLocalPending.set(seq, resolve);
    tsSend({ seq, type: 'request', command, arguments: args });
  });
}

ts.stdout.on('data', chunk => {
  tsBuf += chunk.toString('utf8');
  // tsserver may use Content-Length framing on some messages — handle both
  while (tsBuf.length > 0) {
    if (tsBuf.startsWith('Content-Length:')) {
      const headerEnd = tsBuf.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const headers = tsBuf.slice(0, headerEnd);
      const m = headers.match(/Content-Length:\s*(\d+)/i);
      if (!m) { tsBuf = tsBuf.slice(headerEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      const total = headerEnd + 4 + len;
      if (Buffer.byteLength(tsBuf, 'utf8') < total) return;
      const body = tsBuf.slice(headerEnd + 4, total);
      tsBuf = tsBuf.slice(total);
      onTsLine(body);
    } else {
      const nl = tsBuf.indexOf('\n');
      if (nl < 0) return;
      const line = tsBuf.slice(0, nl).trim();
      tsBuf = tsBuf.slice(nl + 1);
      if (line) onTsLine(line);
    }
  }
});

function onTsLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { return; }
  if (msg.type === 'response' && msg.request_seq !== undefined) {
    const local = tsLocalPending.get(msg.request_seq);
    if (local) {
      tsLocalPending.delete(msg.request_seq);
      local(msg.body);
      return;
    }
    const vueReqId = tsRequests.get(msg.request_seq);
    if (vueReqId !== undefined) {
      tsRequests.delete(msg.request_seq);
      vueNotifyArrayParams('tsserver/response', [vueReqId, msg.body]);
    }
    return;
  }
  if (msg.type === 'event') return;
}

// ---- LSP initialize handshake with Vue LS ----
const openedUris = new Set();

async function initVue() {
  const initParams = {
    processId: process.pid,
    clientInfo: { name: 'vue-direct-coordinator', version: '1.0.0' },
    rootUri: 'file://' + WORKSPACE,
    workspaceFolders: [{ uri: 'file://' + WORKSPACE, name: path.basename(WORKSPACE) }],
    capabilities: {
      textDocument: {
        documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
        hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
        definition: { dynamicRegistration: false, linkSupport: true },
        references: { dynamicRegistration: false },
        implementation: { dynamicRegistration: false, linkSupport: true },
        typeDefinition: { dynamicRegistration: false, linkSupport: true },
        completion: { dynamicRegistration: false },
        signatureHelp: { dynamicRegistration: false },
        foldingRange: { dynamicRegistration: false },
        semanticTokens: { dynamicRegistration: false, requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] },
        synchronization: { dynamicRegistration: false, didSave: true },
        publishDiagnostics: { relatedInformation: true },
      },
      workspace: {
        workspaceFolders: true,
        configuration: true,
        symbol: { dynamicRegistration: false },
      },
    },
    initializationOptions: {
      typescript: { tsdk: path.join(GLOBAL_MODULES, 'typescript', 'lib') },
    },
  };
  await vueRequest('initialize', initParams);
  vueNotify('initialized', {});
  log('vue-ls initialized');
}

async function ensureOpen(uri) {
  if (openedUris.has(uri)) return;
  const filePath = uri.replace(/^file:\/\//, '');
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const ext = path.extname(filePath).toLowerCase();
  const langId = ext === '.vue' ? 'vue'
    : ext === '.ts' ? 'typescript'
    : ext === '.tsx' ? 'typescriptreact'
    : ext === '.js' ? 'javascript'
    : ext === '.jsx' ? 'javascriptreact'
    : 'plaintext';
  // open in tsserver FIRST and await acknowledgment via a paired projectInfo call
  // (tsserver's `open` is notification-shaped — no direct response — so we piggyback on projectInfo)
  tsSend({
    seq: tsNextSeq(),
    type: 'request',
    command: 'open',
    arguments: { file: filePath, fileContent: content, projectRootPath: WORKSPACE },
  });
  // await project load so Vue LS's later _vue:projectInfo sees the file already associated
  await tsLocalRequest('projectInfo', { file: filePath, needFileNameList: false });
  // then tell Vue LS about it
  vueNotify('textDocument/didOpen', {
    textDocument: { uri, languageId: langId, version: 1, text: content },
  });
  openedUris.add(uri);
}

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, workspace: WORKSPACE }));
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
      // auto-open referenced file so the server has it in context
      const uri = params && params.textDocument && params.textDocument.uri;
      if (uri) await ensureOpen(uri);
      try {
        const result = await vueRequest(method, params || {});
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

function findWarmupTs(workspace) {
  // locate any .ts file in workspace/src to force tsconfig project load
  // (tsserver ignores `open` on .vue unless a project containing the plugin is live)
  const srcDir = path.join(workspace, 'src');
  if (!fs.existsSync(srcDir)) return null;
  const stack = [srcDir];
  while (stack.length) {
    const d = stack.shift();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        return full;
      }
    }
  }
  return null;
}

async function warmupTsserver() {
  const warmup = findWarmupTs(WORKSPACE);
  if (!warmup) { log('no .ts warmup file found under', WORKSPACE); return; }
  log('tsserver warmup via', warmup);
  const content = fs.readFileSync(warmup, 'utf8');
  tsSend({
    seq: tsNextSeq(),
    type: 'request',
    command: 'open',
    arguments: { file: warmup, fileContent: content, projectRootPath: WORKSPACE },
  });
  // await project load via our own projectInfo — ensures tsconfig + plugin are live
  const info = await tsLocalRequest('projectInfo', { file: warmup, needFileNameList: false });
  log('tsserver warmed: configFileName=', info && info.configFileName);
}

(async () => {
  // configure @vue/typescript-plugin in tsserver before anything else touches it
  tsSend({
    seq: tsNextSeq(),
    type: 'request',
    command: 'configurePlugin',
    arguments: { pluginName: '@vue/typescript-plugin', configuration: {} },
  });
  await warmupTsserver();
  await initVue();
  server.listen(PORT, '127.0.0.1', () => {
    const actual = server.address().port;
    log(`listening on 127.0.0.1:${actual} workspace=${WORKSPACE}`);
  });
})().catch(e => die(e.message));

process.on('SIGTERM', () => { vue.kill(); ts.kill(); process.exit(0); });
process.on('SIGINT', () => { vue.kill(); ts.kill(); process.exit(0); });
