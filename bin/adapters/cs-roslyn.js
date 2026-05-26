// adapters/cs-roslyn — Microsoft Roslyn Language Server adapter.
// Thin wrapper around adapters/lsp-stdio: same handshake + framing,
// but supplies 5 reverse-RPC handlers + 'method-class-aware' default
// so Roslyn LS's OnInitializedAsync completes without SIGABRT.
//
// See roslyn-reverse-rpc-lsp-stdio plan:
//   - ADR-001 — per-adapter serverRequestHandlers map
//   - ADR-002 — method-class-aware default (unknown → -32601)
//   - ADR-003 — opt-in per-adapter (back-compat for non-Roslyn wrappers)
//   - ADR-004 — window/showMessageRequest → null with env-var override
//   - ADR-006 — synchronous handlers only

'use strict';

const path = require('path');
const lspStdio = require('./lsp-stdio.js');

// buildHandlers — returns { lsp: { method: fn } } keyed by child id.
// lsp-stdio adapter uses child id 'lsp' for its single stdio process.
function buildHandlers() {
  return {
    lsp: {
      // workspace/configuration — Roslyn requests config per items[i].section.
      // LSP spec: respond with array of same length as params.items; one
      // entry per section. Empty-object default is spec-compliant fallback;
      // section-specific shapes can be added per ADR-001 reversibility trigger.
      'workspace/configuration': (params) => {
        const items = (params && params.items) || [];
        return items.map(() => ({}));
      },

      // workspace/workspaceFolders — Roslyn may re-query the folder set
      // post-initialize. Return single folder derived from ctx.workspace.
      'workspace/workspaceFolders': (_params, ctx) => {
        return [{ uri: 'file://' + ctx.workspace, name: path.basename(ctx.workspace) }];
      },

      // client/registerCapability — Roslyn requests dynamic capability
      // registration for didChangeConfiguration etc. We don't honor dynamic
      // registration today; null ack signals success without binding.
      'client/registerCapability': () => null,

      // window/workDoneProgress/create — Roslyn creates a progress token
      // for long-running operations. Null ack accepts the token without
      // implementing client-side progress UI.
      'window/workDoneProgress/create': () => null,

      // window/showMessageRequest — Roslyn surfaces interactive dialogs
      // (e.g. "Switch to Debug build? [Yes / No]"). Default null = user
      // dismissed without picking. Per ADR-004:
      //   - emit stderr line on every dismissal exposing recovery path
      //   - CS_ROSLYN_MESSAGE_RESPONSE=<idx> env var auto-picks action
      'window/showMessageRequest': (params) => {
        const actions = (params && params.actions) || [];
        const env = process.env.CS_ROSLYN_MESSAGE_RESPONSE;
        if (env !== undefined && env !== '') {
          const idx = parseInt(env, 10);
          if (Number.isInteger(idx) && idx >= 0 && idx < actions.length) {
            return actions[idx];
          }
        }
        const title = (params && params.message) || '';
        const labels = actions.map((a, i) => `${i}:${(a && a.title) || JSON.stringify(a)}`).join(',');
        process.stderr.write(
          `[cs-roslyn] showMessageRequest dismissed: title="${title}" actions=[${labels}] — set CS_ROSLYN_MESSAGE_RESPONSE=<idx> to auto-pick\n`
        );
        return null;
      },
    },
  };
}

// createAdapter — delegates to lsp-stdio.createAdapter with reverse-RPC
// opt-in (handler map + 'method-class-aware' default). Accepts the same
// option shape as lsp-stdio; caller-supplied serverRequestHandlers /
// serverRequestDefault override the cs-roslyn defaults below.
function createAdapter(opts) {
  const optionsWithReverseRpc = {
    ...opts,
    serverRequestHandlers: opts.serverRequestHandlers || buildHandlers(),
    serverRequestDefault: opts.serverRequestDefault || 'method-class-aware',
  };
  return lspStdio.createAdapter(optionsWithReverseRpc);
}

module.exports = { createAdapter, buildHandlers };
