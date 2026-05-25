#!/usr/bin/env node
// test-cs-roslyn-handshake — Slice 2 ship gate for roslyn-reverse-rpc-lsp-stdio.
// Opt-in: skipped when CS_ROSLYN_BIN is unset AND auto-detect finds no
// Microsoft.CodeAnalysis.LanguageServer (no VS Code C# Dev Kit installed).
//
// Asserts:
//   - cs-roslyn-direct starts within 60s without SIGABRT
//   - textDocument/documentSymbol on fixtures/csharp/hello.cs returns ≥2 symbols
//   - process exits clean on stop (no leaked grandchildren)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dirname, '..', '..');
const FIXTURE = join(REPO, 'fixtures', 'csharp');
const WRAPPER = join(REPO, 'bin', 'cs-roslyn-direct');

function resolveRoslynBin() {
  if (process.env.CS_ROSLYN_BIN && existsSync(process.env.CS_ROSLYN_BIN)) {
    return process.env.CS_ROSLYN_BIN;
  }
  const extDir = join(process.env.HOME || '', '.vscode', 'extensions');
  if (!existsSync(extDir)) return null;
  const matches = readdirSync(extDir)
    .filter(n => n.startsWith('ms-dotnettools.csharp-') && n.endsWith('-darwin-arm64'))
    .map(n => join(extDir, n, '.roslyn', 'Microsoft.CodeAnalysis.LanguageServer'))
    .filter(existsSync)
    .sort();
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

const ROSLYN_BIN = resolveRoslynBin();
const SKIP = !ROSLYN_BIN || !existsSync(FIXTURE) || !existsSync(WRAPPER);

test('cs-roslyn-direct: handshake completes + documentSymbol returns ≥2 symbols', { skip: SKIP }, () => {
  // ensure clean slate
  try { execFileSync(WRAPPER, ['stop', FIXTURE], { encoding: 'utf8', stdio: 'pipe' }); } catch {}

  // call documentSymbol — auto-starts the proxy + handshake; success here
  // proves no SIGABRT during initialize+initialized AND a real LSP method
  // round-tripped end-to-end.
  const params = JSON.stringify({ textDocument: { uri: 'file://' + join(FIXTURE, 'hello.cs') } });
  const out = execFileSync(
    WRAPPER,
    ['call', 'textDocument/documentSymbol', params, FIXTURE],
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 }
  );
  const resp = JSON.parse(out);
  assert.ok(resp.result, 'response missing .result — handshake likely failed');
  assert.ok(Array.isArray(resp.result), '.result must be array');
  // recursively count names (heterogeneous shape per topic_local_tool_quirks)
  let n = 0;
  (function walk(arr) {
    for (const s of arr || []) {
      if (s && typeof s.name === 'string') n++;
      if (s && Array.isArray(s.children)) walk(s.children);
    }
  })(resp.result);
  assert.ok(n >= 2, `expected ≥2 symbols, got ${n}`);
});

test('cs-roslyn-direct: stops cleanly + no residual process', { skip: SKIP }, () => {
  const out = execFileSync(WRAPPER, ['stop', FIXTURE], { encoding: 'utf8', stdio: 'pipe' });
  assert.match(out, /stopped|no pid/, 'stop should report success or no-pid');
  // give SIGTERM 2s to reap; coordinator + grandchildren
  execSync('sleep 2');
  // cs-roslyn-direct status exit-code reflects internal port_ready probe under
  // set -euo pipefail (can exit non-zero with valid stdout when no server is
  // alive); tolerate any exit code and parse stdout content directly.
  let status = '';
  try {
    status = execFileSync(WRAPPER, ['status'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    status = (e && e.stdout) || '';
  }
  const lines = status.split('\n').filter(l => l.includes(FIXTURE));
  for (const l of lines) {
    assert.ok(!/alive$/.test(l.trim()), `fixture server still alive after stop: ${l}`);
  }
});
