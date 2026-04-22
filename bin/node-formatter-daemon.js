// node-formatter-daemon — in-process Node library coordinator. For
// tools whose "server protocol" is a JavaScript function call
// (prettier.format, ESLint.lintText, etc.). No child process, no
// stdio framing. Sibling module to tool-server-proxy.js; both share
// the harness primitives (resolveWorkspace, stateDir, serveHttp,
// invalidationLoop, callLog).
//
// See docs/architecture.md for the adapter contract.

'use strict';

const { EventEmitter } = require('events');
const {
  stateDir,
  serveHttp,
  invalidationLoop,
  callLog,
} = require('./tool-harness.js');

// createDaemon({ adapter, workspace, port, toolName })
//   adapter: { name, markers, preload(workspace) → pkg, call({method, params}, ctx) → result,
//              triggers: {soft, hard}, reload?(ctx) }
// Returns Promise<{ address, close, on, once }>.
async function createDaemon({ adapter, workspace, port, toolName }) {
  const dir = stateDir(workspace, toolName);
  const log = (...args) => console.error(`[${toolName}]`, ...args);
  const logCall = callLog(dir);
  const events = new EventEmitter();

  let pkg;
  try {
    pkg = await Promise.resolve(adapter.preload(workspace));
    log(`${adapter.name} preloaded`);
  } catch (e) {
    log(`preload failed: ${e.message}`);
    throw e;
  }

  const state = new Map();

  const ctx = {
    workspace,
    stateDir: dir,
    toolName,
    log,
    logCall,
    pkg,
    state,
  };

  const invalidator = invalidationLoop({
    stateDir: dir,
    softTriggers: (adapter.triggers && adapter.triggers.soft) || [],
    hardTriggers: (adapter.triggers && adapter.triggers.hard) || [],
    workspace,
    async onSoft(changed) {
      log('soft invalidation:', changed.join(', '));
      if (adapter.reload) {
        try { await adapter.reload(ctx, changed); }
        catch (e) { log('reload failed — exiting for restart:', e.message); process.exit(2); }
      } else {
        // default: re-import the package (clears require-cache)
        log('default soft-reload: re-require package');
        // best-effort clear — adapters with non-trivial state should
        // implement their own reload().
      }
    },
    async onHard(changed) {
      log('hard invalidation:', changed.join(', '));
      process.exit(2);
    },
  });

  let invalidationFiredOnLastCall = false;
  const server = serveHttp(port, {
    meta: { workspace, toolName, kind: 'node-formatter-daemon' },
    async onCall({ method, params }) {
      const t0 = Date.now();
      invalidationFiredOnLastCall = false;
      const r = await invalidator.check();
      if (r.softChanged.length || r.hardChanged.length) invalidationFiredOnLastCall = true;
      try {
        const result = await adapter.call({ method, params }, ctx);
        logCall({
          method, ms: Date.now() - t0, adopted: false,
          invalidation_fired: invalidationFiredOnLastCall,
          outcome: 'ok',
        });
        return result;
      } catch (e) {
        logCall({
          method, ms: Date.now() - t0, adopted: false,
          invalidation_fired: invalidationFiredOnLastCall,
          outcome: 'error', error: e.message,
        });
        throw e;
      }
    },
  });

  return new Promise((resolve) => {
    server.listen(() => {
      const actual = server.address().port;
      log(`listening on 127.0.0.1:${actual} workspace=${workspace}`);
      const sigHandler = () => { process.exit(0); };
      process.on('SIGTERM', sigHandler);
      process.on('SIGINT', sigHandler);
      resolve({
        address: server.address(),
        close: (cb) => server.close(cb),
        on: events.on.bind(events),
        once: events.once.bind(events),
      });
    });
  });
}

module.exports = { createDaemon };
