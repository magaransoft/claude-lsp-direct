#!/usr/bin/env node
// test-reverse-rpc.mjs — Slice 1 reverse-RPC dispatch tests for
// roslyn-reverse-rpc-lsp-stdio (ADR-001/002/003/006).
// Run: node bin/tests/test-reverse-rpc.mjs   OR   bin/tests/run.sh

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jsonRpcClient } = require('../tool-harness.js');

// per-method dispatch — handler matches method, invoked with (params, ctx), result sent.
test('reverse-rpc: per-method handler dispatch — result + handler args', () => {
  const sent = [];
  const seenArgs = [];
  const fakeCtx = { workspace: '/tmp/x', tag: 'ctx-marker' };
  const handlers = {
    'workspace/configuration': (params, ctx) => {
      seenArgs.push({ params, ctx });
      return params.items.map(() => ({ enabled: true }));
    },
  };
  const client = jsonRpcClient({ send: msg => sent.push(msg), serverRequestHandlers: handlers, ctx: fakeCtx });
  client.handleMessage({
    jsonrpc: '2.0', id: 42, method: 'workspace/configuration',
    params: { items: [{ section: 'csharp.formatting' }, { section: 'csharp.semantic' }] },
  });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 42, result: [{ enabled: true }, { enabled: true }] });
  assert.equal(seenArgs.length, 1);
  assert.equal(seenArgs[0].ctx, fakeCtx);
  assert.equal(seenArgs[0].params.items.length, 2);
});

// handler throws → -32603 Internal error (ADR-006 — sync handlers + try/catch)
test('reverse-rpc: handler-throw → -32603 Internal error response', () => {
  const sent = [];
  const handlers = {
    'workspace/configuration': () => { throw new Error('boom from handler'); },
  };
  const client = jsonRpcClient({ send: msg => sent.push(msg), serverRequestHandlers: handlers });
  client.handleMessage({ jsonrpc: '2.0', id: 7, method: 'workspace/configuration', params: {} });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 7);
  assert.equal(sent[0].error.code, -32603);
  assert.match(sent[0].error.message, /Internal error: boom from handler/);
});

// default fallthrough 'null-ack' — back-compat preserved (ADR-003)
test('reverse-rpc: default null-ack (no handlers, no default set) → result: null', () => {
  const sent = [];
  const client = jsonRpcClient({ send: msg => sent.push(msg) });
  client.handleMessage({ jsonrpc: '2.0', id: 1, method: 'window/showMessageRequest', params: {} });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 1, result: null });
});

// default fallthrough 'method-class-aware' — -32601 Method not found (ADR-002)
test('reverse-rpc: method-class-aware default (no handlers) → -32601 Method not found', () => {
  const sent = [];
  const client = jsonRpcClient({ send: msg => sent.push(msg), serverRequestDefault: 'method-class-aware' });
  client.handleMessage({ jsonrpc: '2.0', id: 99, method: 'client/registerCapability', params: { registrations: [] } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 99);
  assert.equal(sent[0].error.code, -32601);
  assert.match(sent[0].error.message, /Method not found: client\/registerCapability/);
});

// handler map present but method not in map + method-class-aware default → -32601 (precedence)
test('reverse-rpc: precedence — handler map miss + method-class-aware default → -32601', () => {
  const sent = [];
  const handlers = { 'workspace/configuration': () => [{}] };
  const client = jsonRpcClient({
    send: msg => sent.push(msg),
    serverRequestHandlers: handlers,
    serverRequestDefault: 'method-class-aware',
  });
  client.handleMessage({ jsonrpc: '2.0', id: 11, method: 'window/workDoneProgress/create', params: { token: 't' } });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32601);
  assert.match(sent[0].error.message, /Method not found: window\/workDoneProgress\/create/);
});
