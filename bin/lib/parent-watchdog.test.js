// smoke tests for parent-watchdog. Run: node --test bin/lib/parent-watchdog.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const { isAliveOrUnknown, parseParentPidArg, installParentWatchdog } = require('./parent-watchdog.js');

test('parseParentPidArg returns integer when --parent-pid present', () => {
  assert.strictEqual(parseParentPidArg(['node', 'x', '--parent-pid', '12345']), 12345);
});

test('parseParentPidArg returns null when arg missing', () => {
  assert.strictEqual(parseParentPidArg(['node', 'x']), null);
});

test('parseParentPidArg returns null when value is non-integer', () => {
  assert.strictEqual(parseParentPidArg(['node', 'x', '--parent-pid', 'abc']), null);
});

test('parseParentPidArg returns null when value is < 2 (init pid is a hard skip)', () => {
  assert.strictEqual(parseParentPidArg(['node', 'x', '--parent-pid', '1']), null);
  assert.strictEqual(parseParentPidArg(['node', 'x', '--parent-pid', '0']), null);
});

test('isAliveOrUnknown returns true for current process', () => {
  assert.strictEqual(isAliveOrUnknown(process.pid), true);
});

test('isAliveOrUnknown returns false for impossibly-large pid', () => {
  // pid 2^31-1 is reserved/never used on macOS+linux; skip if it happens to exist
  assert.strictEqual(isAliveOrUnknown(2147483646), false);
});

test('installParentWatchdog returns null when parentPid is null/0/1', () => {
  assert.strictEqual(installParentWatchdog({ parentPid: null }), null);
  assert.strictEqual(installParentWatchdog({ parentPid: 0 }), null);
  assert.strictEqual(installParentWatchdog({ parentPid: 1 }), null);
});

test('installParentWatchdog returns null when LSP_DISABLE_PARENT_WATCHDOG=1', () => {
  const prev = process.env.LSP_DISABLE_PARENT_WATCHDOG;
  process.env.LSP_DISABLE_PARENT_WATCHDOG = '1';
  try {
    const h = installParentWatchdog({ parentPid: process.pid, pollMs: 100 });
    assert.strictEqual(h, null);
  } finally {
    if (prev === undefined) delete process.env.LSP_DISABLE_PARENT_WATCHDOG;
    else process.env.LSP_DISABLE_PARENT_WATCHDOG = prev;
  }
});

test('installParentWatchdog installs when parentPid is alive', () => {
  const h = installParentWatchdog({ parentPid: process.pid, pollMs: 100000 });
  assert.ok(h && typeof h.stop === 'function');
  h.stop();
});

test('end-to-end: child process exits when parent dies', { timeout: 15000 }, async () => {
  // spawn a fake parent that lives 1s then exits.
  const parent = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 1000)'], { stdio: 'ignore' });
  const parentPid = parent.pid;

  // spawn child node that installs watchdog tracking the fake parent.
  // child polls every 200ms so we should see it exit within ~1.5s of parent death.
  const childScript = `
    const { installParentWatchdog } = require('${path.resolve(__dirname, 'parent-watchdog.js').replace(/'/g, "\\'")}');
    installParentWatchdog({ parentPid: ${parentPid}, pollMs: 200, toolName: 'test-child' });
    setInterval(() => {}, 60000); // keep alive; watchdog must terminate us
  `;
  const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'ignore', 'pipe'] });

  // wait for child to exit; should happen within ~2s of parent death
  const exited = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child did not exit within 10s after parent death'));
    }, 10000);
    child.on('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.strictEqual(exited, 0, 'child should exit cleanly via watchdog (code 0)');
});
