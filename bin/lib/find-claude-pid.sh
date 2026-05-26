# find-claude-pid.sh — bash helper sourced by *-direct wrappers.
#
# Walks the parent-pid chain (max 8 hops) looking for an ancestor whose
# basename(command) contains "claude". Used by wrappers to pass a stable
# --parent-pid to coordinators/proxies: the immediate $PPID is often a
# transient bash/zsh subshell spawned by the Bash tool, which dies right
# after the nohup launch and would trip the watchdog within 30s.
#
# Usage:
#   . "$(dirname "$0")/lib/find-claude-pid.sh"
#   CLAUDE_PID="$(find_claude_pid)"
#   # falls through to empty string if no claude ancestor in 8 hops; caller
#   # may default to $PPID or skip watchdog entirely.
#
# Pure bash + ps; no jq, no python. Safe under `set -u`.

find_claude_pid() {
  local pid="${1:-$$}"
  local i cmd ppid
  for i in 1 2 3 4 5 6 7 8; do
    cmd="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
    case "$(basename "${cmd:-_}")" in
      claude|claude-code) echo "$pid"; return 0 ;;
    esac
    ppid="$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || true)"
    if [ -z "$ppid" ] || [ "$ppid" = "1" ] || [ "$ppid" = "0" ]; then
      return 1
    fi
    pid="$ppid"
  done
  return 1
}
