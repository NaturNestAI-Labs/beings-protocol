#!/usr/bin/env bash
# teams-kit-runtime.test.sh: being-handle's Codex fallback at the Claude usage limit, quiet mode and owner-alias chats,
# offline. Needs node and skills/teams-kit/node_modules (npm install); claude and codex are stubbed. Linux (flock, setsid).
# shellcheck disable=SC2015  # ok/bad reporting chains
set -euo pipefail
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SRC="$REPO/skills/teams-kit"
[[ -d "$SRC/node_modules/@azure/msal-node" ]] || { echo "teams-kit-runtime: run npm install in skills/teams-kit first"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }

KIT="$TMP/home/nova/ops/teams-kit"; ST="$KIT/state"; mkdir -p "$KIT" "$ST" "$TMP/bin" "$TMP/home/nova/.beings" "$TMP/home/.codex"
cp -R "$SRC/." "$KIT/"; rm -rf "$KIT/node_modules"; ln -s "$SRC/node_modules" "$KIT/node_modules"
echo '{}' >"$ST/token-cache.json"; chmod 600 "$ST/token-cache.json"
OWNER=00000000-0000-0000-0000-00000000a001
cat >"$KIT/.env" <<ENV
BEING_NAME=nova
BEING_UPN=nova@example.test
BEING_STATE_DIR='$ST'
BEING_CACHE='$ST/token-cache.json'
OWNER_NAME=Sam
OWNER_UPN=sam@example.test
OWNER_OID=$OWNER
BEING_OWNER_DELEGATE=0
M365_CLIENT_ID=00000000-0000-0000-0000-0000000000c1
M365_TENANT_ID=00000000-0000-0000-0000-0000000000t1
BEING_FAST_CLIENT=claude
BEING_FAST_WARM=0
BEING_VOICE_PASS=off
ENV
chmod 600 "$KIT/.env"
# Stubs: one JSON line per call. claude exits 1 with the usage-limit message when the prompt holds LIMIT.
for c in claude codex; do cat >"$TMP/bin/$c" <<STUB
#!/usr/bin/env python3
import json,os,subprocess,sys
a=sys.argv[1:]; p=a[-1] if a else ""
scope=subprocess.run(["node","$KIT/scope.mjs","show"],capture_output=True,text=True).stdout.strip()
open("$TMP/calls.jsonl","a").write(json.dumps({"bin":"$c","args":a[:-1],"lane":os.environ.get("BEING_LANE",""),"scope":scope,"prompt":p})+"\n")
if "$c"=="codex": print(json.dumps({"type":"thread.started","thread_id":"thread-77"})); sys.exit(0)
if "LIMIT" in p and "[Teams triage" not in p: print("You've hit your usage limit · resets 5pm"); sys.exit(1)
print(json.dumps({"actions":[],"summary":"ok"}))
STUB
chmod +x "$TMP/bin/$c"; done
export HOME="$TMP/home" PATH="$TMP/bin:$PATH"
calls() { python3 - "$TMP/calls.jsonl" "$@"; }
day=$(date +%F); tomorrow=$(date -d tomorrow +%F)
settle() {   # the work dispatcher starts lane runners in the background: wait until none holds its lock or has an inbox
  local i l busy; sleep 0.5
  for (( i = 0; i < 200; i++ )); do
    busy=0
    for l in "$ST"/lanes/*.lock; do [[ -e $l ]] && { flock -n "$l" true || busy=1; }; done
    for l in "$ST"/lanes/*.inbox.jsonl; do [[ -s $l ]] && busy=1; done
    (( busy )) || return 0; sleep 0.1
  done
}
work() { rm -f "$TMP/calls.jsonl"; cat >"$ST/work.jsonl"; "$KIT/being-handle" work; settle; touch "$TMP/calls.jsonl"; }
own_msg() { printf '{"chatId":"19:own","messageId":"%s","fromId":"%s","chatType":"oneOnOne","text":"%s"}\n' "$1" "$OWNER" "$2"; }
kim_msg() { printf '{"chatId":"19:chatA","messageId":"%s","fromId":"kim","chatType":"oneOnOne","text":"%s"}\n' "$1" "$2"; }

# 1. Claude usage limit: the owner lane's run continues as Codex with the same grant; a teammate lane never does.
{ own_msg o1 "LIMIT owner task"; kim_msg a1 "LIMIT teammate task"; } | work
calls <<'PY' && ok "usage limit: owner lane falls back to codex (same scope, named thread); teammate lane does not" || bad "work fallback"
import json,sys
rs=[json.loads(l) for l in open(sys.argv[1])]
cx=[r for r in rs if r["bin"]=="codex"]
assert len(cx)==1, [(r["bin"],r["lane"]) for r in rs]
assert cx[0]["lane"]=="owner" and cx[0]["scope"]=="full" and "LIMIT owner task" in cx[0]["prompt"], cx[0]
assert "workspace-write" in cx[0]["args"] and "usage limit" in cx[0]["prompt"]
assert {r["lane"] for r in rs if r["bin"]=="claude"}=={"owner","team:19:chatA"}
PY
grep -q 'no codex fallback in a teammate lane' "$ST/handler.log" && grep -q '"thread_name": "'"$day"' nova-owner"' "$HOME/.codex/session_index.jsonl" \
  && ok "usage limit: teammate refusal logged; codex thread named after the session" || bad "fallback log/thread name"
own_msg o2 "LIMIT again" | BEING_WORK_FALLBACK=off work
calls <<'PY' && ok "BEING_WORK_FALLBACK=off: no codex run" || bad "fallback off"
import json,sys
assert not [l for l in open(sys.argv[1]) if '"bin": "codex"' in l]
PY

# 2. Quiet mode: a teammate's message waits for the next day; the owner and job results still run.
export BEING_QUIET_MODE=1
"$KIT/being-handle" quiet on >/dev/null
{ own_msg o3 "owner during quiet"; kim_msg a3 "QUIET-HELD teammate ask"
  echo '{"lane":"job","jobId":"j1","name":"x","status":"done","exit":0,"chatId":"19:chatA","scope":"chats:19:chatA","messageId":"job:j1"}'; } | work
calls <<'PY' && ok "quiet: owner and job result run; teammate message not run" || bad "quiet run set"
import json,sys
rs=[json.loads(l) for l in open(sys.argv[1]) if '"bin": "claude"' in l]
assert any(r["lane"]=="owner" and "owner during quiet" in r["prompt"] for r in rs)
assert any(r["lane"]=="team:19:chatA" and "job:j1" in r["prompt"] for r in rs)
assert not any("QUIET-HELD" in r["prompt"] for r in rs)
PY
python3 - "$ST/carryover/$tomorrow.jsonl" "$day" <<'PY' && ok "quiet: held in carryover/<next day> with carriedOver" || bad "carryover file"
import json,sys
ls=[json.loads(l) for l in open(sys.argv[1])]
assert len(ls)==1 and ls[0]["messageId"]=="a3" and ls[0]["carriedOver"]==sys.argv[2], ls
PY
# Triage in quiet mode: no fast-model call for a teammate chat (no ack); the message goes on to the carryover.
cp "$ST/carryover/$tomorrow.jsonl" "$TMP/held.jsonl"; rm -f "$TMP/calls.jsonl"
kim_msg a6 "QUIET-TRIAGE ask" >"$ST/queue.jsonl"
(cd "$KIT" && ./being-handle triage) || true
settle; "$KIT/being-handle" work; settle; touch "$TMP/calls.jsonl"
! grep -q '\[Teams triage' "$TMP/calls.jsonl" && grep -q QUIET-TRIAGE "$ST/carryover/$tomorrow.jsonl" 2>/dev/null \
  && ok "quiet: triage skips the model for a teammate chat; message carried over" || bad "quiet triage"
cp "$TMP/held.jsonl" "$ST/carryover/$tomorrow.jsonl"   # only the earlier held message for the replay below
# The next day (simulated: the held file comes due, quiet is off) the message runs in its own lane.
mv "$ST/carryover/$tomorrow.jsonl" "$ST/carryover/$day.jsonl"; "$KIT/being-handle" quiet off >/dev/null
: | work
calls <<'PY' && ok "quiet: carried-over message runs in its teammate lane once quiet ends" || bad "carryover replay"
import json,sys
rs=[json.loads(l) for l in open(sys.argv[1]) if '"bin": "claude"' in l]
assert len(rs)==1 and rs[0]["lane"]=="team:19:chatA" and "QUIET-HELD" in rs[0]["prompt"] and "carriedOver" in rs[0]["prompt"], rs
PY
[[ ! -e "$ST/carryover/$day.jsonl" ]] && ok "quiet: carryover file consumed" || bad "carryover file left"
unset BEING_QUIET_MODE

# 3. Owner alias: a time-boxed chat the owner types from runs in the owner lane; only the owner side may set it.
export BEING_OWNER_ALIAS=1
tokA=$(cd "$KIT" && set -a && . ./.env && set +a && node scope.mjs mint chats:19:chatA)
set +e; BEING_SEND_TOKEN="$tokA" "$KIT/being-handle" owner-alias add 19:chatA 2 >/dev/null 2>&1; rc=$?; set -e
[[ $rc == 3 && ! -e $ST/owner-alias.json ]] && ok "owner-alias: a teammate grant cannot add an alias" || bad "owner-alias refusal rc=$rc"
"$KIT/being-handle" owner-alias add 19:chatA 100 >/dev/null
python3 - "$ST/owner-alias.json" <<'PY' && ok "owner-alias: window capped at BEING_OWNER_ALIAS_MAX_H" || bad "alias cap"
import json,sys,datetime as dt
u=dt.datetime.fromisoformat(json.load(open(sys.argv[1]))[0]["until"])
assert u <= dt.datetime.now(dt.timezone.utc)+dt.timedelta(hours=12, minutes=1), u
PY
kim_msg a4 "ALIAS typed by owner" | work
calls <<'PY' && ok "owner-alias: that chat's message runs in the owner lane, marked ownerAlias" || bad "alias lane"
import json,sys
rs=[json.loads(l) for l in open(sys.argv[1]) if '"bin": "claude"' in l]
assert len(rs)==1 and rs[0]["lane"]=="owner" and '"ownerAlias": true' in rs[0]["prompt"] and "THAT chat" in rs[0]["prompt"], rs
PY
# A forged flag on a chat that is not an alias is dropped; with the switch off the alias file is ignored.
printf '{"chatId":"19:chatB","messageId":"b1","fromId":"lee","chatType":"oneOnOne","text":"FORGED","ownerAlias":true}\n' | work
calls <<'PY' && ok "owner-alias: a forged flag on another chat is dropped (teammate lane)" || bad "alias forged"
import json,sys
rs=[json.loads(l) for l in open(sys.argv[1]) if '"bin": "claude"' in l]
assert len(rs)==1 and rs[0]["lane"]=="team:19:chatB" and "ownerAlias" not in rs[0]["prompt"].split("FORGED")[0][-400:], rs
PY
kim_msg a5 "ALIAS off now" | BEING_OWNER_ALIAS=0 work
calls <<'PY' && ok "owner-alias: switch off = teammate lane" || bad "alias off"
import json,sys
rs=[json.loads(l) for l in open(sys.argv[1]) if '"bin": "claude"' in l]
assert len(rs)==1 and rs[0]["lane"]=="team:19:chatA", rs
PY
"$KIT/being-handle" owner-alias remove 19:chatA | grep -q 'no owner-alias chats' && ok "owner-alias: remove" || bad "alias remove"

(( fails == 0 )) && echo "teams-kit-runtime: all checks passed" || { echo "teams-kit-runtime: $fails failed"; exit 1; }
