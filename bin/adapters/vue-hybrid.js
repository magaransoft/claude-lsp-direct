// adapters/vue-hybrid — Vue Language Server v3 + paired tsserver hosting
// @vue/typescript-plugin. Behavior-preserving port of
// bin/vue-direct-coordinator.js. Two children, mixed framings,
// bidirectional tsserver/request ↔ tsserver/response bridging.

'use strict';

const fs = require('fs');
const path = require('path');

const NODE_PREFIX = path.dirname(path.dirname(process.execPath));
const GLOBAL_MODULES = path.join(NODE_PREFIX, 'lib', 'node_modules');
const TSSERVER = path.join(GLOBAL_MODULES, 'typescript', 'lib', 'tsserver.js');

function extLangId(ext) {
  if (ext === '.vue') return 'vue';
  if (ext === '.ts') return 'typescript';
  if (ext === '.tsx') return 'typescriptreact';
  if (ext === '.js') return 'javascript';
  if (ext === '.jsx') return 'javascriptreact';
  return 'plaintext';
}

function findWarmupTs(workspace) {
  const srcDir = path.join(workspace, 'src');
  if (!fs.existsSync(srcDir)) return null;
  const stack = [srcDir];
  while (stack.length) {
    const d = stack.shift();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
        return full;
      }
    }
  }
  return null;
}

