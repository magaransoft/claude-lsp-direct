// tool-server-proxy — creates a per-workspace coordinator that spawns or
// adopts one or more external child processes, frames their stdio per
// adapter spec, and exposes the adapter's operation surface over HTTP.
//
// See docs/architecture.md for the adapter contract.

'use strict';

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  stateDir,
  serveHttp,
  invalidationLoop,
  callLog,
  framing,
  jsonRpcClient,
} = require('./tool-harness.js');

// idle-shutdown TTL — coordinator self-exits after no /lsp or /batch
// activity for IDLE_SHUTDOWN_MS. /health + /status do NOT count.
// env LSP_DIRECT_IDLE_MS overrides default; 0 disables; non-finite or
// negative falls back to default.
const IDLE_SHUTDOWN_MS = (() => {
  const raw = process.env.LSP_DIRECT_IDLE_MS;
  if (raw === undefined || raw === '') return 30 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 30 * 60 * 1000;
  return n;
})();
const IDLE_CHECK_MS = 60 * 1000;

// parent-watchdog — coordinator polls parent claude PID; if parent gone
// (claude crashed without sending SIGTERM), coordinator self-exits after
// PARENT_WATCHDOG_MS poll. Closes the orphan-coordinator-on-crash gap per
// orphan-teardown ADR-002. env LSP_DIRECT_PARENT_WATCHDOG_MS overrides
// default; 0 disables. parent PID captured at startup via process.ppid.
const PARENT_WATCHDOG_MS = (() => {
  const raw = process.env.LSP_DIRECT_PARENT_WATCHDOG_MS;
  if (raw === undefined || raw === '') return 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 60 * 1000;
  return n;
})();

// STARTUP_PARENT_PID — captured at module load BEFORE any async adapter
// init / spawn / adopt work. Fixed for the lifetime of this coordinator.
// Per codex 2026-05-25 review (orphan-teardown ADR-002 lifecycle gap):
// capturing process.ppid inside server.listen() callback risks missing the
// orphan-detection path if the original parent (claude) exits during
// adapter.adopt() / adapter.spawn() / adapter.init() async chain — by the
// time the callback runs, ppid would already show as 1 (reparented to init),
// and the watchdog block `if (parentPid !== 1)` would silently disable
// itself. Fixing the value at module-load time pins the original parent's
// PID regardless of subsequent reparenting.
const STARTUP_PARENT_PID = process.ppid;

// REGISTRY — central per-host lineage TSV. Records every coordinator-spawned
// backend so a future audit can answer "which workspace owns PID X" without
// lsof guesswork (closes the vue-tsserver-untraceable diagnostic gap, per
// orphan-teardown ADR-004). Atomic via O_APPEND single-line writes — POSIX
// guarantees atomicity for writes <PIPE_BUF (4096 bytes); rows are ~250 bytes.
// Columns (TSV): spawn_ts | coordinator_pid | backend_pid | wrapper | workspace | parent_pid
const REGISTRY_PATH = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
  'claude-lsp-direct',
  'registry.tsv',
);

function registryAppend(coordinatorPid, backendPid, wrapper, workspace, parentPid) {
  try {
    fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    // header on first write
    if (!fs.existsSync(REGISTRY_PATH)) {
      const header = 'spawn_ts\tcoordinator_pid\tbackend_pid\twrapper\tworkspace\tparent_pid\n';
      fs.appendFileSync(REGISTRY_PATH, header, { flag: 'a' });
    }
    const row = [
      new Date().toISOString(),
      coordinatorPid,
      backendPid,
      wrapper,
      workspace.replace(/\t/g, ' '), // avoid TSV corruption from tab in path (rare)
      parentPid || '',
    ].join('\t') + '\n';
    fs.appendFileSync(REGISTRY_PATH, row, { flag: 'a' });
  } catch (e) {
    // best-effort — registry is observability, never block spawn on write failure
  }
}

