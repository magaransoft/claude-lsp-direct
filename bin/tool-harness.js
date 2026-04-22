// tool-harness — primitives shared by tool-server-proxy.js and
// node-formatter-daemon.js. Pure mechanism, no policy. See
// docs/architecture.md for the surface contract.

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');

// resolveWorkspace — walk up from argvWorkspace|cwd looking for any
// marker file; explicit arg wins. Returns absolute path.
function resolveWorkspace(markers, { argvWorkspace, cwd }) {
  const start = cwd || process.cwd();
  if (argvWorkspace) return path.resolve(argvWorkspace);
  let dir = path.resolve(start);
  while (dir !== '/') {
    for (const marker of markers) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    dir = path.dirname(dir);
  }
  return path.resolve(start);
}

// stateDir — ~/.cache/<toolName>/<shasum12(workspace)>/. Matches the
// existing bash wrapper convention exactly (wrappers pass their full
// name including `-direct` suffix). Also mkdirp's the dir so the
// caller can write files immediately.
function stateDir(workspace, toolName) {
  const envKey = toolName.toUpperCase().replace(/-/g, '_') + '_STATE';
  const root = process.env[envKey] || path.join(process.env.HOME || '', '.cache', toolName);
  const hash = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 12);
  const dir = path.join(root, hash);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// freePort — grab an ephemeral port by binding a throwaway socket.
// Returns a Promise<number>. Used when the wrapper doesn't pre-allocate.
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// serveHttp — loopback HTTP server exposing GET /health and POST
// /call (canonical) + POST /lsp (back-compat alias for existing
// wrappers). The caller supplies onCall({method, params}) → Promise<any>.
function serveHttp(port, { onCall, meta }) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...(meta || {}) }));
      return;
    }
    if (req.method === 'POST' && (req.url === '/call' || req.url === '/lsp')) {
      let body = '';
      req.on('data', c => { body += c.toString('utf8'); });
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body); } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON: ' + e.message }));
          return;
        }
        const { method, params } = payload;
        if (!method) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing method' }));
          return;
        }
        try {
          const result = await onCall({ method, params: params || {} });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ result }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return {
    listen(cb) { server.listen(port, '127.0.0.1', cb); return server; },
    close(cb) { server.close(cb); },
    address: () => server.address(),
  };
}

// invalidationLoop — tracks mtime of soft/hard trigger paths (relative
// to workspace) in <stateDir>/triggers.json. check() called on every
// /call; dispatches onSoft(changed) or onHard(changed) (hard wins if
// both). First call seeds the baseline and does NOT fire — no
// spurious invalidation on cold start.
function invalidationLoop({ stateDir, softTriggers, hardTriggers, workspace, onSoft, onHard }) {
  const triggersFile = path.join(stateDir, 'triggers.json');
  let baseline = {};
  let seeded = false;
  try {
    baseline = JSON.parse(fs.readFileSync(triggersFile, 'utf8'));
    seeded = true;
  } catch { /* first run */ }

  function expand(pattern) {
    // minimal glob: absolute wins; '*' matches within one path segment;
    // no recursive '**'. Good enough for config-file triggers
    // (package.json, .env*, project/*.sbt). Adapters that need
    // recursive watching can declare finer-grained paths.
    const abs = path.isAbsolute(pattern) ? pattern : path.join(workspace, pattern);
    if (!abs.includes('*')) {
      return fs.existsSync(abs) ? [abs] : [];
    }
    const dir = path.dirname(abs);
    const base = path.basename(abs);
    if (!fs.existsSync(dir)) return [];
    const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    try {
      return fs.readdirSync(dir)
        .filter(f => re.test(f))
        .map(f => path.join(dir, f));
    } catch { return []; }
  }

  function scan(patterns) {
    const result = [];
    for (const pat of patterns) {
      for (const file of expand(pat)) {
        let mtime = 0;
        try { mtime = fs.statSync(file).mtimeMs; } catch {}
        result.push({ file, mtime });
      }
    }
    return result;
  }

  async function check() {
    const soft = scan(softTriggers);
    const hard = scan(hardTriggers);
    const all = [...soft, ...hard];
    const updates = {};
    const softChanged = [];
    const hardChanged = [];

    for (const { file, mtime } of all) {
      updates[file] = mtime;
      if (seeded && baseline[file] !== mtime) {
        // fires on both modification of known files AND first-appearance
        // of a matched trigger file — creating .env.local mid-session is a
        // real change, not a silent seed.
        if (hard.some(e => e.file === file)) hardChanged.push(file);
        else softChanged.push(file);
      }
    }

    if (!seeded) {
      baseline = { ...updates };
      seeded = true;
      try { fs.writeFileSync(triggersFile, JSON.stringify(baseline)); } catch {}
      return { softChanged: [], hardChanged: [] };
    }

    // commit new baseline BEFORE dispatching — if reload/restart fails,
    // we don't loop on the same trigger forever.
    baseline = { ...baseline, ...updates };
    try { fs.writeFileSync(triggersFile, JSON.stringify(baseline)); } catch {}

    if (hardChanged.length && onHard) await onHard(hardChanged);
    else if (softChanged.length && onSoft) await onSoft(softChanged);
    return { softChanged, hardChanged };
  }

  return { check };
}

