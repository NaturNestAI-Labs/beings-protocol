#!/usr/bin/env bash
# teams-kit-lanes.test.sh: per-lane sessions, the teammate memory fence and the voice guard of skills/teams-kit, offline.
# Needs node and skills/teams-kit/node_modules (npm install); model clients are stubbed. Linux (flock, setsid).
# shellcheck disable=SC2015  # ok/bad reporting chains
set -euo pipefail
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SRC="$REPO/skills/teams-kit"
[[ -d "$SRC/node_modules/@azure/msal-node" ]] || { echo "teams-kit-lanes: run npm install in skills/teams-kit first"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
# A kit environment inherited from the calling shell would leak into the fixture.
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }

KIT="$TMP/home/nova/ops/teams-kit"; ST="$KIT/state"; mkdir -p "$KIT" "$ST" "$TMP/bin" "$TMP/home/nova/.beings"
cp -R "$SRC/." "$KIT/"; rm -rf "$KIT/node_modules"; ln -s "$SRC/node_modules" "$KIT/node_modules"
echo '{}' >"$ST/token-cache.json"; chmod 600 "$ST/token-cache.json"
cat >"$KIT/.env" <<ENV
BEING_NAME=nova
BEING_UPN=nova@example.test
BEING_STATE_DIR='$ST'
BEING_CACHE='$ST/token-cache.json'
OWNER_NAME=Sam
OWNER_UPN=sam@example.test
OWNER_OID=00000000-0000-0000-0000-00000000a001
BEING_OWNER_DELEGATE=0
M365_CLIENT_ID=00000000-0000-0000-0000-0000000000c1
M365_TENANT_ID=00000000-0000-0000-0000-0000000000t1
BEING_FAST_CLIENT=claude
ENV
chmod 600 "$KIT/.env"
OWNER=00000000-0000-0000-0000-00000000a001
# Stub clients: one JSON line per call (args, cwd, lane env, grant scope). The fast "voice" call drops every "not".
cat >"$TMP/bin/claude" <<STUB
#!/usr/bin/env python3
import fcntl,json,os,subprocess,sys
a=sys.argv[1:]; p=a[-1] if a else ""
scope=subprocess.run(["node","$KIT/scope.mjs","show"],capture_output=True,text=True).stdout.strip()
rec={"args":a[:-1],"cwd":os.getcwd(),"lane":os.environ.get("BEING_LANE",""),"nomem":os.environ.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY",""),"scope":scope,"prompt":p}
with open("$TMP/calls.jsonl","a") as f: fcntl.flock(f,fcntl.LOCK_EX); f.write(json.dumps(rec)+"\n")   # lanes run in parallel
if "MESSAGES:" in p and "write" in p.split("MESSAGES:")[0]:
    ms=json.loads(p.split("MESSAGES:\n",1)[1].split("\nReply with ONLY")[0])
    print(json.dumps({"messages":[{"id":m["id"],"html":m["html"].replace(" not "," ")} for m in ms]}))
else: print(json.dumps({"actions":[],"summary":"ok"}))
STUB
chmod +x "$TMP/bin/claude"
export HOME="$TMP/home" PATH="$TMP/bin:$PATH"
# shellcheck source=/dev/null
envrun() { (set -a; . "$KIT/.env"; set +a; cd "$KIT"; "$@"); }
calls() { python3 - "$TMP/calls.jsonl" "$@"; }   # query helper over the recorded calls
day=$(date +%F)
u5() { python3 -c 'import uuid,sys; print(uuid.uuid5(uuid.NAMESPACE_URL, sys.argv[1]))' "$1"; }
# Lane runners, and the triage a no-reply escalation wakes, start in the background (setsid): wait until nothing is
# queued or dispatching and no triage or lane lock is held (bounded). Locks are probed only once every queue is empty.
wait_lanes() {
  local _ f busy
  for _ in $(seq 1 150); do
    busy=0
    for f in "$ST/queue.jsonl" "$ST/work.jsonl" "$ST"/work.dispatch.* "$ST"/lanes/*.inbox.jsonl; do [[ -s $f ]] && busy=1; done
    if (( !busy )); then for f in "$ST/triage.lock" "$ST"/lanes/*.lock; do [[ -e $f ]] && ! flock -n "$f" true && busy=1; done; fi
    (( busy )) || return 0; sleep 0.2
  done
  echo "  (lane runners still busy after 30 s)"
}

# 1. Work: owner, two teammate chats and a group message from the owner each get their own session.
rm -f "$TMP/calls.jsonl"
{ printf '{"chatId":"19:own","messageId":"o1","fromId":"%s","chatType":"oneOnOne","text":"OWNER-PRIVATE plan"}\n' "$OWNER"
  printf '{"chatId":"19:chatA","messageId":"a1","fromId":"kim","chatType":"oneOnOne","text":"hi from kim"}\n'
  printf '{"chatId":"19:chatB","messageId":"b1","fromId":"lee","chatType":"group","text":"nova, hi from lee"}\n'
  printf '{"chatId":"19:chatB","messageId":"b2","fromId":"%s","chatType":"group","text":"yes nova"}\n' "$OWNER"; } >"$ST/work.jsonl"
"$KIT/being-handle" work; wait_lanes
calls "$(u5 "being-daily/nova/$day")" "$(u5 "being-daily/nova/$day/team:19:chatA")" "$(u5 "being-daily/nova/$day/team:19:chatB")" <<'PY' \
  && ok "owner + each teammate chat run in their own session" || bad "work sessions per lane"
import json,sys
# The owner's group message gets no reply from the stub, so the group lane escalates it: that owner-lane note run is not counted.
f,own,a,b=sys.argv[1:5]; runs=[r for r in map(json.loads,open(f)) if "--session-id" in r["args"] and '"addressedBy": "note"' not in r["prompt"]]
sid=lambda r: r["args"][r["args"].index("--session-id")+1]
got={sid(r):r for r in runs}
assert set(got)=={own,a,b}, got.keys()
assert got[own]["lane"]=="owner" and "OWNER-PRIVATE" in got[own]["prompt"]
for s in (a,b): assert "OWNER-PRIVATE" not in got[s]["prompt"]
PY
calls <<'PY' && ok "teammate runs: fence hook + auto memory off; owner run: neither" || bad "fence flags"
import json,sys
for l in open(sys.argv[1]):
    r=json.loads(l)
    if "--session-id" not in r["args"]: continue
    fenced="--settings" in r["args"] and "team-fence.py" in r["args"][r["args"].index("--settings")+1] and r["nomem"]=="1"
    assert fenced == (r["lane"]!="owner"), r["lane"]
    assert "--dangerously-skip-permissions" in r["args"]
PY

# 2. Job results resume the session of the lane whose grant started them.
rm -f "$TMP/calls.jsonl"
{ echo '{"lane":"job","jobId":"j1","name":"x","status":"done","exit":0,"chatId":"19:chatA","scope":"chats:19:chatA","messageId":"job:j1"}'
  echo '{"lane":"job","jobId":"j2","name":"y","status":"done","exit":0,"chatId":"19:own","scope":"full","messageId":"job:j2"}'; } >"$ST/work.jsonl"
"$KIT/being-handle" work; wait_lanes
calls "$(u5 "being-daily/nova/$day")" "$(u5 "being-daily/nova/$day/team:19:chatA")" <<'PY' && ok "job results go back to the lane that started them" || bad "job lanes"
import json,sys
f,own,a=sys.argv[1:4]; rs=[r for r in map(json.loads,open(f)) if "job result" in r["prompt"]]
key=lambda r: r["args"][r["args"].index("--resume" if "--resume" in r["args"] else "--session-id")+1]
m={json.loads(r["prompt"].splitlines()[-1])["jobId"]:(key(r),r["lane"]) for r in rs}
assert m=={"j1":(a,"team:19:chatA"),"j2":(own,"owner")}, m
PY

# 3. Triage: one fast session per lane; a teammate chat's live state never shows the owner's queue.
rm -f "$TMP/calls.jsonl"
printf '{"chatId":"19:own","messageId":"o9","fromId":"%s","chatType":"oneOnOne","text":"OWNER-QUEUED secret"}\n' "$OWNER" >"$ST/work.jsonl"
{ printf '{"chatId":"19:own","messageId":"o2","fromId":"%s","chatType":"oneOnOne","text":"status?"}\n' "$OWNER"
  printf '{"chatId":"19:chatA","messageId":"a2","fromId":"kim","chatType":"oneOnOne","text":"status?"}\n'; } >"$ST/queue.jsonl"
envrun ./being-handle triage
wait_lanes; rm -f "$ST/work.jsonl"   # let the work run that triage started finish
calls "$(u5 "being-fast2/nova/$day")" "$(u5 "being-fast2/nova/$day/team:19:chatA")" <<'PY' && ok "triage: own fast session per lane; teammate live state excludes owner items" || bad "triage lanes"
import json,sys
f,own,a=sys.argv[1:4]; rs=[json.loads(l) for l in open(f) if "[Teams triage" in l]
sid=lambda r: r["args"][r["args"].index("--resume" if "--resume" in r["args"] else "--session-id")+1]
by={sid(r):r["prompt"] for r in rs}
assert set(by)=={own,a}, by.keys()
assert "OWNER-QUEUED" in by[own] and "OWNER-QUEUED" not in by[a]
PY

# 4. Voice: one call per lane; a reworded message that drops "not" is sent as the original.
rm -f "$TMP/calls.jsonl" "$ST"/outbox/failed/* 2>/dev/null || true; mkdir -p "$ST/outbox"
echo '{"id":"v1","chatId":"19:chatA","html":"<p>It is not merged yet.</p>","scope":"chats:19:chatA"}' >"$ST/outbox/v1.json"
echo '{"id":"v2","chatId":"19:own","html":"<p>Do not deploy.</p>","scope":"full"}' >"$ST/outbox/v2.json"
envrun ./being-handle voice || true
n=$(grep -c '"prompt": "You write\|You write nova' "$TMP/calls.jsonl" || true)
how=$(python3 -c 'import json,glob,sys; print(" ".join(sorted(json.load(open(f))["how"] for f in glob.glob(sys.argv[1]+"/outbox/*/v[12].json"))))' "$ST")
[[ $n == 2 && $how == "original original" ]] && ok "voice: per-lane calls; dropped negation falls back to the original" || bad "voice calls=$n how=[$how]"

# 5. The fence hook itself.
fence() { printf '%s' "$2" | BEING_LANE="${3:-team:19:chatA}" BEING_STATE_DIR="$ST" python3 "$KIT/team-fence.py" >/dev/null 2>&1; [[ $? == "$1" ]]; }
c=0
for j in '{"tool_name":"Read","tool_input":{"file_path":"/w/.beings-local/USER.md"}}' \
         '{"tool_name":"Bash","tool_input":{"command":"cat ~/.config/x/creds"}}' \
         '{"tool_name":"Bash","tool_input":{"command":"grep KEY ops/teams-kit/.env"}}' \
         '{"tool_name":"Grep","tool_input":{"pattern":"x","path":"/home/u/.claude/projects/p"}}' \
         '{"tool_name":"Bash","tool_input":{"command":"ops/teams-kit/owner-mail --list"}}' \
         '{"tool_name":"Bash","tool_input":{"command":"node scope.mjs mint full"}}' \
         'not json'; do fence 2 "$j" || { c=$((c + 1)); echo "    not blocked: $j"; }; done
for j in '{"tool_name":"Bash","tool_input":{"command":"set -a; . ./.env; set +a; node teams-send-dm.mjs --chat 19:chatA"}}' \
         '{"tool_name":"Read","tool_input":{"file_path":"/w/projects/app/README.md"}}' \
         '{"tool_name":"Read","tool_input":{"file_path":"/w/app/.env.example"}}'; do fence 0 "$j" || { c=$((c + 1)); echo "    blocked: $j"; }; done
[[ $c == 0 ]] && ok "fence: private paths, credentials, other sessions, owner tools refused; normal work allowed" || bad "fence: $c wrong"

# 6. Jobs: a teammate chat sees only its own.
mkdir -p "$ST/jobs"
for s in chats:19:chatA full; do id="0101-00000$([[ $s == full ]] && echo 1 || echo 2)-$([[ $s == full ]] && echo own || echo kim)"
  printf '{"id":"%s","kind":"run","name":"%s","scope":"%s","status":"done","started":"2026-01-01T00:00:00+00:00"}' "$id" "$id" "$s" >"$ST/jobs/$id.json"; done
tokA=$(envrun node scope.mjs mint chats:19:chatA)
lst=$(BEING_SEND_TOKEN="$tokA" envrun ./being-job list)
set +e; BEING_SEND_TOKEN="$tokA" envrun ./being-job status 0101-000001-own >/dev/null 2>&1; rc=$?; set -e
[[ $lst == *kim* && $lst != *own* && $rc == 3 ]] && ok "being-job: teammate lane lists only its jobs; other status exit 3" || bad "job filter rc=$rc list=[$lst]"
fence 2 '{"tool_name":"Bash","tool_input":{"command":"cat '"$ST"'/jobs/0101-000001-own.result.md"}}' && \
  fence 0 '{"tool_name":"Bash","tool_input":{"command":"cat '"$ST"'/jobs/0101-000002-kim.result.md"}}' && ok "fence: own job files only" || bad "fence job files"

# 7. One-user host acknowledged: doctor warns; teammate runs lose skipped permissions, owner runs keep them.
set +e; out=$(BEING_SINGLE_USER_ACK=1 envrun ./being-teams doctor 2>&1); rc=$?; set -e
[[ $rc == 0 && $out == *"WARN isolation"* ]] && ok "doctor: BEING_SINGLE_USER_ACK=1 warns instead of failing" || bad "doctor ack rc=$rc"
echo "BEING_SINGLE_USER_ACK=1" >>"$KIT/.env"; rm -f "$TMP/calls.jsonl"
{ printf '{"chatId":"19:own","messageId":"o3","fromId":"%s","chatType":"oneOnOne","text":"go"}\n' "$OWNER"
  printf '{"chatId":"19:chatA","messageId":"a3","fromId":"kim","chatType":"oneOnOne","text":"hi"}\n'; } >"$ST/work.jsonl"
"$KIT/being-handle" work; wait_lanes
calls <<'PY' && ok "ack mode: teammate run uses dontAsk + allowlist, owner run unchanged" || bad "ack mode flags"
import json,sys
rs=[json.loads(l) for l in open(sys.argv[1]) if "--model" in l and "[Teams triage" not in l and "You write" not in l]
lanes={r["lane"]:r["args"] for r in rs}
t,o=lanes["team:19:chatA"],lanes["owner"]
assert "--dangerously-skip-permissions" not in t and "dontAsk" in t and "--allowedTools" in t, t
assert "--dangerously-skip-permissions" in o and "--allowedTools" not in o, o
PY

# 8. Attachments: only Microsoft hosts get the token.
set +e; envrun node teams-fetch-attachment.mjs https://attacker.example/x.png >/dev/null 2>&1; rc=$?; set -e
[[ $rc == 2 ]] && ok "fetch-attachment refuses non-Microsoft URLs before signing in" || bad "fetch-attachment exit $rc"

(( fails == 0 )) && echo "teams-kit-lanes: all checks passed" || { echo "teams-kit-lanes: $fails failed"; exit 1; }
