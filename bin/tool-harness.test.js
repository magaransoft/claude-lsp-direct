// smoke tests for tool-harness primitives. Run: node --test bin/tool-harness.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  resolveWorkspace,
  stateDir,
  freePort,
  serveHttp,
  invalidationLoop,
  callLog,
  framing,
  jsonRpcClient,
} = require('./tool-harness.js');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-test-'));
}

test('resolveWorkspace — explicit arg wins', () => {
  const d = tmp();
  const got = resolveWorkspace(['never'], { argvWorkspace: d });
  assert.strictEqual(got, path.resolve(d));
  fs.rmSync(d, { recursive: true });
});

test('resolveWorkspace — walk-up finds marker', () => {
  const root = tmp();
  const deep = path.join(root, 'a', 'b', 'c');
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(root, 'pom.xml'), '');
  const got = resolveWorkspace(['pom.xml'], { cwd: deep });
  assert.strictEqual(got, root);
  fs.rmSync(root, { recursive: true });
});

test('resolveWorkspace — no marker falls back to cwd', () => {
  const d = tmp();
  const got = resolveWorkspace(['nonexistent.marker'], { cwd: d });
  assert.strictEqual(got, path.resolve(d));
  fs.rmSync(d, { recursive: true });
});

test('stateDir — per-workspace hash slot', () => {
  process.env.XYZ_DIRECT_STATE = tmp();
  const a = stateDir('/workspace/a', 'xyz-direct');
  const b = stateDir('/workspace/b', 'xyz-direct');
  assert.notStrictEqual(a, b);
  assert.ok(fs.existsSync(a));
  assert.ok(fs.existsSync(b));
  // deterministic
  assert.strictEqual(a, stateDir('/workspace/a', 'xyz-direct'));
  // env var derived from toolName uppercase with `-` → `_` plus _STATE
  assert.ok(a.startsWith(process.env.XYZ_DIRECT_STATE));
  fs.rmSync(process.env.XYZ_DIRECT_STATE, { recursive: true });
  delete process.env.XYZ_DIRECT_STATE;
});

test('freePort — returns ephemeral port', async () => {
  const p = await freePort();
  assert.ok(p > 1024 && p <= 65535);
});

