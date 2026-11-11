#!/usr/bin/env bash
# Scheduled job (run | scan | digest | send): an agent writes a result file; this script diffs, digests and sends.
# Nothing is sent when nothing is new. Off switch: state/off. Settings: docs/OPERATIONS_KIT.md section 13.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"   # cron has a bare PATH
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd -P)"
ST="$HERE/state"
WORKSPACE="$(cd "$HERE/../.." && pwd -P)"
KIT="$WORKSPACE/ops/teams-kit"
JOB="$(basename "$HERE")"
[ -n "${BEING_TZ:-}" ] && export TZ="$BEING_TZ"
day="$(date +%F)"
RUN="$ST/runs/$day.json"; DIGEST="$ST/digest-$day.md"; SEEN="$ST/seen.json"
mkdir -p "$ST/runs"
log() { echo "$(date -Is) $*" >>"$ST/$JOB.log"; }
[ -e "$ST/off" ] && { log "off switch set, skipping"; exit 0; }
exec 9>"$ST/$JOB.lock"; flock -n 9 || { log "already running"; exit 0; }

render() {   # render <template> KEY=VALUE ...: fill {{KEY}} placeholders
  python3 - "$@" <<'PY'
import sys
t = open(sys.argv[1]).read()
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1); t = t.replace("{{" + k + "}}", v)
print(t)
PY
}

agent() {   # agent <prompt>: one headless Claude Code run in the Being's home
  local perms=(--allowedTools "${JOB_ALLOWED_TOOLS:-Read,Write,Edit,Glob,Grep,WebSearch,WebFetch}")
  [ "${BEING_SKIP_PERMISSIONS:-0}" = 1 ] && perms=(--dangerously-skip-permissions)
  if [[ "${BEING_LANE:-owner}" == team:* ]]; then   # teammate-triggered: behind the team fence, or not at all
    local f; f="$(python3 "$KIT/team-fence.py" --settings 2>/dev/null)" && [ -n "$f" ] || { log "team fence unavailable"; return 1; }
    perms+=(--settings "$f")
  fi
  (cd "$WORKSPACE" && timeout "${JOB_TIMEOUT:-2h}" claude -p "${perms[@]}" ${JOB_MODEL:+--model "$JOB_MODEL"} \
     --name "$day job $JOB" -- "$1") >>"$ST/agent-$day.log" 2>&1
}

scan() {
  local seen_list
  seen_list="$(python3 -c 'import json,sys
try: d = json.load(open(sys.argv[1]))
except Exception: d = {}
print(", ".join(sorted(d)) or "none")' "$SEEN")"
  log "scan start"
  rm -f "$RUN"
  agent "$(render "$HERE/prompt.md" "DAY=$day" "OUT=${RUN#"$WORKSPACE"/}" "SEEN=$seen_list")"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert isinstance(d.get("items"), list)' "$RUN" 2>/dev/null \
    || { log "scan failed: no valid $RUN"; return 1; }
  log "scan done"
}

digest() {   # exit 0 = something new to send, 10 = nothing new
  python3 - "$RUN" "$SEEN" "$DIGEST" "$day" <<'PY'
import json, sys
run, seen_f, out, day = sys.argv[1:5]
items = json.load(open(run))["items"]
try: seen = json.load(open(seen_f))
except Exception: seen = {}
new = [i for i in items if str(i.get("id")) not in seen]
if not new:
    sys.exit(10)
lines = [f"**New since the last run ({day})**", ""]
for i in new:
    lines.append(f"- **{i.get('title', i.get('id'))}**: {i.get('summary', '')} {i.get('url', '')}".rstrip())
open(out, "w").write("\n".join(lines) + "\n")
PY
}

commit_seen() {   # advance state only after a successful send, so a failed send is reported again next run
  python3 - "$RUN" "$SEEN" "$day" <<'PY'
import json, sys
run, seen_f, day = sys.argv[1:4]
try: seen = json.load(open(seen_f))
except Exception: seen = {}
for i in json.load(open(run))["items"]:
    seen.setdefault(str(i.get("id")), day)
json.dump(seen, open(seen_f, "w"), indent=1, sort_keys=True)
PY
}

send() {
  [ -s "$DIGEST" ] || { log "send: no digest for $day"; return 1; }
  local cmd="${JOB_SEND_CMD:-}"
  if [ -z "$cmd" ] && [ -f "$KIT/teams-send-dm.mjs" ]; then cmd="cd '$KIT' && set -a && . ./.env && set +a && node teams-send-dm.mjs --no-quote"; fi
  [ -n "$cmd" ] || { log "send: no sender (set JOB_SEND_CMD); digest kept at $DIGEST"; return 1; }
  if bash -c "$cmd" <"$DIGEST" >>"$ST/$JOB.log" 2>&1; then commit_seen; log "digest sent"
  else log "send failed; state not advanced"; return 1; fi
}

case "${1:-run}" in
  scan) scan ;;
  digest) digest ;;
  send) send ;;
  run) scan || exit 1
       digest; rc=$?
       if [ "$rc" -eq 10 ]; then commit_seen; log "nothing new, no message"; exit 0; fi
       [ "$rc" -eq 0 ] || exit "$rc"
       send ;;
  *) echo "usage: run.sh run|scan|digest|send" >&2; exit 2 ;;
esac
