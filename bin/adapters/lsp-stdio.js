// adapters/lsp-stdio — generic stdio-LSP adapter for tool-server-proxy.
// Behavior-preserving port of bin/lsp-stdio-proxy.js. One child,
// Content-Length framing, LSP initialize handshake, didOpen auto-open,
// null-ack for server-initiated requests.

'use strict';

const fs = require('fs');
const path = require('path');

// langIdForExt — extension → LSP languageId. Falls back to the adapter's
// configured default when unknown. Mirrors the fallback map in
// lsp-stdio-proxy.js verbatim.
function langIdForExt(ext, fallback) {
  switch (ext) {
    case '.py': case '.pyi': return 'python';
    case '.ts': return 'typescript';
    case '.tsx': return 'typescriptreact';
    case '.js': case '.mjs': case '.cjs': return 'javascript';
    case '.jsx': return 'javascriptreact';
    case '.cs': case '.csx': return 'csharp';
    case '.vue': return 'vue';
    case '.scala': case '.sbt': case '.sc': return 'scala';
    case '.java': return 'java';
    default: return fallback;
  }
}

// createAdapter({ name, cmd, args, langId, markers, triggers, didChangeConfigurationSupported })
//   name         — adapter.name (matches wrapper name, e.g. 'py-direct')
//   cmd, args    — LSP server executable + args
//   langId       — default LSP languageId (e.g. 'python')
//   markers      — workspace walk-up markers (for adapter.markers)
//   triggers     — { soft: [...], hard: [...] } invalidation matrix
//   didChangeConfigurationSupported — bool; false → soft trigger falls
//                  back to hard restart
function createAdapter({
  name, cmd, args, langId, markers,
  triggers = { soft: [], hard: [] },
  didChangeConfigurationSupported = true,
}) {
  return {
    name,
    markers,
    triggers,
    didChangeConfigurationSupported,

    spawn(workspace) {
      return [{
        id: 'lsp',
        frame: 'contentLength',
        cmd,
        args,
        cwd: workspace, // servers like csharp-ls bind rootUri at init and require correct cwd
      }];
    },

    async init(ctx) {
      const rpc = ctx.rpc.lsp;
      // install notification/log sink — mirror the filter lsp-stdio-proxy
      // uses (drop noisy diagnostics/progress/telemetry; log unknowns)
      const notificationSink = (msg) => {
        if (
          msg.method === 'window/logMessage' ||
          msg.method === 'textDocument/publishDiagnostics' ||
          msg.method === '$/progress' ||
          msg.method === 'telemetry/event'
        ) return;
        ctx.log('notification:', msg.method);
      };
      // rpc was pre-built by harness; re-wrap with our notification handler
      // (harness's default jsonRpcClient uses null-ack for server-initiated,
      // which is what we want). We monkey-patch onNotification by binding
      // it through handleMessage delegation in onChildMessage below.
      ctx.state.set('notificationSink', notificationSink);
      ctx.state.set('openedUris', new Set());

      const initParams = {
        processId: process.pid,
        clientInfo: { name: 'lsp-stdio-proxy', version: '1.0.0' },
        rootUri: 'file://' + ctx.workspace,
        rootPath: ctx.workspace,
        workspaceFolders: [{ uri: 'file://' + ctx.workspace, name: path.basename(ctx.workspace) }],
        capabilities: {
          textDocument: {
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            implementation: { dynamicRegistration: false, linkSupport: true },
            typeDefinition: { dynamicRegistration: false, linkSupport: true },
            completion: { dynamicRegistration: false, completionItem: { snippetSupport: false } },
            signatureHelp: { dynamicRegistration: false },
            foldingRange: { dynamicRegistration: false },
            callHierarchy: { dynamicRegistration: false },
            synchronization: { dynamicRegistration: false, didSave: true },
            publishDiagnostics: { relatedInformation: true },
          },
          workspace: {
            workspaceFolders: true,
            configuration: true,
            symbol: { dynamicRegistration: false },
          },
        },
        initializationOptions: {},
      };
      await rpc.request('initialize', initParams);
      rpc.notify('initialized', {});
      ctx.log(`initialized (${langId}) workspace=${ctx.workspace}`);
    },

    onChildMessage(childId, msg, ctx) {
      if (childId !== 'lsp') return;
      const rpc = ctx.rpc.lsp;
      // jsonRpcClient.handleMessage covers responses + server-initiated
      // requests (null-ack). Notifications land here too — we filter via
      // the sink stored during init.
      if (msg.method && msg.id === undefined) {
        const sink = ctx.state.get('notificationSink');
        if (sink) sink(msg);
        return;
      }
      rpc.handleMessage(msg);
    },

    async ensureOpen(uri, ctx) {
      const opened = ctx.state.get('openedUris');
      if (opened.has(uri)) return;
      const filePath = uri.replace(/^file:\/\//, '');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      const ext = path.extname(filePath).toLowerCase();
      ctx.rpc.lsp.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: langIdForExt(ext, langId),
          version: 1,
          text: content,
        },
      });
      opened.add(uri);
    },

    async call({ method, params }, ctx) {
      // auto-open the referenced file so servers that bind on-open have it
      const uri = params && params.textDocument && params.textDocument.uri;
      if (uri) await this.ensureOpen(uri, ctx);
      return ctx.rpc.lsp.request(method, params || {});
    },

    async reload(ctx, changed) {
      if (!didChangeConfigurationSupported) {
        throw new Error('didChangeConfiguration not supported — fall back to hard restart');
      }
      ctx.log('didChangeConfiguration reload:', changed.join(', '));
      ctx.rpc.lsp.notify('workspace/didChangeConfiguration', { settings: {} });
      ctx.rpc.lsp.notify('workspace/didChangeWatchedFiles', {
        changes: changed.map(file => ({
          uri: 'file://' + file,
          type: 2, // FileChangeType.Changed
        })),
      });
    },
  };
}

module.exports = { createAdapter, langIdForExt };