test('serveHttp — /health and /call', async () => {
  const port = await freePort();
  const http = require('http');
  let called = null;
  const server = serveHttp(port, {
    meta: { kind: 'test' },
    onCall: async ({ method, params }) => { called = { method, params }; return { ok: true, method }; },
  });
  await new Promise(r => server.listen(r));

  // GET /health
  const health = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}/health`, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(JSON.parse(body)));
    }).on('error', reject);
  });
  assert.strictEqual(health.ok, true);
  assert.strictEqual(health.kind, 'test');

  // POST /call
  const callResp = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/call', method: 'POST', headers: { 'Content-Type': 'application/json' } }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ method: 'ping', params: { a: 1 } }));
  });
  assert.strictEqual(callResp.status, 200);
  assert.deepStrictEqual(callResp.body.result, { ok: true, method: 'ping' });
  assert.deepStrictEqual(called, { method: 'ping', params: { a: 1 } });

  // /lsp back-compat alias
  const lspResp = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/lsp', method: 'POST' }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ method: 'ping2', params: {} }));
  });
  assert.deepStrictEqual(lspResp.result, { ok: true, method: 'ping2' });

  await new Promise(r => server.close(r));
});

test('invalidationLoop — first check seeds, no fire', async () => {
  const d = tmp();
  const trigger = path.join(d, 'config.json');
  fs.writeFileSync(trigger, '{}');
  let softFired = 0, hardFired = 0;
  const loop = invalidationLoop({
    stateDir: d,
    softTriggers: ['config.json'],
    hardTriggers: [],
    workspace: d,
    onSoft: () => { softFired++; },
    onHard: () => { hardFired++; },
  });
  await loop.check();
  assert.strictEqual(softFired, 0);
  assert.strictEqual(hardFired, 0);
  fs.rmSync(d, { recursive: true });
});

test('invalidationLoop — soft fires on mtime change', async () => {
  const d = tmp();
  const trigger = path.join(d, 'config.json');
  fs.writeFileSync(trigger, '{}');
  let softChanged = null, hardFired = 0;
  const loop = invalidationLoop({
    stateDir: d,
    softTriggers: ['config.json'],
    hardTriggers: ['.env'],
    workspace: d,
    onSoft: (changed) => { softChanged = changed; },
    onHard: () => { hardFired++; },
  });
  await loop.check(); // seed
  await new Promise(r => setTimeout(r, 15));
  fs.writeFileSync(trigger, '{"v":2}');
  await loop.check(); // fire
  assert.ok(softChanged && softChanged.length === 1);
  assert.strictEqual(hardFired, 0);
  fs.rmSync(d, { recursive: true });
});

test('invalidationLoop — hard wins over soft', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'config.json'), '{}');
  fs.writeFileSync(path.join(d, '.env'), 'A=1');
  let softFired = 0, hardChanged = null;
  const loop = invalidationLoop({
    stateDir: d,
    softTriggers: ['config.json'],
    hardTriggers: ['.env'],
    workspace: d,
    onSoft: () => { softFired++; },
    onHard: (c) => { hardChanged = c; },
  });
  await loop.check();
  await new Promise(r => setTimeout(r, 15));
  fs.writeFileSync(path.join(d, 'config.json'), '{"v":2}');
  fs.writeFileSync(path.join(d, '.env'), 'A=2');
  await loop.check();
  assert.strictEqual(softFired, 0);
  assert.ok(hardChanged && hardChanged.some(p => p.endsWith('/.env')));
  fs.rmSync(d, { recursive: true });
});

test('invalidationLoop — glob patterns', async () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'project.csproj'), '');
  fs.writeFileSync(path.join(d, 'other.csproj'), '');
  let changed = null;
  const loop = invalidationLoop({
    stateDir: d,
    softTriggers: ['*.csproj'],
    hardTriggers: [],
    workspace: d,
    onSoft: (c) => { changed = c; },
  });
  await loop.check();
  await new Promise(r => setTimeout(r, 15));
  fs.writeFileSync(path.join(d, 'project.csproj'), '<Project/>');
  await loop.check();
  assert.ok(changed && changed.some(f => f.endsWith('project.csproj')));
  fs.rmSync(d, { recursive: true });
});

test('callLog — writes JSON lines', () => {
  const d = tmp();
  const logger = callLog(d);
  logger({ method: 'a', ms: 5, adopted: false, outcome: 'ok' });
  logger({ method: 'b', ms: 7, adopted: false, outcome: 'ok' });
  const contents = fs.readFileSync(path.join(d, 'calls.log'), 'utf8');
  const lines = contents.trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(lines[0].method, 'a');
  assert.strictEqual(lines[1].method, 'b');
  assert.ok(lines[0].ts > 0);
  fs.rmSync(d, { recursive: true });
});

test('framing.contentLength — round-trip', () => {
  const { PassThrough } = require('stream');
  const received = [];
  const r = framing.contentLength.reader(m => received.push(m));
  const ps = new PassThrough();
  const w = framing.contentLength.writer(ps);
  ps.on('data', r);
  w({ jsonrpc: '2.0', id: 1, method: 'test', params: { a: 1 } });
  w({ jsonrpc: '2.0', id: 2, method: 'again', params: {} });
  // PassThrough is synchronous enough for the data listener in-turn
  return new Promise(resolve => {
    setImmediate(() => {
      assert.strictEqual(received.length, 2);
      assert.strictEqual(received[0].id, 1);
      assert.strictEqual(received[1].method, 'again');
      resolve();
    });
  });
});

test('framing.jsonLine — round-trip', () => {
  const { PassThrough } = require('stream');
  const received = [];
  const r = framing.jsonLine.reader(m => received.push(m));
  const ps = new PassThrough();
  const w = framing.jsonLine.writer(ps);
  ps.on('data', r);
  w({ seq: 1, type: 'request', command: 'open' });
  w({ seq: 2, type: 'event', event: 'projectLoadingStart' });
  return new Promise(resolve => {
    setImmediate(() => {
      assert.strictEqual(received.length, 2);
      assert.strictEqual(received[0].command, 'open');
      assert.strictEqual(received[1].event, 'projectLoadingStart');
      resolve();
    });
  });
});

test('jsonRpcClient — request/response correlation', async () => {
  const sent = [];
  const client = jsonRpcClient({ send: msg => sent.push(msg) });
  const p = client.request('method/a', { x: 1 });
  const outbound = sent[0];
  assert.strictEqual(outbound.method, 'method/a');
  assert.strictEqual(outbound.id, 1);
  client.handleMessage({ jsonrpc: '2.0', id: outbound.id, result: 'answer' });
  const r = await p;
  assert.strictEqual(r, 'answer');
});

test('jsonRpcClient — server-initiated request gets null-ack by default', () => {
  const sent = [];
  const client = jsonRpcClient({ send: msg => sent.push(msg) });
  client.handleMessage({ jsonrpc: '2.0', id: 99, method: 'workspace/configuration', params: {} });
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0], { jsonrpc: '2.0', id: 99, result: null });
});

test('jsonRpcClient — error response rejects', async () => {
  const sent = [];
  const client = jsonRpcClient({ send: msg => sent.push(msg) });
  const p = client.request('method/fail', {});
  client.handleMessage({ jsonrpc: '2.0', id: sent[0].id, error: { code: -32000, message: 'boom' } });
  await assert.rejects(p, /boom/);
});

test('jsonRpcClient — notification passes through to onNotification', () => {
  const notifications = [];
  const client = jsonRpcClient({
    send: () => {},
    onNotification: (msg) => notifications.push(msg),
  });
  client.handleMessage({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'hi' } });
  assert.strictEqual(notifications.length, 1);
  assert.strictEqual(notifications[0].method, 'window/logMessage');
});