function createAdapter({
  name = 'vue-direct',
  markers = ['package.json'],
  triggers = {
    soft: ['tsconfig.json', 'package.json', 'vue.config.js', 'vue.config.ts', 'vue.config.mjs'],
    hard: ['.env', '.env.local', 'pnpm-lock.yaml'],
  },
} = {}) {
  return {
    name,
    markers,
    triggers,
    didChangeConfigurationSupported: true,

    spawn(workspace) {
      if (!fs.existsSync(TSSERVER)) {
        throw new Error(`tsserver.js not found at ${TSSERVER} — install 'npm i -g typescript@5.9.3'`);
      }
      if (!fs.existsSync(path.join(GLOBAL_MODULES, '@vue', 'typescript-plugin'))) {
        throw new Error(`@vue/typescript-plugin not installed globally — 'npm i -g @vue/typescript-plugin@3.2.6'`);
      }
      return [
        {
          id: 'vue',
          frame: 'contentLength',
          cmd: 'vue-language-server',
          args: ['--stdio'],
        },
        {
          id: 'ts',
          frame: 'tsserverMixed',
          cmd: process.execPath,
          args: [
            TSSERVER,
            '--useSingleInferredProject',
            '--useInferredProjectPerProjectRoot',
            '--globalPlugins', '@vue/typescript-plugin',
            '--pluginProbeLocations', GLOBAL_MODULES,
            '--allowLocalPluginLoads',
          ],
          cwd: workspace,
        },
      ];
    },

    async init(ctx) {
      // adapter state — tsserver bookkeeping not covered by the generic
      // jsonRpcClient helper (ts uses seq correlation, not jsonrpc id).
      ctx.state.set('tsSeq', 0);
      ctx.state.set('tsLocalPending', new Map());  // tsSeq → resolver
      ctx.state.set('tsRequestBridge', new Map()); // tsSeq → vueReqId (for tsserver/request forwarding)
      ctx.state.set('openedUris', new Set());

      // 1. configurePlugin in tsserver BEFORE anything else touches it
      const tsNextSeq = () => { const n = ctx.state.get('tsSeq') + 1; ctx.state.set('tsSeq', n); return n; };
      ctx.send('ts', {
        seq: tsNextSeq(),
        type: 'request',
        command: 'configurePlugin',
        arguments: { pluginName: '@vue/typescript-plugin', configuration: {} },
      });

      // 2. warmup via a .ts seed — forces tsconfig load + plugin activation
      const warmup = findWarmupTs(ctx.workspace);
      if (warmup) {
        ctx.log('tsserver warmup via', warmup);
        const content = fs.readFileSync(warmup, 'utf8');
        ctx.send('ts', {
          seq: tsNextSeq(),
          type: 'request',
          command: 'open',
          arguments: { file: warmup, fileContent: content, projectRootPath: ctx.workspace },
        });
        const info = await tsLocalRequest(ctx, 'projectInfo', { file: warmup, needFileNameList: false });
        ctx.log('tsserver warmed: configFileName=', info && info.configFileName);
      } else {
        ctx.log('no .ts warmup file found under', ctx.workspace);
      }

      // 3. initialize vue-ls
      const initParams = {
        processId: process.pid,
        clientInfo: { name: 'vue-direct-coordinator', version: '1.0.0' },
        rootUri: 'file://' + ctx.workspace,
        workspaceFolders: [{ uri: 'file://' + ctx.workspace, name: path.basename(ctx.workspace) }],
        capabilities: {
          textDocument: {
            documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
            hover: { dynamicRegistration: false, contentFormat: ['markdown', 'plaintext'] },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            implementation: { dynamicRegistration: false, linkSupport: true },
            typeDefinition: { dynamicRegistration: false, linkSupport: true },
            completion: { dynamicRegistration: false },
            signatureHelp: { dynamicRegistration: false },
            foldingRange: { dynamicRegistration: false },
            semanticTokens: { dynamicRegistration: false, requests: { full: true }, tokenTypes: [], tokenModifiers: [], formats: ['relative'] },
            synchronization: { dynamicRegistration: false, didSave: true },
            publishDiagnostics: { relatedInformation: true },
          },
          workspace: {
            workspaceFolders: true,
            configuration: true,
            symbol: { dynamicRegistration: false },
          },
        },
        initializationOptions: {
          typescript: { tsdk: path.join(GLOBAL_MODULES, 'typescript', 'lib') },
        },
      };
      await ctx.rpc.vue.request('initialize', initParams);
      ctx.rpc.vue.notify('initialized', {});
      ctx.log('vue-ls initialized');
    },

    onChildMessage(childId, msg, ctx) {
      if (childId === 'vue') {
        // response + null-ack on server-initiated
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          ctx.rpc.vue.handleMessage(msg);
          return;
        }
        if (msg.method && msg.id !== undefined) {
          // rare window/workDoneProgress/create etc. — ack blindly
          ctx.rpc.vue.handleMessage(msg);
          return;
        }
        if (msg.method && msg.id === undefined) {
          if (msg.method === 'tsserver/request') {
            // vscode-jsonrpc wraps tuple arrays — unwrap conditionally
            const tuple = Array.isArray(msg.params[0]) ? msg.params[0] : msg.params;
            const [vueReqId, command, args] = tuple;
            const tsSeq = ctx.state.get('tsSeq') + 1;
            ctx.state.set('tsSeq', tsSeq);
            ctx.state.get('tsRequestBridge').set(tsSeq, vueReqId);
            ctx.send('ts', { seq: tsSeq, type: 'request', command, arguments: args });
            return;
          }
          if (msg.method !== 'window/logMessage' && msg.method !== 'textDocument/publishDiagnostics') {
            ctx.log('vue-ls notification:', msg.method);
          }
        }
        return;
      }

      if (childId === 'ts') {
        if (msg.type === 'response' && msg.request_seq !== undefined) {
          const local = ctx.state.get('tsLocalPending').get(msg.request_seq);
          if (local) {
            ctx.state.get('tsLocalPending').delete(msg.request_seq);
            local(msg.body);
            return;
          }
          const vueReqId = ctx.state.get('tsRequestBridge').get(msg.request_seq);
          if (vueReqId !== undefined) {
            ctx.state.get('tsRequestBridge').delete(msg.request_seq);
            // double-wrap array-params per vscode-jsonrpc convention
            ctx.send('vue', {
              jsonrpc: '2.0',
              method: 'tsserver/response',
              params: [[vueReqId, msg.body]],
            });
          }
          return;
        }
        if (msg.type === 'event') return; // drop tsserver events
      }
    },

    async ensureOpen(uri, ctx) {
      const opened = ctx.state.get('openedUris');
      if (opened.has(uri)) return;
      const filePath = uri.replace(/^file:\/\//, '');
      if (!fs.existsSync(filePath)) return;
      const content = fs.readFileSync(filePath, 'utf8');
      const ext = path.extname(filePath).toLowerCase();
      const langId = extLangId(ext);
      // open in tsserver FIRST — its plugin must see the file before vue-ls
      // queries it. Await projectInfo (a request that resolves synchronously
      // after tsserver loads the project) to ensure plugin activation.
      const tsNextSeq = () => { const n = ctx.state.get('tsSeq') + 1; ctx.state.set('tsSeq', n); return n; };
      ctx.send('ts', {
        seq: tsNextSeq(),
        type: 'request',
        command: 'open',
        arguments: { file: filePath, fileContent: content, projectRootPath: ctx.workspace },
      });
      await tsLocalRequest(ctx, 'projectInfo', { file: filePath, needFileNameList: false });
      // then notify vue-ls
      ctx.rpc.vue.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: langId, version: 1, text: content },
      });
      opened.add(uri);
    },

    async call({ method, params }, ctx) {
      const uri = params && params.textDocument && params.textDocument.uri;
      if (uri) await this.ensureOpen(uri, ctx);
      return ctx.rpc.vue.request(method, params || {});
    },

    async reload(ctx, changed) {
      ctx.log('didChangeConfiguration reload:', changed.join(', '));
      ctx.rpc.vue.notify('workspace/didChangeConfiguration', { settings: {} });
      ctx.rpc.vue.notify('workspace/didChangeWatchedFiles', {
        changes: changed.map(file => ({ uri: 'file://' + file, type: 2 })),
      });
    },
  };
}

// tsLocalRequest — adapter-internal helper for tsserver requests that
// the coordinator itself initiates (warmup projectInfo, ensureOpen's
// projectInfo wait). Writes a seq-tagged request + returns a promise
// keyed on that seq.
function tsLocalRequest(ctx, command, args) {
  return new Promise(resolve => {
    const seq = ctx.state.get('tsSeq') + 1;
    ctx.state.set('tsSeq', seq);
    ctx.state.get('tsLocalPending').set(seq, resolve);
    ctx.send('ts', { seq, type: 'request', command, arguments: args });
  });
}

module.exports = { createAdapter };
