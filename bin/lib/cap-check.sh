#!/usr/bin/env bash
# cap-check.sh — sourceable bash helper enforcing concurrent-coordinator
# cap per *-direct wrapper tool. Layer B leak prevention.
#
# Spawn pattern: each *-direct wrapper allocates a per-workspace state
# slot under $HOME/.cache/<tool>-direct/<hash>/ and nohups a coordinator
# whose pid is recorded in $slot/pid. Over time (git worktree remove,
# coda spawn-and-discard) coordinator pids outlive their workspace and
# leak. cap_check_and_evict bounds concurrent live coordinators per tool
# by LRU-evicting oldest-by-mtime slots BEFORE the new spawn fires.
#
# Public function:
#   cap_check_and_evict <tool_name> <state_root>
# Env:
#   LSP_DIRECT_MAX_PROCS  cap value (default 8); 0 disables eviction
# Signaling:
#   SIGTERM, then SIGKILL after 2s grace.
# Output:
#   evictions logged to stderr; cap=0 short-circuits silently.

# portable stat-mtime — macOS BSD stat -f %m vs GNU stat -c %Y.
# detected once on first call, cached in __CAP_STAT_FLAVOR.
__cap_stat_mtime() {
  local path="$1"
  if [ -z "${__CAP_STAT_FLAVOR:-}" ]; then
    if stat -f %m "$path" >/dev/null 2>&1; then
      __CAP_STAT_FLAVOR=bsd
    elif stat -c %Y "$path" >/dev/null 2>&1; then
      __CAP_STAT_FLAVOR=gnu
    else
      __CAP_STAT_FLAVOR=fallback
    fi
  fi
  case "$__CAP_STAT_FLAVOR" in
    bsd) stat -f %m "$path" 2>/dev/null ;;
    gnu) stat -c %Y "$path" 2>/dev/null ;;
    *)   echo 0 ;;
  esac
}

# kill <pid> SIGTERM, wait up to 2s, SIGKILL if still alive
__cap_kill_pid() {
  local pid="$1"
  kill -TERM "$pid" 2>/dev/null || return 0
  local i=0
  while [ "$i" -lt 20 ]; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
    i=$((i+1))
  done
  kill -KILL "$pid" 2>/dev/null || true
}

# cap_check_and_evict <tool_name> <state_root>
cap_check_and_evict() {
  local tool="$1"
  local state_root="$2"
  local cap="${LSP_DIRECT_MAX_PROCS:-8}"
  # validate cap is non-negative integer; otherwise treat as default
  case "$cap" in
    ''|*[!0-9]*) cap=8 ;;
  esac
  [ "$cap" = 0 ] && return 0
  [ -d "$state_root" ] || return 0

  # collect alive slots — pid file present + kill -0 succeeds
  local alive_slots=()
  local slot pid
  for slot in "$state_root"/*/; do
    [ -d "$slot" ] || continue
    [ -f "$slot/pid" ] || continue
    pid="$(cat "$slot/pid" 2>/dev/null)"
    [ -z "$pid" ] && continue
    case "$pid" in
      ''|*[!0-9]*) continue ;;
    esac
    if kill -0 "$pid" 2>/dev/null; then
      alive_slots+=("$slot")
    fi
  done

  local alive_count="${#alive_slots[@]}"
  [ "$alive_count" -lt "$cap" ] && return 0

  # sort alive slots by mtime ascending — oldest first
  # emit "<mtime> <slot>" pairs, sort -n, take leading slot(s)
  local pairs=()
  local m s
  for s in "${alive_slots[@]}"; do
    m="$(__cap_stat_mtime "$s")"
    pairs+=("$m"$'\t'"$s")
  done
  local sorted
  sorted="$(printf '%s\n' "${pairs[@]}" | sort -n)"

  # need to evict until alive_count < cap; evict from sorted head
  local need=$((alive_count - cap + 1))
  local line evict_slot evict_pid evict_ws
  local evicted=0
  while IFS=$'\t' read -r _ evict_slot; do
    [ "$evicted" -ge "$need" ] && break
    [ -d "$evict_slot" ] || continue
    evict_pid="$(cat "$evict_slot/pid" 2>/dev/null)"
    evict_ws="$(cat "$evict_slot/workspace" 2>/dev/null)"
    echo "$tool: cap=$cap evicting oldest pid=$evict_pid workspace=$evict_ws" >&2
    if [ -n "$evict_pid" ]; then
      __cap_kill_pid "$evict_pid"
    fi
    rm -rf "$evict_slot"
    evicted=$((evicted+1))
  done <<< "$sorted"

  return 0
}
