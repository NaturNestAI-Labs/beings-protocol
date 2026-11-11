#!/usr/bin/env bash
# Research job: parallel workers from workers.conf, then one merge run into out/<day>/REPORT.md; once a day (--force).
# Off switch: state/off. Settings: docs/OPERATIONS_KIT.md section 13.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd -P)"
ST="$HERE/state"; mkdir -p "$ST"
WORKSPACE="$(cd "$HERE/../.." && pwd -P)"
JOB="$(basename "$HERE")"
[ -n "${BEING_TZ:-}" ] && export TZ="$BEING_TZ"
[ -e "$ST/off" ] && exit 0
day="$(date +%F)"
exec 9>"$ST/$JOB.lock"; flock -n 9 || exit 0
[ -e "$ST/done-$day" ] && [ "${1:-}" != --force ] && exit 0
OUT="$HERE/out/$day"; mkdir -p "$OUT"
log() { echo "$(date -Is) $*" >>"$ST/$JOB.log"; }

render() {   # render <template> KEY=VALUE ...
  python3 - "$@" <<'PY'
import sys
t = open(sys.argv[1]).read()
for kv in sys.argv[2:]:
    k, v = kv.split("=", 1); t = t.replace("{{" + k + "}}", v)
print(t)
PY
}

run_agent() {   # run_agent <session name> <prompt>: resumes the named session if it already exists
  local name="$1" sid perms args
  sid="$(python3 -c 'import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, "being-research/" + sys.argv[1]))' "$JOB/$name")"
  local cdir; cdir="$HOME/.claude/projects/$(printf '%s' "$WORKSPACE" | sed 's#[^A-Za-z0-9]#-#g')"
  args=(--session-id "$sid"); [ -f "$cdir/$sid.jsonl" ] && args=(--resume "$sid")
  perms=(--allowedTools "${JOB_ALLOWED_TOOLS:-Read,Write,Edit,Glob,Grep,WebSearch,WebFetch}")
  [ "${BEING_SKIP_PERMISSIONS:-0}" = 1 ] && perms=(--dangerously-skip-permissions)
  (cd "$WORKSPACE" && printf '%s' "$2" | claude -p "${perms[@]}" ${JOB_MODEL:+--model "$JOB_MODEL"} --name "$name" "${args[@]}") \
    >>"$ST/$name.log" 2>&1
}

[ -f "$HERE/workers.conf" ] || { log "no workers.conf"; exit 1; }
log "start $day"
n=0
while IFS='|' read -r worker hint; do
  [[ -z "$worker" || "$worker" == \#* ]] && continue
  run_agent "$JOB-$day-$worker" "$(render "$HERE/worker-prompt.md" DAY="$day" WORKER="$worker" HINT="$hint" \
    OUT="${OUT#"$WORKSPACE"/}/$worker.md")" &
  n=$((n + 1))
  (( n % ${JOB_PARALLEL:-4} == 0 )) && wait
done <"$HERE/workers.conf"
wait; log "workers done ($n)"

run_agent "$JOB-$day" "$(render "$HERE/merge-prompt.md" DAY="$day" DIR="${OUT#"$WORKSPACE"/}")"; rc=$?
if [ "$rc" -eq 0 ] && [ -s "$OUT/REPORT.md" ]; then touch "$ST/done-$day"; log "done"; else log "merge failed (exit $rc)"; rc=1; fi
exit "$rc"
