#!/usr/bin/env bash
# Shared inbox monitor (template): read-only scan; new mail starts one being-job that classifies it and tells the team.
# Schedule through owner-access-run (cron). Pause: touch <state>/owner-access/shared_mailbox_read.pause
set -uo pipefail
KIT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
set -a
# shellcheck source=/dev/null
. "$KIT/.env"
set +a
ST="${BEING_STATE_DIR:-$KIT/state}/owner-access/shared-inbox"
mkdir -p "$ST"; chmod 700 "$ST"
[[ -e "${ST%/shared-inbox}/shared_mailbox_read.pause" ]] && exit 0
log() { echo "$(date -Is) $*" >>"$ST/check.log"; }
exec 9>"$ST/check.lock"; flock -n 9 || { log "already running"; exit 0; }
SINCE=${SHARED_INBOX_SINCE:-$(date -u -d '-3 days' +%FT%TZ)}
SCAN="$ST/scan-latest.json"; SEEN="$ST/seen.txt"; touch "$SEEN"
PROMPT_FILE=${SHARED_INBOX_PROMPT:-$KIT/shared-inbox-job.md}
NOTIFY=${SHARED_INBOX_NOTIFY:-${OWNER_DM_CHAT:-}}

scan() { timeout 240 node "$KIT/shared-inbox-monitor.mjs" scan --since "$SINCE" --out "$SCAN" >>"$ST/check.log" 2>&1; }
if ! scan; then
  sleep 45
  if ! scan; then
    n=$(( $(cat "$ST/fail-count" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$ST/fail-count"; log "scan failed ($n)"
    # Two failures in a row: one blocker to the owner, not a silent stop.
    [[ $n -eq 2 ]] && "$KIT/being-blocker" "Shared inbox check" "scan failed twice ($(tail -1 "$ST/check.log" | cut -c1-200))" \
      "Check the owner's Outlook sign-in (owner-access-login owner --outlook)" >/dev/null 2>&1
    exit 1
  fi
fi
echo 0 >"$ST/fail-count"
NEW="$ST/new-$(date +%Y%m%d-%H%M).json"
count=$(node "$KIT/shared-inbox-monitor.mjs" diff --scan "$SCAN" --seen "$SEEN" --new "$NEW")
if [[ "$count" == 0 ]]; then rm -f "$NEW"; log "no new mail"; exit 0; fi
[[ -f "$PROMPT_FILE" && -n "$NOTIFY" ]] || { log "new=$count but no job prompt or notify chat set"; exit 1; }
PROMPT="$(sed -e "s#@NEW@#$NEW#g" -e "s#@DATE@#$(date +%F)#g" "$PROMPT_FILE")"
if id=$("$KIT/being-job" agent shared-inbox --notify "$NOTIFY" "$PROMPT"); then
  node "$KIT/shared-inbox-monitor.mjs" mark --new "$NEW" --seen "$SEEN"
  log "new=$count job=$id"
else
  log "new=$count job launch FAILED"; exit 1
fi
