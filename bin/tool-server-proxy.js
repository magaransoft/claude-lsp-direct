// tool-server-proxy — creates a per-workspace coordinator that spawns or
// adopts one or more external child processes, frames their stdio per
// adapter spec, and exposes the adapter's operation surface over HTTP.
//
// See docs/architecture.md for the adapter contract.

'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const {
  stateDir,
  serveHttp,
  invalidationLoop,
  callLog,
  framing,
  jsonRpcClient,
} = require('./tool-harness.js');

// createProxy({ adapter, workspace, port, toolName })
//   adapter: see docs/architecture.md § adapter contract
//   workspace: abs path (already resolved by caller)
//   port: loopback port to bind
//   toolName: used for state dir + log prefix
// Returns a Promise<{ address, close }>.
async function createProxy({ adapter, workspace, port, toolName }) {
  const dir = stateDir(workspace, toolName);
  const log = (...args) => console.error(`[${toolName}]`, ...args);
  const logCall = callLog(dir);
  const events = new EventEmitter();

  // spawn or adopt child processes per adapter. adapter.adopt MAY be
  // async and MAY return null when no adoption target is available —
  // fall back to spawn in that case.
  let adoptedSpecs = null;
  if (typeof adapter.adopt === 'function') {
    try { adoptedSpecs = await adapter.adopt(workspace, dir); }
    catch (e) { log(`adopt probe errored — falling back to spawn: ${e.message}`); }
  }
  const adopted = Boolean(adoptedSpecs);
  const childSpecs = adoptedSpecs || adapter.spawn(workspace, dir) || [];
  if (!Array.isArray(childSpecs)) {
    throw new Error(`adapter ${adapter.name}: spawn() did not return an array`);
  }
  // Empty children is legal for adapters that drive their backing tool
  // entirely via per-call subprocess spawn (sbt-oneshot, dotnet-cli,
  // scalafmt-cli). The coordinator's HTTP surface + invalidationLoop +
  // callLog still function; onChildMessage is never invoked.

  const children = {};
  for (const spec of childSpecs) {
    if (!spec.id || !spec.frame) {
      throw new Error(`adapter ${adapter.name}: child spec missing id or frame`);
    }
    let proc = spec.proc;
    if (!proc) {
      proc = spawn(spec.cmd, spec.args || [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: spec.cwd || workspace,
        env: spec.env || process.env,
      });
    }
    proc.stderr.on('data', d => log(`${spec.id}:`, d.toString().trim()));
    proc.on('exit', (code, sig) => {
      log(`${spec.id} exited`, code, sig);
      // emit an event; entrypoint decides whether to kill the coordinator
      // process. Defers so tests can use fake children without process.exit
      events.emit('childExit', { id: spec.id, code, sig });
    });
    proc.on('error', e => {
      log(`spawn ${spec.id} failed:`, e.message);
      events.emit('spawnError', { id: spec.id, error: e });
    });

    const framer = framing[spec.frame];
    if (!framer) throw new Error(`unknown frame: ${spec.frame}`);
    const writer = framer.writer(proc.stdin);
    const onChildMsg = (msg) => adapter.onChildMessage(spec.id, msg, ctx); // ctx defined below (closure captured)
    const reader = framer.reader(onChildMsg, (e) => log(`${spec.id} frame error:`, e.message));
    proc.stdout.on('data', reader);

    children[spec.id] = { proc, spec, send: writer };
  }

  // pre-build jsonRpcClient helpers for any contentLength child — adapter
  // can delegate LSP-style correlation via ctx.rpc[childId] without
  // re-implementing pending-map bookkeeping.
  const rpc = {};
  for (const [id, c] of Object.entries(children)) {
    if (c.spec.frame === 'contentLength') {
      rpc[id] = jsonRpcClient({ send: c.send });
    }
  }

  // adapter-scoped state map (used by vue-hybrid for tsserver bridge
  // tables, by LSP adapters for openedUris set, etc.)
  const state = new Map();

  // ctx — the per-call context passed to every adapter callback
  const ctx = {
    workspace,
    stateDir: dir,
    toolName,
    log,
    logCall,
    children,
    rpc,
    state,
    adopted,
    send(childId, msg) {
      const c = children[childId];
      if (!c) throw new Error(`no child: ${childId}`);
      c.send(msg);
    },
    request(childId, method, params) {
      if (!rpc[childId]) {
        throw new Error(`request() unsupported for ${childId} (frame=${children[childId].spec.frame}) — use ctx.send() + adapter-local correlation`);
      }
      return rpc[childId].request(method, params);
    },
    notify(childId, method, params) {
      if (!rpc[childId]) {
        throw new Error(`notify() unsupported for ${childId}`);
      }
      rpc[childId].notify(method, params);
    },
    // adapter forwards raw jsonrpc messages from onChildMessage to the
    // matching rpc[childId].handleMessage when it wants default
    // response-correlation + null-ack behavior.
    handleJsonRpc(childId, msg) {
      if (rpc[childId]) rpc[childId].handleMessage(msg);
    },
  };

  // invalidation loop — stat on every /call; hard wins over soft
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
        log('adapter has no reload() — exiting for restart');
        process.exit(2);
      }
    },
    async onHard(changed) {
      log('hard invalidation:', changed.join(', '));
      // wrapper re-starts on next call; clean exit
      for (const c of Object.values(children)) c.proc.kill();
      process.exit(2);
    },
  });

  // run adapter init (handshake, warmup, etc.)
  await adapter.init(ctx);

  // wire HTTP
  let invalidationFiredOnLastCall = false;
  const server = serveHttp(port, {
    meta: { workspace, toolName, adopted },
    statusFn: () => {
      const list = Object.entries(children).map(([id, c]) => ({
        id,
        pid: c.proc.pid,
        alive: c.proc.exitCode === null && !c.proc.killed,
        exitCode: c.proc.exitCode,
      }));
      return {
        children: list,
        childrenAlive: list.every(c => c.alive),
      };
    },
    async onCall({ method, params }) {
      const t0 = Date.now();
      invalidationFiredOnLastCall = false;
      const r = await invalidator.check();
      if (r.softChanged.length || r.hardChanged.length) invalidationFiredOnLastCall = true;
      try {
        const result = await adapter.call({ method, params }, ctx);
        logCall({
          method, ms: Date.now() - t0, adopted,
          invalidation_fired: invalidationFiredOnLastCall,
          outcome: 'ok',
        });
        return result;
      } catch (e) {
        logCall({
          method, ms: Date.now() - t0, adopted,
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
      log(`listening on 127.0.0.1:${actual} workspace=${workspace} adopted=${adopted}`);
      const sigHandler = () => {
        for (const c of Object.values(children)) c.proc.kill();
        process.exit(0);
      };
      process.on('SIGTERM', sigHandler);
      process.on('SIGINT', sigHandler);
      resolve({
        address: server.address(),
        close: (cb) => {
          for (const c of Object.values(children)) {
            try { c.proc.kill(); } catch {}
          }
          server.close(cb);
        },
        on: events.on.bind(events),
        once: events.once.bind(events),
      });
    });
  });
}

module.exports = { createProxy };
