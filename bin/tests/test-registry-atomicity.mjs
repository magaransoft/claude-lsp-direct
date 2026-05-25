#!/usr/bin/env node
// test-registry-atomicity.mjs — Slice 3 regression for orphan-teardown ADR-004
// verifies concurrent appends to registry.tsv produce N distinct lines no corruption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import { createRequire } from 'node:module';
const harness = createRequire(import.meta.url)('../tool-harness.js');

test('ADR-004 registry: 8 concurrent appends produce 8 distinct rows (POSIX O_APPEND atomicity)', async () => {
  // use a TEST registry path (not the live one) to avoid contaminating real state
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-registry-'));
  const reg = path.join(tmp, 'registry.tsv');

  // pre-write header in test setup so workers race ONLY on data-row appends (avoids the
  // 1-vs-N writers' "should I write the header?" race which produced flaky line-count failures)
  fs.writeFileSync(reg, 'spawn_ts\tcoordinator_pid\tbackend_pid\twrapper\tworkspace\tparent_pid\n');

  // each appender writes one data row and exits (no header logic — eliminates flakiness)
  const writer = `
    const fs = require('fs');
    const reg = process.argv[1];
    const i = process.argv[2];
    const row = [
      new Date().toISOString(),
      process.pid,
      process.pid + 10000,
      'test-direct',
      '/tmp/fake-ws-' + i,
      process.ppid,
    ].join('\\t') + '\\n';
    fs.appendFileSync(reg, row, { flag: 'a' });
  `;
  const N = 8;
  const procs = [];
  for (let i = 0; i < N; i++) {
    procs.push(spawn('node', ['-e', writer, reg, String(i)], { stdio: ['pipe', 'pipe', 'pipe'] }));
  }
  await Promise.all(procs.map(p => new Promise(res => p.on('exit', res))));

  const content = fs.readFileSync(reg, 'utf8');
  const lines = content.split('\n').filter(Boolean);
  // exact line count assertion — header pre-written + N atomic appends → header + N rows
  assert.equal(lines.length, N + 1, `expected ${N + 1} lines (1 header + ${N} rows), got ${lines.length}\nfull content:\n${content}`);
  // every data row must have exactly 6 tab-separated cols (no interleaving corruption)
  for (let i = 1; i <= N; i++) {
    const cols = lines[i].split('\t');
    assert.equal(cols.length, 6, `row ${i} corruption: ${lines[i]} (cols=${cols.length})`);
  }
  // workspaces must be the N distinct values (no row drop / overwrite)
  const workspaces = lines.slice(1).map(l => l.split('\t')[4]).sort();
  const expected = Array.from({ length: N }, (_, i) => `/tmp/fake-ws-${i}`).sort();
  assert.deepEqual(workspaces, expected, 'all N workspaces must appear (no interleaving / overwriting)');

  // cleanup
  fs.rmSync(tmp, { recursive: true });
});

test('framing.noop has reader+writer that are pure no-ops (drops bytes, never emits)', () => {
  // ADR-003 primitive — used by adapters whose backends speak HTTP/MCP not stdio
  // (e.g. future metals-mcp adapter rewire). Backend stdio is diagnostic-only;
  // tool-server-proxy spawns child with detached:true for process-group control
  // but no framing reader/writer is attached.
  assert.ok(harness.framing.noop, 'framing.noop must exist');
  assert.equal(typeof harness.framing.noop.reader, 'function', 'reader must be a function');
  assert.equal(typeof harness.framing.noop.writer, 'function', 'writer must be a function');
  // reader returns a function that consumes bytes WITHOUT calling the message handler
  let emitted = 0;
  const onMsg = () => { emitted++; };
  const r = harness.framing.noop.reader(onMsg);
  assert.equal(typeof r, 'function', 'reader() must return a function');
  r(Buffer.from('Content-Length: 12\r\n\r\n{"id":1}\n')); // synthesize traffic
  r('plain text');
  r(Buffer.from([0, 1, 2, 3])); // binary garbage
  assert.equal(emitted, 0, 'noop reader MUST never invoke onMessage');
  // writer returns a function that silently swallows any send attempt
  let sentBytes = 0;
  const fakeStream = { write(b) { sentBytes += b.length || b.toString().length; } };
  const w = harness.framing.noop.writer(fakeStream);
  assert.equal(typeof w, 'function', 'writer() must return a function');
  w({ jsonrpc: '2.0', id: 1, method: 'test' });
  assert.equal(sentBytes, 0, 'noop writer MUST never write to the stream');
});

test('ADR-004 registry: lsp-direct-ps reads registry correctly', async () => {
  // synthesize a 3-row registry, invoke lsp-direct-ps with HOME override, assert JSON output
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-ps-'));
  const cacheDir = path.join(tmp, '.cache', 'claude-lsp-direct');
  fs.mkdirSync(cacheDir, { recursive: true });
  const reg = path.join(cacheDir, 'registry.tsv');
  const header = 'spawn_ts\tcoordinator_pid\tbackend_pid\twrapper\tworkspace\tparent_pid\n';
  // use self PID so alive-check returns true for one row
  const livePid = process.pid;
  const deadPid = 999998;
  const now = new Date().toISOString();
  fs.writeFileSync(reg, header +
    `${now}\t${livePid}\t${livePid}\tpy-direct\t/tmp/ws1\t1\n` +
    `${now}\t${deadPid}\t${deadPid}\tts-direct\t/tmp/ws2\t1\n` +
    `${now}\t${livePid}\t${livePid}\tscala-direct\t/tmp/ws3\t1\n`
  );

  // invoke lsp-direct-ps via subprocess with HOME pointed at tmp
  const psBin = path.resolve('/Users/blanquitoh/projects/claude-lsp-direct/bin/lsp-direct-ps');
  const proc = spawn(psBin, ['--json'], {
    env: { ...process.env, HOME: tmp, XDG_CACHE_HOME: path.join(tmp, '.cache') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  proc.stdout.on('data', d => stdout += d);
  const exitCode = await new Promise(res => proc.on('exit', res));
  assert.equal(exitCode, 0, `lsp-direct-ps must exit 0, got ${exitCode}, stdout=${stdout}`);

  const rows = JSON.parse(stdout);
  assert.ok(Array.isArray(rows), 'output must be a JSON array');
  // dead row should be filtered (--all not passed)
  assert.equal(rows.length, 2, `expected 2 live rows, got ${rows.length}`);
  const wrappers = rows.map(r => r.wrapper).sort();
  assert.deepEqual(wrappers, ['py-direct', 'scala-direct']);

  // --all should include the dead row
  const procAll = spawn(psBin, ['--json', '--all'], {
    env: { ...process.env, HOME: tmp, XDG_CACHE_HOME: path.join(tmp, '.cache') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdoutAll = '';
  procAll.stdout.on('data', d => stdoutAll += d);
  await new Promise(res => procAll.on('exit', res));
  const allRows = JSON.parse(stdoutAll);
  assert.equal(allRows.length, 3, 'with --all should include dead entry');

  fs.rmSync(tmp, { recursive: true });
});
