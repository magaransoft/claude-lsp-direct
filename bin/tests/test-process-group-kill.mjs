#!/usr/bin/env node
// test-process-group-kill.mjs — Slice 1 regression for orphan-teardown ADR-001 + ADR-002
// Uses node:test built-in (no deps). Run: node bin/tests/test-process-group-kill.mjs
// Or via: bin/tests/run.sh (collects all .mjs tests)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}

function pidPgid(pid) {
  try {
    return parseInt(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim(), 10);
  } catch { return null; }
}

test('ADR-001: spawn with detached:true creates new process group on macOS/Linux', async () => {
  // helper subprocess that forks a grandchild then sleeps
  const helper = `
    const { spawn } = require('child_process');
    const child = spawn('sleep', ['60'], { detached: false });
    console.log('grandchild:' + child.pid);
    setTimeout(() => {}, 60000);
  `;
  const parent = spawn('node', ['-e', helper], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let grandchildPid = null;
  parent.stdout.on('data', d => {
    const m = String(d).match(/grandchild:(\d+)/);
    if (m) grandchildPid = parseInt(m[1], 10);
  });
  // wait for grandchild emission
  for (let i = 0; i < 30 && !grandchildPid; i++) await sleep(100);
  assert.ok(grandchildPid, 'grandchild PID not captured within 3s');

  const parentPgid = pidPgid(parent.pid);
  assert.equal(parentPgid, parent.pid, 'detached parent MUST be its own process group leader');

  const grandchildPgid = pidPgid(grandchildPid);
  assert.equal(grandchildPgid, parent.pid, 'grandchild MUST inherit parent process group (no detached on grandchild)');

  // group-kill via negative PID — reaps parent + grandchild atomically
  try { process.kill(-parent.pid, 'SIGTERM'); } catch (e) { assert.fail(`group-kill failed: ${e.message}`); }
  await sleep(500);
  assert.equal(pidAlive(parent.pid), false, 'parent should be dead after group-kill');
  assert.equal(pidAlive(grandchildPid), false, 'grandchild should be dead after group-kill — closes ADR-001 leak');
});

test('ADR-001: killGroup falls back to direct kill when group-kill fails', async () => {
  // exercise the fallback path in killGroup — group-kill returns ESRCH if no group exists.
  // Spawn WITHOUT detached, then attempt group-kill (will likely fail); fallback to proc.kill().
  const child = spawn('sleep', ['60'], { detached: false });
  await sleep(100);
  // mirror killGroup logic
  let groupKillFailed = false;
  try { process.kill(-child.pid, 'SIGTERM'); } catch (e) { groupKillFailed = true; }
  if (groupKillFailed) {
    try { child.kill('SIGTERM'); } catch {}
  }
  await sleep(500);
  assert.equal(pidAlive(child.pid), false, 'fallback direct-kill must terminate child');
});

test('ADR-002: signal-0 probe returns ESRCH for nonexistent PID (OS contract)', () => {
  // The parent-watchdog block in tool-server-proxy.js relies on this contract:
  // kill(pid, 0) returns success if PID alive, throws ESRCH if dead.
  // High-numbered fake PID is very unlikely to map to any real process.
  const fakePid = 999999;
  let err;
  try { process.kill(fakePid, 0); } catch (e) { err = e; }
  assert.ok(err, `expected exception for fake PID ${fakePid}`);
  assert.equal(err.code, 'ESRCH', `expected ESRCH, got ${err.code}`);
});

test('ADR-002: signal-0 probe succeeds silently for live self PID', () => {
  // Mirror image of the ESRCH case: live PID must NOT throw.
  process.kill(process.pid, 0); // throws → test fails
});

test('ADR-002: parent-watchdog interval loop semantics — exits on first ESRCH catch', async () => {
  // Simulate the production watchdog loop with controllable "parent dead at iteration N".
  // verifies the catch-then-exit shape used in tool-server-proxy.js
  // NOTE: in 'node -e SCRIPT arg1 arg2' mode, argv[0]=node, argv[1]=arg1, argv[2]=arg2.
  // node does NOT inject script source as argv[1]. Watch the indices.
  const script = `
    let iters = 0;
    const aliveAfter = parseInt(process.argv[1], 10);
    const timer = setInterval(() => {
      iters++;
      if (iters > aliveAfter) {
        // simulate parent gone by probing a guaranteed-dead PID
        try { process.kill(999998, 0); }
        catch (e) { if (e.code === 'ESRCH') { console.log('ITERS=' + iters); process.exit(7); } }
      } else {
        // live phase: probe self (always succeeds)
        try { process.kill(process.pid, 0); } catch {}
      }
    }, 50);
    timer.unref();
    setTimeout(() => process.exit(99), 3000);
  `;
  const proc = spawn('node', ['-e', script, '3'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  proc.stdout.on('data', d => out += String(d));
  const exitCode = await new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  assert.equal(exitCode, 7, `watchdog must exit with code 7 on ESRCH — got ${exitCode}, stdout=${out}`);
  const itersMatch = out.match(/ITERS=(\d+)/);
  assert.ok(itersMatch, 'iteration count must be reported');
  assert.ok(parseInt(itersMatch[1], 10) >= 4, 'must exit AFTER aliveAfter threshold');
});
