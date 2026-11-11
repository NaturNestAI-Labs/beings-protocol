#!/usr/bin/env bash
# test-sandbox.sh: no-root simulation of the isolation layer (bwrap) on a fixture kit, plus checks on this host's paths.
# Exit 0 = every check passed; prints only pass/fail, never file contents (checks: isolation/README.md).
set -uo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
T=$(mktemp -d /tmp/iso-test.XXXXXX); trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "  ok   $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }
expect() { local want=$1 what=$2; shift 2; "$@" >/dev/null 2>&1; local rc=$?
  if [[ $want == 0 && $rc == 0 ]] || [[ $want != 0 && $rc != 0 ]]; then ok "$what"; else bad "$what (rc=$rc)"; fi; }
# Inside a sandbox: the check counts only if the sandbox really started (marker), so a broken sandbox can't pass a "denied".
sbx() { local want=$1 what=$2 fn=$3 cmd=$4 out rc
  out=$("$fn" "echo __IN__; ( $cmd ) >/dev/null 2>&1; echo __RC=\$?" 2>&1); rc=$(sed -n 's/^__RC=//p' <<<"$out")
  if ! grep -q __IN__ <<<"$out"; then bad "$what (sandbox did not start: $(tail -1 <<<"$out"))"; return; fi
  if [[ $want == 0 && $rc == 0 ]] || [[ $want != 0 && $rc != 0 ]]; then ok "$what"; else bad "$what (rc=$rc)"; fi; }

# --- fixture: kit (only what the broker needs), its state with fake secrets, and a workspace with private files -------
K=$T/home/kituser/kit; W=$T/home/kituser/ws; S=$K/state
mkdir -p "$K/isolation" "$S/conversations" "$S/grants" "$W/.beings/memory" "$W/.beings/bond" "$W/.beings/memory-graph" "$W/.beings/daemon" "$W/work-log"
cp "$SRC/kit-broker" "$SRC/being-launch" "$SRC/team-sync" "$SRC/kit-client.mjs" "$SRC/model-proxy.mjs" "$SRC/model-relay.mjs" "$K/"
cp "$SRC/isolation/model-run" "$SRC/isolation/make-shims" "$K/isolation/"
for f in scope.mjs kit-env.mjs; do cp "${KIT_SRC:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}/$f" "$K/"; done
printf '#!/usr/bin/env python3\nimport os,sys\nprint("status for", sys.argv[1:], "lane", os.environ.get("BEING_LANE"))\n' >"$K/being-status"; chmod +x "$K/being-status"
cat >"$K/mail.mjs" <<'JS'
import fs from 'node:fs'; const a = process.argv.slice(2); const i = a.indexOf('--attach');
if (i >= 0) for (const f of a[i + 1].split(',')) process.stdout.write(`ATTACHED ${f.split('/').pop()}: ${fs.readFileSync(f, 'utf8')}`);
JS
printf '#!/bin/sh\necho OWNER-READ-RAN\n' >"$K/owner-read"; chmod +x "$K/owner-read"
cat >"$K/.env" <<EOF
BEING_NAME=Testbeing
BEING_STATE_DIR=$S
BEING_WORKSPACE=$W
OWNER_NAME=Owner
FAKE_SECRET=kit-env-secret-123
EOF
chmod 600 "$K/.env"
echo '{"refresh_token":"fake-cache-secret"}' >"$S/token-cache.json"; chmod 600 "$S/token-cache.json"
echo deadbeef >"$S/handler.key"; chmod 600 "$S/handler.key"
echo "public soul text" >"$S/soul-public.md"
CHAT="19:teamchat@thread.v2"; OTHER="19:otherchat@thread.v2"
echo '{"text":"hello from teammate"}' >"$S/conversations/19_teamchat@thread.v2.jsonl"
echo '{"text":"other teammate secret"}' >"$S/conversations/19_otherchat@thread.v2.jsonl"
echo "owner private memory" >"$W/.beings/MEMORY.md"
echo "daily log" >"$W/.beings/memory/2026-10-12.md"
echo "bond" >"$W/.beings/bond/bond_us.md"
mkdir -p "$W/.secrets/model"; echo "customer-vm-pass" >"$W/.secrets/vm.md"; echo "model-key" >"$W/.secrets/model/gateway.key"
echo '{"t":"ws-token"}' >"$W/.beings/daemon/.token-cache-testbeing.json"; chmod 600 "$W/.beings/daemon/.token-cache-testbeing.json"
printf -- '---\nshare: team\n---\nshared design\n' >"$W/.beings/memory-graph/design.md"
printf -- '---\nshare: private\n---\nprivate design\n' >"$W/.beings/memory-graph/private.md"
printf -- 'no frontmatter\n' >"$W/.beings/memory-graph/plain.md"
printf -- '---\nshare: team\n---\nbut in daily logs\n' >"$W/.beings/memory/shared-by-mistake.md"
echo "CLAUDE_CODE_OAUTH_TOKEN=sandbox-cred-xyz" >"$T/team-cred.env"; chmod 600 "$T/team-cred.env"

