// smoke tests for createProxy using an in-process echo adapter.
// Run: node --test bin/tool-server-proxy.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const http = require('http');

const { createProxy } = require('./tool-server-proxy.js');
const { freePort, framing } = require('./tool-harness.js');

// FakeChild — satisfies the shape the proxy expects (stdin, stdout,
// stderr, event emitter, kill). stdout is a PassThrough we can push
// framed bytes into; stdin is a PassThrough we capture.
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit('exit', 0, null);
  return child;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
}

async function httpPost(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

test('createProxy — single contentLength child, echo adapter', async () => {
  const workspace = tmp();
  process.env.ECHO_STATE = tmp();
  const port = await freePort();

  const child = makeFakeChild();
  const adapter = {
    name: 'echo',
    markers: [],
    spawn: () => [{ id: 'srv', frame: 'contentLength', proc: child }],
    async init(ctx) {
      // nothing to handshake — echo adapter doesn't init
    },
    onChildMessage(childId, msg, ctx) {
      if (childId === 'srv') ctx.handleJsonRpc('srv', msg);
    },
    async call({ method, params }, ctx) {
      return ctx.request('srv', method, params);
    },
    triggers: { soft: [], hard: [] },
  };

  // simulate the child answering every request with the method name
  const childWriter = framing.contentLength.writer(child.stdout);
  const readFromStdin = framing.contentLength.reader(msg => {
    childWriter({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method, params: msg.params } });
  });
  child.stdin.on('data', readFromStdin);

  const proxy = await createProxy({ adapter, workspace, port, toolName: 'echo' });

  const resp = await httpPost(port, '/call', { method: 'ping', params: { a: 1 } });
  assert.strictEqual(resp.status, 200);
  assert.deepStrictEqual(resp.body.result, { echoed: 'ping', params: { a: 1 } });

  // /lsp back-compat
  const resp2 = await httpPost(port, '/lsp', { method: 'pong', params: {} });
  assert.deepStrictEqual(resp2.body.result, { echoed: 'pong', params: {} });

  // calls.log contains entries
  const stateDirPath = path.join(process.env.ECHO_STATE, require('crypto').createHash('sha1').update(workspace).digest('hex').slice(0, 12));
  const logLines = fs.readFileSync(path.join(stateDirPath, 'calls.log'), 'utf8').trim().split('\n');
  assert.strictEqual(logLines.length, 2);
  assert.strictEqual(JSON.parse(logLines[0]).method, 'ping');
  assert.strictEqual(JSON.parse(logLines[1]).method, 'pong');

  await new Promise(r => proxy.close(r));
  fs.rmSync(workspace, { recursive: true });
  fs.rmSync(process.env.ECHO_STATE, { recursive: true });
  delete process.env.ECHO_STATE;
});

test('createProxy — call error surfaces as HTTP 500', async () => {
  const workspace = tmp();
  process.env.FAIL_STATE = tmp();
  const port = await freePort();
  const child = makeFakeChild();

  const adapter = {
    name: 'fail',
    markers: [],
    spawn: () => [{ id: 'srv', frame: 'contentLength', proc: child }],
    async init() {},
    onChildMessage() {},
    async call() { throw new Error('adapter boom'); },
    triggers: { soft: [], hard: [] },
  };

  const proxy = await createProxy({ adapter, workspace, port, toolName: 'fail' });
  const resp = await httpPost(port, '/call', { method: 'x', params: {} });
  assert.strictEqual(resp.status, 500);
  assert.strictEqual(resp.body.error, 'adapter boom');

  await new Promise(r => proxy.close(r));
  fs.rmSync(workspace, { recursive: true });
  fs.rmSync(process.env.FAIL_STATE, { recursive: true });
  delete process.env.FAIL_STATE;
});
