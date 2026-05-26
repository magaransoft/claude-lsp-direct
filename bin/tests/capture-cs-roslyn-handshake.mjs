#!/usr/bin/env node
// capture-cs-roslyn-handshake — one-shot empirical capture of server-initiated
// requests Roslyn LS emits during initialize+initialized handshake.
// Writes JSONL to bin/tests/fixtures/cs-roslyn-handshake.jsonl.
//
// Used to validate the 5-handler set in adapters/cs-roslyn.js is sufficient
// (codex H1 resolution per roslyn-reverse-rpc-lsp-stdio plan Open Q2/Q3).
// Skips when CS_ROSLYN_BIN absent OR auto-detect finds no Roslyn LS.
//
// Run: node bin/tests/capture-cs-roslyn-handshake.mjs

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = resolve(import.meta.dirname, '..', '..');
const WORKSPACE = join(REPO, 'fixtures', 'csharp');
const OUT_PATH = join(REPO, 'bin', 'tests', 'fixtures', 'cs-roslyn-handshake.jsonl');
const TIMEOUT_MS = 30_000;

function resolveRoslynBin() {
  if (process.env.CS_ROSLYN_BIN && existsSync(process.env.CS_ROSLYN_BIN)) {
    return process.env.CS_ROSLYN_BIN;
  }
  const extDir = join(process.env.HOME, '.vscode', 'extensions');
  if (!existsSync(extDir)) return null;
  const matches = readdirSync(extDir)
    .filter(n => n.startsWith('ms-dotnettools.csharp-') && n.endsWith('-darwin-arm64'))
    .map(n => join(extDir, n, '.roslyn', 'Microsoft.CodeAnalysis.LanguageServer'))
    .filter(existsSync)
    .sort();
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

const LSP_BIN = resolveRoslynBin();
if (!LSP_BIN) {
  console.error('[capture] SKIP — Roslyn LS binary not found (set CS_ROSLYN_BIN or install ms-dotnettools.csharp VS Code extension)');
  process.exit(0);
}
if (!existsSync(WORKSPACE)) {
  console.error(`[capture] SKIP — fixture workspace missing: ${WORKSPACE}`);
  process.exit(0);
}

console.error(`[capture] LSP_BIN=${LSP_BIN}`);
console.error(`[capture] WORKSPACE=${WORKSPACE}`);

const child = spawn(LSP_BIN, ['--stdio', '--logLevel', 'Warning'], {
  cwd: WORKSPACE,
  stdio: ['pipe', 'pipe', 'pipe'],
});

// captured server-initiated messages (request + notification) — written as
// JSONL when handshake settles.
const captured = [];
let nextClientId = 1;
const pending = new Map();

function send(msg) {
  const body = JSON.stringify(msg);
  const hdr = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  child.stdin.write(hdr + body);
}

function request(method, params) {
  const id = nextClientId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

// Content-Length framer for incoming bytes.
let buf = Buffer.alloc(0);
function onData(chunk) {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return;
    const hdr = buf.slice(0, sep).toString('utf8');
    const m = hdr.match(/Content-Length: (\d+)/i);
    if (!m) {
      buf = buf.slice(sep + 4);
      continue;
    }
    const len = parseInt(m[1], 10);
    if (buf.length < sep + 4 + len) return;
    const body = buf.slice(sep + 4, sep + 4 + len).toString('utf8');
    buf = buf.slice(sep + 4 + len);
    try {
      const msg = JSON.parse(body);
      handle(msg);
    } catch (e) {
      console.error('[capture] parse error:', e.message);
    }
  }
}

function handle(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); msg.error ? p.reject(msg.error) : p.resolve(msg.result); }
    return;
  }
  if (msg.method) {
    captured.push({ direction: 'server->client', method: msg.method, hasId: msg.id !== undefined, sample: msg });
    if (msg.id !== undefined) {
      // Use cs-roslyn handler shapes to keep server happy.
      const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result });
      switch (msg.method) {
        case 'workspace/configuration':
          reply((msg.params && msg.params.items || []).map(() => ({})));
          break;
        case 'workspace/workspaceFolders':
          reply([{ uri: 'file://' + WORKSPACE, name: basename(WORKSPACE) }]);
          break;
        case 'client/registerCapability':
        case 'window/workDoneProgress/create':
        case 'window/showMessageRequest':
          reply(null);
          break;
        default:
          // unknown — respond -32601 to mirror method-class-aware default
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
      }
    }
  }
}

child.stdout.on('data', onData);
child.stderr.on('data', d => console.error('[lsp stderr]', String(d).trim()));

child.on('exit', (code, sig) => {
  console.error(`[capture] lsp exited code=${code} sig=${sig} captured=${captured.length}`);
  writeFileSync(OUT_PATH, captured.map(c => JSON.stringify(c)).join('\n') + '\n');
  console.error(`[capture] wrote ${OUT_PATH}`);
  if (sig === 'SIGABRT') {
    console.error('[capture] FAIL — Roslyn LS aborted (handshake handler set incomplete)');
    process.exit(2);
  }
});

const deadline = Date.now() + TIMEOUT_MS;
try {
  await request('initialize', {
    processId: process.pid,
    clientInfo: { name: 'cs-roslyn-handshake-capture', version: '1.0.0' },
    rootUri: 'file://' + WORKSPACE,
    rootPath: WORKSPACE,
    workspaceFolders: [{ uri: 'file://' + WORKSPACE, name: basename(WORKSPACE) }],
    capabilities: {
      workspace: { workspaceFolders: true, configuration: true },
      textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } },
    },
    initializationOptions: {},
  });
  notify('initialized', {});
  // let any post-initialized server-initiated traffic flush
  while (Date.now() < deadline) {
    await sleep(2_000);
    // success heuristic: once we've seen ≥1 server-initiated request handled
    // AND no SIGABRT, mark handshake stable
    if (captured.length >= 1 && Date.now() - deadline > -25_000) break;
  }
  console.error(`[capture] handshake stable — captured=${captured.length}`);
  // distinct method set
  const methods = Array.from(new Set(captured.filter(c => c.hasId).map(c => c.method))).sort();
  console.error('[capture] server-initiated request methods:', JSON.stringify(methods));
} catch (e) {
  console.error('[capture] FAIL:', e.message || JSON.stringify(e));
  process.exit(2);
}

writeFileSync(OUT_PATH, captured.map(c => JSON.stringify(c)).join('\n') + '\n');
console.error(`[capture] wrote ${OUT_PATH} (${captured.length} messages)`);
child.kill('SIGTERM');
await sleep(500);
if (!child.killed) child.kill('SIGKILL');
process.exit(0);