unset BEING_ISOLATION_LANES   # the host kit env may carry the live value (team); the first half tests every lane sandboxed
export BEING_KIT_HOME=$K BEING_STATE_DIR=$S BEING_WORKSPACE=$W BEING_ISOLATION=bwrap BEING_NAME=Testbeing
export BEING_SANDBOX_CLAUDE_ENV=$T/team-cred.env
"$K/isolation/make-shims" >/dev/null
L() { "$K/being-launch" "$@"; }

echo "team-sync (allowlist by construction)"
python3 "$K/team-sync" "$CHAT" >/dev/null && python3 "$K/team-sync" "$OTHER" >/dev/null
tag=$(printf '%s' "$CHAT" | sha1sum | cut -c1-10); LD=$S/team-lanes/$tag
expect 0 "lane has the public soul" test -s "$LD/SOUL.md"
expect 0 "lane has share: team note" test -s "$LD/shared/.beings/memory-graph/design.md"
expect 1 "lane lacks share: private note" test -e "$LD/shared/.beings/memory-graph/private.md"
expect 1 "lane lacks note without frontmatter" test -e "$LD/shared/.beings/memory-graph/plain.md"
expect 1 "share: team inside .beings/memory/ is still not copied" test -e "$LD/shared/.beings/memory/shared-by-mistake.md"
expect 0 "lane conversation is this chat's" grep -q "hello from teammate" "$LD/conversation.jsonl"
expect 1 "lane conversation has nothing of the other chat" grep -q "other teammate" "$LD/conversation.jsonl"

echo "teammate run (bwrap, own lane only)"
TL() { L "team:$CHAT" -- bash -c "$1"; }
XL() { L "team:$CHAT" --expose "$S/soul-public.md" -- bash -c "$1"; }
sbx 1 "cannot read MEMORY.md at the workspace path" TL "cat $W/.beings/MEMORY.md"
sbx 1 "cannot read the daily log" TL "cat $W/.beings/memory/2026-10-12.md"
sbx 1 "cannot read the bond" TL "cat $W/.beings/bond/bond_us.md"
sbx 1 "cannot read the kit .env" TL "cat $K/.env"
sbx 1 "cannot read the token cache" TL "cat $S/token-cache.json"
sbx 1 "cannot read handler.key" TL "cat $S/handler.key"
sbx 1 "cannot see the other lane" TL "ls $S/team-lanes"
sbx 1 "cannot find kit secrets anywhere it can see" TL "grep -rqs -e kit-env-secret-123 -e fake-cache-secret -e deadbeef -e 'owner private memory' / --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev --exclude-dir=usr --exclude-dir=etc"
sbx 0 "reads its public soul at the workspace path" TL "grep -q 'public soul' $W/SOUL.md"
sbx 0 "reads the shared note" TL "test -s $W/shared/.beings/memory-graph/design.md"
sbx 0 "writes its own work dir" TL "echo x > $W/work/out.txt"
sbx 1 "cannot write the lane's soul or CLAUDE.md" TL "echo x >> $W/CLAUDE.md"
sbx 0 "own /proc only (pid namespace)" TL "test \$(ls -d /proc/[0-9]* | wc -l) -lt 10"
sbx 1 "no grant token in the model environment" TL "env | grep -q BEING_SEND_TOKEN"
sbx 0 "its model credential is in the environment" TL "test \"\$CLAUDE_CODE_OAUTH_TOKEN\" = sandbox-cred-xyz"
sbx 0 "broker reachable from the shim path: ping" TL "KIT_CLIENT_VERB=ping node $K/being-status | grep -q 'pong team $CHAT'"
sbx 0 "being-status through the broker is forced to this chat" TL "$K/being-status --all | grep -q \"'--chat', '$CHAT'\""
sbx 1 "broker refuses owner-read for a teammate" TL "$K/owner-read --list | grep -q OWNER-READ-RAN"
sbx 1 "broker refuses the hive for a teammate" TL "echo '{}' | $K/hive-mcp-stdio"