// callLog — append JSON-lines to <stateDir>/calls.log. Disable by
// setting TOOL_DIRECT_CALLLOG=0 in env.
function callLog(stateDir) {
  if (process.env.TOOL_DIRECT_CALLLOG === '0') return () => {};
  const file = path.join(stateDir, 'calls.log');
  return (record) => {
    try {
      fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...record }) + '\n');
    } catch { /* log failures never break a call */ }
  };
}

// framing.contentLength — LSP standard. reader(onMessage) returns a
// data-chunk sink; writer(stream) returns a msg→write function.
const framing = {
  contentLength: {
    reader(onMessage, onError) {
      let buf = Buffer.alloc(0);
      return function onData(chunk) {
        buf = Buffer.concat([buf, chunk]);
        while (true) {
          const headerEnd = buf.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          const headers = buf.slice(0, headerEnd).toString('ascii');
          const m = headers.match(/Content-Length:\s*(\d+)/i);
          if (!m) { if (onError) onError(new Error('missing Content-Length')); return; }
          const len = parseInt(m[1], 10);
          const total = headerEnd + 4 + len;
          if (buf.length < total) return;
          const body = buf.slice(headerEnd + 4, total).toString('utf8');
          buf = buf.slice(total);
          let msg;
          try { msg = JSON.parse(body); } catch (e) {
            if (onError) onError(e);
            continue;
          }
          onMessage(msg);
        }
      };
    },
    writer(stream) {
      return (msg) => {
        const body = Buffer.from(JSON.stringify(msg), 'utf8');
        const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
        stream.write(Buffer.concat([header, body]));
      };
    },
  },

  // jsonLine — line-delimited JSON (sbt thin-client-ish; placeholder
  // shape for wave 3).
  jsonLine: {
    reader(onMessage) {
      let buf = '';
      return function onData(chunk) {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { onMessage(JSON.parse(line)); } catch { /* ignore malformed */ }
        }
      };
    },
    writer(stream) {
      return (msg) => stream.write(JSON.stringify(msg) + '\n');
    },
  },

  // tsserverMixed — tsserver emits either Content-Length-framed or
  // plain \n-delimited JSON. Shape matches the vue coordinator's
  // handling; used in wave 2 step 5.
  tsserverMixed: {
    reader(onMessage) {
      let buf = '';
      return function onData(chunk) {
        buf += chunk.toString('utf8');
        while (buf.length > 0) {
          if (buf.startsWith('Content-Length:')) {
            const headerEnd = buf.indexOf('\r\n\r\n');
            if (headerEnd < 0) return;
            const headers = buf.slice(0, headerEnd);
            const m = headers.match(/Content-Length:\s*(\d+)/i);
            if (!m) { buf = buf.slice(headerEnd + 4); continue; }
            const len = parseInt(m[1], 10);
            const total = headerEnd + 4 + len;
            if (Buffer.byteLength(buf, 'utf8') < total) return;
            const body = buf.slice(headerEnd + 4, total);
            buf = buf.slice(total);
            try { onMessage(JSON.parse(body)); } catch {}
          } else {
            const nl = buf.indexOf('\n');
            if (nl < 0) return;
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try { onMessage(JSON.parse(line)); } catch {}
          }
        }
      };
    },
    writer(stream) {
      return (msg) => stream.write(JSON.stringify(msg) + '\n');
    },
  },
};

// jsonRpcClient — correlation helper for JSON-RPC 2.0 stdio peers
// (LSP, sbt thin client). Call handleMessage(msg) from the framer's
// onMessage callback. Provides request/notify + null-ack for
// server-initiated requests by default.
function jsonRpcClient({ send, onServerRequest, onNotification, onResponseError }) {
  const pending = new Map();
  let nextId = 0;
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        send({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      send({ jsonrpc: '2.0', method, params });
    },
    handleMessage(msg) {
      if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          if (msg.error) {
            const err = new Error(JSON.stringify(msg.error));
            p.reject(err);
            if (onResponseError) onResponseError(msg);
          } else {
            p.resolve(msg.result);
          }
        }
        return;
      }
      if (msg.method && msg.id !== undefined) {
        if (onServerRequest) {
          onServerRequest(msg, (result) => send({ jsonrpc: '2.0', id: msg.id, result }));
        } else {
          send({ jsonrpc: '2.0', id: msg.id, result: null });
        }
        return;
      }
      if (msg.method && msg.id === undefined) {
        if (onNotification) onNotification(msg);
      }
    },
    pendingCount: () => pending.size,
  };
}

module.exports = {
  resolveWorkspace,
  stateDir,
  freePort,
  serveHttp,
  invalidationLoop,
  callLog,
  framing,
  jsonRpcClient,
};
