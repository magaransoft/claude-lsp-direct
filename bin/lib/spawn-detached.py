#!/usr/bin/env python3
"""spawn-detached — fork a child in its own session (own process group leader) + exec.

Mirrors Node's spawn({detached: true}) for shell scripts. Without this, `nohup foo`
keeps foo in the parent shell's process group → SIGTERM to foo doesn't propagate to
foo's grandchildren (bloop daemon spawned by metals-mcp, jdtls indexer workers, etc.).

After this helper runs:
  - child's PGID == child's PID (session leader)
  - kill -- -<child-pid> reaches all descendants in that group
  - parent shell can exit; child continues until its own process group is signaled

Usage (from shell script):
  exec python3 ~/.claude/bin/lib/spawn-detached.py <log-file> <cmd> [args...]
  # OR for background:
  nohup python3 ~/.claude/bin/lib/spawn-detached.py <log-file> <cmd> [args...] >/dev/null 2>&1 &
  echo $! > pidfile
  # NOTE: $! captures THIS helper's PID, not the exec'd child's. After exec,
  # both refer to the same kernel process (PID-stable across exec()).

Per orphan-teardown ADR-001 (bloop containment via session-isolation, slice-2).
"""
import os
import sys

def main() -> int:
    if len(sys.argv) < 3:
        print("usage: spawn-detached.py <log-file> <cmd> [args...]", file=sys.stderr)
        return 2
    log_file = sys.argv[1]
    cmd_argv = sys.argv[2:]
    # become own session leader → own process group leader
    # syscall: setsid(2) — fails with EPERM if already a group leader; rare for fresh forks
    try:
        os.setsid()
    except PermissionError:
        # already session leader (caller already forked); proceed without
        pass
    # redirect stdio to log + null
    try:
        with open(log_file, "ab", buffering=0) as lf:
            os.dup2(lf.fileno(), 1)
            os.dup2(lf.fileno(), 2)
        with open(os.devnull, "rb") as nf:
            os.dup2(nf.fileno(), 0)
    except OSError as e:
        print(f"spawn-detached: stdio redirect failed: {e}", file=sys.stderr)
        return 3
    # exec target — replaces this Python process, child keeps same PID + PGID
    try:
        os.execvp(cmd_argv[0], cmd_argv)
    except OSError as e:
        print(f"spawn-detached: execvp({cmd_argv[0]}) failed: {e}", file=sys.stderr)
        return 127

if __name__ == "__main__":
    sys.exit(main())