mkdir -p "$S/jobs"
sbx 0 "--expose: the kit's soul file is readable at its own path" XL "grep -q 'public soul' $S/soul-public.md"
sbx 1 "--expose: nothing else of kit state comes with it" XL "cat $S/token-cache.json"
L "team:$CHAT" --collect "$S/jobs/0000-000000-t.result.md" -- bash -c "echo job-result-text > $S/jobs/0000-000000-t.result.md" >/dev/null 2>&1
expect 0 "--collect: the run's RESULT file is copied back to kit state" grep -q job-result-text "$S/jobs/0000-000000-t.result.md"

echo "owner/job run (bwrap, workspace yes, kit secrets no)"
OL() { L owner --cwd "$W" -- bash -c "$1"; }
sbx 0 "reads MEMORY.md" OL "grep -q 'owner private memory' $W/.beings/MEMORY.md"
sbx 0 "writes the workspace" OL "echo line >> $W/.beings/memory/2026-10-12.md"
sbx 1 "cannot read the kit .env" OL "cat $K/.env"
sbx 1 "cannot read the token cache" OL "cat $S/token-cache.json"
sbx 1 "cannot read handler.key" OL "cat $S/handler.key"
sbx 1 "cannot read a token cache left in the workspace" OL "grep -q ws-token $W/.beings/daemon/.token-cache-testbeing.json"
sbx 1 "cannot read .secrets (kit-only by default)" OL "grep -q customer-vm-pass $W/.secrets/vm.md"
sbx 0 "reads .secrets/model (the model's own keys)" OL "grep -q model-key $W/.secrets/model/gateway.key"
sbx 1 "teammate cannot read .secrets/model either" TL "test -e $W/.secrets/model/gateway.key"
sbx 0 "kit path holds the shims, not the kit" OL "test -x $K/being-job && ! test -e $K/scope.mjs"
sbx 0 "owner-read goes through the broker" OL "$K/owner-read --list | grep -q OWNER-READ-RAN"
sbx 0 "attachment travels as bytes, read as the caller" OL "echo report-body > $W/r.txt && node $K/mail.mjs --send --attach $W/r.txt | grep -q 'ATTACHED r.txt: report-body'"
sbx 1 "attaching a kit file fails (the caller cannot read it)" OL "node $K/mail.mjs --send --attach $K/.env | grep -q kit-env-secret"
raw_attach() {   # a caller that skips the client and names a kit path directly: the broker must refuse (exit 3)
  local sock=$T/raw.sock; python3 "$K/kit-broker" serve --socket "$sock" --class ai --peer-uid "$(id -u)" >/dev/null 2>&1 & local bp=$!
  for _ in $(seq 50); do [[ -S $sock ]] && break; sleep 0.1; done
  python3 - "$sock" "$K/.env" <<'PY'
import json,socket,struct,sys
c=socket.socket(socket.AF_UNIX); c.connect(sys.argv[1]); h=json.dumps({"verb":"mail","args":["--send","--attach",sys.argv[2]]}).encode()
c.sendall(b"H"+struct.pack(">I",len(h))+h+b"E"+struct.pack(">I",0)); buf=b""
while True:
    d=c.recv(65536)
    if not d: break
    buf+=d
i=buf.rfind(b"X"); rc=json.loads(buf[i+5:])["rc"]; sys.exit(0 if rc==3 and b"refused" in buf and b"kit-env-secret" not in buf else 1)
PY
  local rc=$?; kill $bp; return $rc; }