// killGroup — send signal to entire process group, NOT just immediate
// child PID. Required because LSP backends (pyright, jdtls, metals,
// tsserver, vue-language-server) spawn their own subprocesses
// (workers, indexers, plugin hosts); a SIGTERM to the immediate child
// leaks grandchildren. spawn() with detached:true makes child the group
// leader (its PID == its PGID); kill(-pid) sends to whole group.
// Per orphan-teardown ADR-001 (resolves macOS Open Q2: confirmed working
// — detached:true creates new session via setsid → child is pgid leader).
// Fallback to direct kill if group-kill fails (ESRCH / EPERM).
function killGroup(proc, signal) {
  signal = signal || 'SIGTERM';
  if (!proc || !proc.pid || proc.killed) return;
  try {
    process.kill(-proc.pid, signal);
  } catch (e) {
    try { proc.kill(signal); } catch (_) { /* group + direct both failed; nothing to do */ }
  }
}

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
  let lastActivityTs = Date.now();
  let inFlight = 0;

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
        // detached:true on POSIX calls setsid() → child becomes session leader
        // AND its own process group leader; its PID is the PGID. Required for
        // killGroup() to reap grandchildren (pyright workers, jdtls indexers,
        // tsserver plugin hosts, etc.). Per orphan-teardown ADR-001.
        detached: true,
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

    // ADR-004 — register backend lineage for orchestrator queries.
    // Adopted children (spec.proc preset) are NOT registered: we don't own
    // their lifecycle and the registry's purpose is reap-mapping for owned
    // backends. Skip when proc.pid is falsy (some adapters return mock procs).
    if (!adopted && proc && proc.pid) {
      registryAppend(process.pid, proc.pid, toolName, workspace, process.ppid);
    }
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
      // wrapper re-starts on next call; clean exit.
      // use killGroup (NOT c.proc.kill) so backend grandchildren in the same
      // process group are reaped atomically — per codex 2026-05-25 round-2
      // review on Slice 1: c.proc.kill() only signals direct child, leaks
      // grandchildren (workers, indexers, bloop) on hard invalidation.
      for (const c of Object.values(children)) killGroup(c.proc);
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
      lastActivityTs = Date.now();
      inFlight++;
      const t0 = Date.now();
      invalidationFiredOnLastCall = false;
      try {
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
      } finally {
        inFlight--;
        lastActivityTs = Date.now();
      }
    },
    // onBatch — fan-out across adapter.call concurrently. invalidator.check
    // MUST run exactly once at batch entry per plan § decisions-locked. logCall
    // emits one line per sub-call to preserve confidence_report.py granularity.
    // Per-sub-call try/catch isolates failures so one bad call NEVER poisons
    // siblings — return shape per call: {ok:true,value} | {ok:false,error}.
    async onBatch({ calls }) {
      lastActivityTs = Date.now();
      inFlight++;
      try {
        invalidationFiredOnLastCall = false;
        const r = await invalidator.check();
        if (r.softChanged.length || r.hardChanged.length) invalidationFiredOnLastCall = true;
        const invFired = invalidationFiredOnLastCall;
        return await Promise.all(calls.map(async ({ method, params }, i) => {
          const subT0 = Date.now();
          try {
            const value = await adapter.call({ method, params: params || {} }, ctx);
            logCall({
              method, ms: Date.now() - subT0, adopted,
              invalidation_fired: invFired && i === 0,
              outcome: 'ok',
            });
            return { ok: true, value };
          } catch (e) {
            logCall({
              method, ms: Date.now() - subT0, adopted,
              invalidation_fired: invFired && i === 0,
              outcome: 'error', error: e.message,
            });
            return { ok: false, error: e.message };
          }
        }));
      } finally {
        inFlight--;
        lastActivityTs = Date.now();
      }
    },
  });

  return new Promise((resolve) => {
    server.listen(() => {
      const actual = server.address().port;
      log(`listening on 127.0.0.1:${actual} workspace=${workspace} adopted=${adopted}`);
      log(`idle-shutdown: ${IDLE_SHUTDOWN_MS === 0 ? 'disabled' : Math.round(IDLE_SHUTDOWN_MS/1000) + 's'}`);
      // idle-shutdown timer — Layer A leak prevention. unref() so timer
      // alone does NOT keep the event loop alive (child procs + http
      // server already do).
      let idleTimer = null;
      let parentWatchdog = null;
      // pin parent PID from module-load time (STARTUP_PARENT_PID), NOT process.ppid
      // here — by this point adapter.adopt + spawn + init have already run async,
      // and the original parent may have already exited (ppid reparented to 1).
      const parentPid = STARTUP_PARENT_PID;
      const clearTimers = () => {
        if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
        if (parentWatchdog) { clearInterval(parentWatchdog); parentWatchdog = null; }
      };
      const shutdown = (reason, exitCode) => {
        log(reason);
        clearTimers();
        for (const c of Object.values(children)) killGroup(c.proc);
        try { server.close(); } catch (_) { /* already closing */ }
        process.exit(exitCode === undefined ? 0 : exitCode);
      };
      if (IDLE_SHUTDOWN_MS > 0) {
        idleTimer = setInterval(() => {
          if (inFlight === 0 && Date.now() - lastActivityTs > IDLE_SHUTDOWN_MS) {
            shutdown(`idle-shutdown: no activity for ${Math.round((Date.now() - lastActivityTs)/1000)}s — exiting`, 0);
          }
        }, IDLE_CHECK_MS);
        idleTimer.unref();
      }
      // parent-watchdog — exit if claude crashed without sending SIGTERM.
      // Skip when parentPid is 1 (already orphaned to init at spawn time —
      // expected for nohup-spawned coordinators where the launcher detached
      // intentionally; in that case the wrapper itself, not claude, owns lifecycle).
      if (PARENT_WATCHDOG_MS > 0 && parentPid && parentPid !== 1) {
        log(`parent-watchdog: poll ppid=${parentPid} every ${Math.round(PARENT_WATCHDOG_MS/1000)}s`);
        parentWatchdog = setInterval(() => {
          try {
            process.kill(parentPid, 0); // signal 0 = liveness probe, no actual signal sent
          } catch (e) {
            if (e.code === 'ESRCH') {
              shutdown(`parent-watchdog: parent PID ${parentPid} gone — shutting down`, 0);
            }
            // EPERM is rare for own ancestors; if it happens, parent is alive
            // but not signalable — treat as alive (don't shut down on EPERM)
          }
        }, PARENT_WATCHDOG_MS);
        parentWatchdog.unref();
      }
      const sigHandler = () => shutdown(`signal received — shutting down`, 0);
      process.on('SIGTERM', sigHandler);
      process.on('SIGINT', sigHandler);
      resolve({
        address: server.address(),
        close: (cb) => {
          clearTimers();
          for (const c of Object.values(children)) killGroup(c.proc);
          server.close(cb);
        },
        on: events.on.bind(events),
        once: events.once.bind(events),
      });
    });
  });
}

module.exports = { createProxy };
