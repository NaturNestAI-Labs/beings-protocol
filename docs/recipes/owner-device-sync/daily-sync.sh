#!/usr/bin/env bash
# Once-a-day sync with catch-up: safe to call hourly and at boot; stops after the first successful run of the day.
#   daily-sync.sh [--force] [--no-notify]
# Exit: 0 success or already done today, 1 a step reported FAIL/CONFLICT/SKIPPED, 75 another run holds the lock.
set -uo pipefail
umask 077
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CONF=${DEVICE_SYNC_CONF:-${XDG_CONFIG_HOME:-$HOME/.config}/being-device-sync/device-sync.conf}
set -a   # steps run as child processes and need the settings
# shellcheck source=/dev/null
[[ -f $CONF ]] && . "$CONF"
set +a
FORCE=0; NOTIFY=1
for a in "$@"; do case "$a" in --force) FORCE=1 ;; --no-notify) NOTIFY=0 ;; *) echo "unknown argument: $a" >&2; exit 2 ;; esac; done
ST=${DEVICE_SYNC_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/being-device-sync}
mkdir -p "$ST/reports" "$ST/alerts"
exec 9>"$ST/lock"
flock -n 9 || { echo "FAIL another sync is running; completion unverified"; exit 75; }
TODAY=$(date +%F)
[[ $FORCE == 0 && $(cat "$ST/success" 2>/dev/null) == "$TODAY" ]] && exit 0
rm -f "$ST/success"

REPORT="$ST/reports/$TODAY-$(date +%H%M%S).txt"
STEPS=("${DEVICE_SYNC_STEPS[@]:-$SRC/ff-pull.sh}")
{
  echo "HOST $(hostname) $(date '+%F %H:%M %Z')"
  for step in "${STEPS[@]}"; do
    bash -c "$step" </dev/null 2>&1 || echo "FAIL step exited non-zero: ${step%% *}"
  done
} >"$REPORT"
cat "$REPORT"

failures=$(grep -cE '^(FAIL|CONFLICT|SKIPPED) ' "$REPORT" || true)
if (( failures == 0 )); then
  printf '%s\n' "$TODAY" >"$ST/success"
  exit 0
fi
# Failure-only notice: a count and where the private report is, never the report itself; once per day per content.
if (( NOTIFY )) && [[ -n ${DEVICE_SYNC_NOTIFY:-} ]]; then
  msg="Daily device sync on $(hostname): $failures problem(s) (failed, conflicting or skipped). Report: $REPORT. It retries at the next catch-up run."
  h=$(grep -E '^(FAIL|CONFLICT|SKIPPED) ' "$REPORT" | sha256sum | cut -d' ' -f1)
  if [[ $(cat "$ST/alerts/$TODAY" 2>/dev/null) != "$h" ]]; then
    printf '%s\n' "$msg" | bash -c "$DEVICE_SYNC_NOTIFY" && printf '%s\n' "$h" >"$ST/alerts/$TODAY"
  fi
fi
exit 1
