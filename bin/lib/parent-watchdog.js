// parent-watchdog — shared library installed in coordinator/proxy/daemon scripts.
// On parent pid death (ESRCH from kill 0), exits the current process.
//
// Why: nohup ... & detaches coordinator from its bash wrapper; on macOS the
// coordinator is reparented to launchd (pid 1), so the original claude
// session pid must be passed explicitly via --parent-pid <PID>. Wrapper
// scripts capture $PPID at spawn (= the claude binary pid) and forward it.
//
// Opt-out: env LSP_DISABLE_PARENT_WATCHDOG=1 skips installation. Use for
// parallel-session workflows where a coordinator outliving its spawner is
// intentional. Default-on.
//
// Multi-session trade-off: when the spawning claude session ends, the
// coordinator dies even if another claude session was using it; that other
// session pays a cold-restart on next LSP call. Accepted in exchange for
// preventing the leak this lib was written to fix.

'use strict';

const DEFAULT_POLL_MS = 30000;

function isAliveOrUnknown(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process → dead. EPERM = exists but not ours → alive.
    return e && e.code === 'EPERM';
  }
}

/**
 * Install a polling watchdog that exits the current process when parentPid dies.
 * @param {object} opts
 * @param {number|null} opts.parentPid — pid to watch; if null/falsy, no-op.
 * @param {number} [opts.pollMs=30000] — poll interval in ms.
 * @param {string} [opts.toolName='unknown'] — label for stderr log line.
 * @param {function} [opts.onExit] — optional graceful-shutdown hook called before process.exit.
 * @returns {object|null} {stop: () => void} when installed, null when skipped.
 */
function installParentWatchdog(opts) {
  const parentPid = opts && opts.parentPid;
  if (!parentPid || !Number.isInteger(parentPid) || parentPid < 2) return null;
  if (process.env.LSP_DISABLE_PARENT_WATCHDOG === '1') return null;
  const pollMs = (opts && opts.pollMs) || DEFAULT_POLL_MS;
  const toolName = (opts && opts.toolName) || 'unknown';
  const onExit = opts && opts.onExit;

  const timer = setInterval(() => {
    if (isAliveOrUnknown(parentPid)) return;
    console.error(`[${toolName}] parent pid=${parentPid} dead — exiting`);
    clearInterval(timer);
    if (typeof onExit === 'function') {
      try { onExit(); } catch (_) { /* ignore */ }
    }
    // small grace so log line flushes
    setTimeout(() => process.exit(0), 50);
  }, pollMs);
  timer.unref(); // do not keep the event loop alive on watchdog alone
  return { stop: () => clearInterval(timer) };
}

/**
 * Parse --parent-pid <N> from process.argv, returning the integer or null.
 * Centralized here so every consumer uses identical parsing semantics.
 */
function parseParentPidArg(argv) {
  const i = argv.indexOf('--parent-pid');
  if (i < 0 || i + 1 >= argv.length) return null;
  const n = parseInt(argv[i + 1], 10);
  if (!Number.isInteger(n) || n < 2) return null;
  return n;
}

module.exports = { installParentWatchdog, isAliveOrUnknown, parseParentPidArg };