expect 0 "a raw kit path in --attach (no bytes) is refused by the broker" raw_attach
wrong_uid() {   # SO_PEERCRED: a broker for another uid refuses this caller before reading anything
  local sock=$T/uid.sock; python3 "$K/kit-broker" serve --socket "$sock" --class ai --peer-uid 4242 >/dev/null 2>&1 & local bp=$!
  for _ in $(seq 50); do [[ -S $sock ]] && break; sleep 0.1; done
  local out; out=$(BEING_BROKER_SOCK=$sock KIT_CLIENT_VERB=ping node "$K/kit-client.mjs" 2>&1 </dev/null); kill $bp; grep -q "peer uid" <<<"$out"; }
expect 0 "a broker refuses a caller whose uid is not the run's" wrong_uid
sbx 0 "broker class is ai" OL "KIT_CLIENT_VERB=ping node $K/being-status | grep -q 'pong ai'"

echo "argv hygiene"
L "team:$CHAT" -- bash -c 'sleep 2' & sleep 1
if ps -eo args | grep -v grep | grep -q -e sandbox-cred-xyz -e BEING_SEND_TOKEN=; then bad "secret on an argv"; else ok "no credential or grant on any argv"; fi
wait

echo "broker validation (kit-broker check)"
expect 1 "team: mail refused" python3 "$K/kit-broker" check team mail --list
expect 1 "team: being-job codex refused" python3 "$K/kit-broker" check team being-job codex x --notify c t
expect 1 "ai: being-job run refused until wired" python3 "$K/kit-broker" check ai being-job run x --notify c -- sh -c id
expect 0 "team: being-job agent allowed" python3 "$K/kit-broker" check team being-job agent x --notify c task
expect 1 "unknown verb refused" python3 "$K/kit-broker" check ai bash -c id
expect 0 "arguments are argv, not shell" bash -c "python3 '$K/kit-broker' check ai teams-send-dm --chat 'x; rm -rf /' | grep -q 'x; rm -rf /'"

echo "privileges inside a teammate sandbox (no_new_privs: setuid sudo/su/pkexec cannot raise; never run outside)"
sbx 0 "no_new_privs is set" TL "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status"
sbx 0 "sudo binary is present (so the next check is real)" TL "test -x /usr/bin/sudo"
sbx 1 "sudo -n true fails" TL "sudo -n true </dev/null"
sbx 1 "su fails non-interactively" TL "timeout 5 su -c true root </dev/null"
if [[ -x /usr/bin/pkexec ]]; then sbx 1 "pkexec fails" TL "timeout 5 pkexec true </dev/null"; else ok "pkexec not installed (nothing to check)"; fi

echo "model proxy (teammate lane without a credential of its own)"
cat >"$T/upstream.py" <<'PY2'
import http.server,sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(s):
        n=int(s.headers.get("content-length") or 0); s.rfile.read(n)
        ok=s.headers.get("authorization")=="Bearer fixture-access-tok" and "oauth-2025-04-20" in (s.headers.get("anthropic-beta") or "")
        b=b"AUTH-OK" if ok else b"AUTH-BAD"; s.send_response(200); s.send_header("content-length",str(len(b))); s.end_headers(); s.wfile.write(b)
    def log_message(s,*a): pass
srv=http.server.HTTPServer(("127.0.0.1",0),H); print(srv.server_address[1],flush=True); srv.serve_forever()
PY2
coproc UP { exec python3 "$T/upstream.py"; }; read -r -t 5 upport <&"${UP[0]}"
printf '{"claudeAiOauth":{"accessToken":"fixture-access-tok","expiresAt":%s}}' "$(( ($(date +%s) + 3600) * 1000 ))" >"$T/creds.json"; chmod 600 "$T/creds.json"
PL() { env -u BEING_SANDBOX_CLAUDE_ENV BEING_PROXY_CRED="$T/creds.json" BEING_PROXY_UPSTREAM="http://127.0.0.1:$upport" \
  "$K/being-launch" "team:$CHAT" -- bash -c "$1"; }
