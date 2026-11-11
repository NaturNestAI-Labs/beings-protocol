#!/usr/bin/env bash
# CI guard: put first on background jobs' PATH in front of the real CI CLI; blocks run cancellation so
# parallel jobs cannot cancel each other's runs. Set CI_GUARD_REAL; deliberate bypass: CI_GUARD_OFF=1.
set -euo pipefail

REAL="${CI_GUARD_REAL:?set CI_GUARD_REAL to the real CLI path, e.g. /usr/bin/gh}"
LOG="${CI_GUARD_LOG:-$HOME/.local/state/ci-guard.log}"
[[ "${CI_GUARD_OFF:-}" == 1 ]] && exec "$REAL" "$@"

args=" $* "
# Patterns for the common CLIs; add yours. Matching is on the joined argument list.
if [[ "$args" =~ [[:space:]](run|runs|build|pipeline|pipelines)[[:space:]]+cancel[[:space:]] ]] || [[ "$args" == *" cancelling"* ]]; then
  mkdir -p "$(dirname "$LOG")"
  echo "$(date -Is) BLOCKED cancel ppid=$PPID: $*" >>"$LOG"
  echo "ci-guard: cancelling CI runs is disabled for jobs. Runs on a shared branch are cumulative; wait for the queued one." >&2
  exit 3
fi
exec "$REAL" "$@"