q="node -e 'fetch(process.env.ANTHROPIC_BASE_URL+\"/v1/messages\",{method:\"POST\",headers:{authorization:\"Bearer \"+process.env.ANTHROPIC_AUTH_TOKEN},body:\"{}\"}).then(r=>r.text()).then(t=>{console.log(t);process.exit(t===\"AUTH-OK\"?0:1)})'"
sbx 0 "the model call works through the proxy (login swapped in by the kit)" PL "$q"
sbx 1 "the run never holds the login (not in its environment)" PL "env | grep -q fixture-access-tok"
sbx 1 "the run cannot read the login file" PL "cat $T/creds.json"
sbx 1 "no host network: the host loopback is unreachable (--unshare-net)" PL "node -e 'fetch(\"http://127.0.0.1:$upport/\").then(()=>process.exit(0),()=>process.exit(1))'"
sbx 0 "own network namespace: loopback only" PL "node -e 'process.exit(Object.keys(require(\"os\").networkInterfaces()).join()===\"lo\"?0:1)'"
sbx 0 "a wrong key gets 401 from the proxy" PL "node -e 'fetch(process.env.ANTHROPIC_BASE_URL+\"/v1/messages\",{method:\"POST\",headers:{\"x-api-key\":\"nope\"}}).then(r=>process.exit(r.status===401?0:1))'"
kill "$UP_PID" 2>/dev/null

echo "teammate lanes only (BEING_ISOLATION_LANES=team)"
OT() { BEING_ISOLATION_LANES=team "$K/being-launch" owner --cwd "$W" -- bash -c "$1"; }
JT() { BEING_ISOLATION_LANES=team "$K/being-launch" job --cwd "$W" -- bash -c "$1"; }
TT() { BEING_ISOLATION_LANES=team "$K/being-launch" "team:$CHAT" -- bash -c "$1"; }
sbx 0 "owner lane runs unchanged (sees the real kit, as with off)" OT "test -r $K/.env && test -e $K/scope.mjs"
sbx 0 "owner lane keeps the host /proc (not sandboxed)" OT "test \$(ls -d /proc/[0-9]* | wc -l) -gt 10"
sbx 0 "job lane runs unchanged" JT "test -r $K/.env"
sbx 1 "teammate lane is still sandboxed: kit .env" TT "cat $K/.env"
sbx 1 "teammate lane is still sandboxed: MEMORY.md" TT "cat $W/.beings/MEMORY.md"
sbx 0 "teammate lane still has no_new_privs" TT "grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status"

echo "broker dry run (live checks send nothing)"
: >"$S/broker.log"
DT() { BEING_BROKER_DRY=1 BEING_ISOLATION_LANES=team "$K/being-launch" "team:$CHAT" -- bash -c "$1"; }
sbx 0 "dry-run broker answers the send" DT "echo hello-dry | node $K/teams-send-dm.mjs --chat x 2>&1 | grep -q 'dry run'"
expect 0 "broker.log records what would have run, with the reply text" grep -q "DRY would run .*teams-send-dm.*hello-dry" "$S/broker.log"

echo "real paths on this host (teammate profile; nothing is read, only existence)"
RH=$HOME; RK=${REAL_KIT:-$RH/beings-protocol/skills/teams-kit}; RW=${REAL_WORKSPACE:-$RH/beings/$(id -un)}
if [[ -d $RW ]]; then
  # The fixture kit, but the lane mounted at the REAL workspace path and the shims at the REAL kit path.
  export BEING_WORKSPACE=$RW
  python3 "$K/team-sync" "$CHAT" --root "$S/team-lanes" >/dev/null 2>&1 || true
  RL() { BEING_KIT_HOME=$K "$K/being-launch" "team:$CHAT" -- bash -c "$1"; }
  expect 1 "real MEMORY.md not visible to a teammate run" RL "test -e $RW/.beings/MEMORY.md"
  expect 1 "real daily logs not visible" RL "test -e $RW/.beings/memory"
  expect 1 "real kit state (token caches, handler.key) not visible" RL "test -e $RK/state"
  expect 1 "real kit .env not visible" RL "test -e $RK/.env"
  expect 1 "real hive tokens not visible" RL "test -e $RH/.config/hive/minds.json || test -e $RH/hive/tokens"
  expect 1 "real ~/.claude (all transcripts) not visible" RL "test -e $RH/.claude/projects"
  expect 1 "real ~/.ssh not visible" RL "test -e $RH/.ssh"
  export BEING_WORKSPACE=$W
fi

echo "$pass passed, $fail failed"
(( fail == 0 ))
