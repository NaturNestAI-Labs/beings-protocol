#!/usr/bin/env bash
# teams-kit-guards.test.sh: owner-identity, mint and handler guards of skills/teams-kit, offline (no Graph calls succeed).
# Needs node and skills/teams-kit/node_modules (npm install); model clients are stubbed. Linux (flock, setsid).
# shellcheck disable=SC2015  # ok/bad reporting chains
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
unset TMUX TMUX_PANE INVOCATION_ID   # a live tmux server or systemd unit must not reach the test
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SRC="$REPO/skills/teams-kit"
[[ -d "$SRC/node_modules/@azure/msal-node" ]] || { echo "teams-kit-guards: run npm install in skills/teams-kit first"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }

KIT="$TMP/home/nova/ops/teams-kit"; ST="$KIT/state"; mkdir -p "$KIT" "$ST" "$TMP/bin" "$TMP/home/nova/.beings"
cp -R "$SRC/." "$KIT/"; rm -rf "$KIT/node_modules"; ln -s "$SRC/node_modules" "$KIT/node_modules"
OWNER_CACHE_F="$TMP/owner-cache.json"; echo '{}' >"$OWNER_CACHE_F"; echo '{}' >"$ST/token-cache.json"; chmod 600 "$OWNER_CACHE_F" "$ST/token-cache.json"
cat >"$KIT/.env" <<ENV
BEING_NAME=nova
BEING_UPN=nova@example.test
BEING_STATE_DIR='$ST'
BEING_CACHE='$ST/token-cache.json'
OWNER_NAME='Sam O'\''Brien'
OWNER_UPN=sam@example.test
OWNER_OID=00000000-0000-0000-0000-00000000a001
BEING_OWNER_DELEGATE=0
OWNER_CACHE='$OWNER_CACHE_F'
M365_CLIENT_ID=00000000-0000-0000-0000-0000000000c1
M365_TENANT_ID=00000000-0000-0000-0000-0000000000t1
BEING_FAST_CLIENT=claude
ENV
chmod 600 "$KIT/.env"
# Stub model clients: record cwd, args and the scope of the grant they were handed.
for c in claude codex; do
  cat >"$TMP/bin/$c" <<STUB
#!/usr/bin/env bash
# Lanes run in parallel: one call's record is written under a lock so records never interleave.
exec 8>>"$TMP/$c.calls.lock"; flock 8
{ echo "== $c pwd=\$PWD scope=\$(BEING_SEND_TOKEN="\${BEING_SEND_TOKEN:-}" node "$KIT/scope.mjs" show 2>/dev/null)"; for a in "\$@"; do printf '[%s]\n' "\$a"; done; } >>"$TMP/$c.calls"
for ((i=1; i<=\$#; i++)); do [[ "\${!i}" == -o ]] && { j=\$((i+1)); echo '{"actions":[],"summary":"ready"}' >"\${!j}"; }; done
echo '{"actions":[],"summary":"ready"}'
STUB
  chmod +x "$TMP/bin/$c"
done
export HOME="$TMP/home" PATH="$TMP/bin:$PATH"
# shellcheck source=/dev/null
envrun() { (set -a; . "$KIT/.env"; set +a; cd "$KIT"; "$@"); }
OWNER_UPN=sam@example.test
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

# 1. Review reproduction: a run points the sender at the owner's cache and UPN and posts "send D7".
expect_blocked() {   # $1 label, rest: command (stdin from $IN)
  local label=$1; shift; local out rc
  set +e; out=$(printf '%s' "${IN:-send D7}" | envrun "$@" 2>&1); rc=$?; set -e
  [[ $rc == 3 && "$out" == *"sender resolves to the owner"* ]] && ok "$label: refused (exit 3)" || bad "$label: exit $rc: ${out:0:160}"
}
expect_blocked "send-dm as owner (exact repro)" env BEING_CACHE="$OWNER_CACHE_F" BEING_UPN="$OWNER_UPN" node teams-send-dm.mjs --chat 19:owner-dm@unq.gbl.spaces
expect_blocked "send-dm, owner UPN in caps" env BEING_CACHE="$OWNER_CACHE_F" BEING_UPN=SAM@Example.test node teams-send-dm.mjs --chat 19:x
cp "$OWNER_CACHE_F" "$TMP/copied.json"; ln -s "$OWNER_CACHE_F" "$TMP/link.json"
expect_blocked "send-dm, copied owner cache + owner UPN" env BEING_CACHE="$TMP/copied.json" BEING_UPN="$OWNER_UPN" node teams-send-dm.mjs --chat 19:x
expect_blocked "send-dm, symlinked owner cache" env BEING_CACHE="$TMP/link.json" BEING_UPN=nova@example.test node teams-send-dm.mjs --chat 19:x
expect_blocked "send-dm, process OWNER_* overridden" env OWNER_UPN=nobody@example.test OWNER_CACHE=/nonexistent BEING_CACHE="$OWNER_CACHE_F" BEING_UPN="$OWNER_UPN" node teams-send-dm.mjs --chat 19:x
expect_blocked "voice pass sender (--verbatim)" env BEING_CACHE="$OWNER_CACHE_F" BEING_UPN="$OWNER_UPN" node teams-send-dm.mjs --chat 19:x --verbatim --no-quote
expect_blocked "mail --send as owner" env BEING_CACHE="$OWNER_CACHE_F" BEING_UPN="$OWNER_UPN" node mail.mjs --send --to "$OWNER_UPN" --subject s
IN='{"messages":[{"chatId":"19:x","messageId":"1","chatType":"oneOnOne"}],"actions":[]}' \
  expect_blocked "teams-ack as owner" env BEING_CACHE="$OWNER_CACHE_F" BEING_UPN="$OWNER_UPN" node teams-ack.mjs
expect_blocked "draft-for-owner prompt as owner" env BEING_CACHE="$OWNER_CACHE_F" BEING_UPN="$OWNER_UPN" node draft-for-owner.mjs --chat 19:x
[[ ! -d "$ST/drafts" ]] && ok "blocked draft stored nothing" || bad "blocked draft left files"
set +e; out=$(printf 'Send D8' | envrun node draft-for-owner.mjs --chat 19:x 2>&1); rc=$?; set -e
[[ $rc == 3 && "$out" == *"cannot be an approval command"* && ! -d "$ST/drafts" ]] && ok "a draft whose text is \"send Dn\" is refused" || bad "command draft: exit $rc: ${out:0:160}"
set +e; out=$(echo hi | envrun node teams-send-dm.mjs --chat 19:x 2>&1); rc=$?; set -e
[[ $rc == 1 && "$out" == *"not in token cache"* ]] && ok "the Being's own identity passes the guard" || bad "Being identity: exit $rc: ${out:0:160}"

# 2. Owner sign-in is off by default.
set +e; out=$(envrun node teams-login-device.mjs --upn "$OWNER_UPN" --cache "$TMP/new-owner.json" 2>&1); rc=$?; set -e
[[ $rc == 2 && "$out" == *"owner sign-in is off"* ]] && ok "owner device sign-in refused while BEING_OWNER_DELEGATE=0" || bad "owner sign-in: exit $rc: ${out:0:160}"
tok=$(envrun node scope.mjs mint owner-only 1)
set +e; out=$(BEING_SEND_TOKEN="$tok" "$KIT/owner-read" --list 2>&1); rc=$?; set -e
[[ $rc == 1 && "$out" == *"BEING_OWNER_DELEGATE"* ]] && ok "owner-read refused while delegate is off" || bad "owner-read: exit $rc: ${out:0:160}"
mkdir -p "$ST/drafts"; printf '{"id":"D1","kind":"teams","status":"pending","created":"%s"}' "$(date -u +%FT%TZ)" >"$ST/drafts/D1.json"
set +e; envrun node approve.mjs send D1 --chat 19:x --msg m1 >/dev/null 2>&1; rc=$?; set -e
grep -q '"pending"' "$ST/drafts/D1.json" && [[ $rc == 1 ]] && ok "approve refuses without the opt-in" || bad "approve: exit $rc"

# 3. doctor fails on a same-user host, loudly when an owner token is readable.
set +e; out=$("$KIT/being-teams" doctor 2>&1); rc=$?; set -e
[[ $rc == 1 && "$out" == *"FAIL owner sign-in on a same-user host"* && "$out" == *"FAIL minting"* ]] && ok "doctor fails: same user, owner cache readable" || bad "doctor: exit $rc: $out"
mv "$OWNER_CACHE_F" "$TMP/away.json"
set +e; out=$("$KIT/being-teams" doctor 2>&1); rc=$?; set -e
[[ $rc == 1 && "$out" != *"owner sign-in on a same-user"* && "$out" == *"FAIL isolation"* ]] && ok "doctor still fails same-user without owner cache" || bad "doctor (no owner cache): exit $rc"
mv "$TMP/away.json" "$OWNER_CACHE_F"

# 4. Minting needs the handler key; a forged grant or a foreign state dir is owner-only.
if [[ $(id -u) != 0 ]]; then
  chmod 000 "$ST/handler.key"
  set +e; out=$(envrun node scope.mjs mint full 1 2>/dev/null); rc=$?; set -e
  [[ $rc == 2 && -z "$out" ]] && ok "mint full without the handler key: refused" || bad "mint without key: exit $rc"
  chmod 600 "$ST/handler.key"
fi
mkdir -p "$TMP/evil"; evil=$(BEING_STATE_DIR="$TMP/evil" node --input-type=module -e "import { mintGrant } from '$KIT/scope.mjs'; console.log(mintGrant('full', { state: '$TMP/evil' }))")
[[ $(BEING_STATE_DIR="$TMP/evil" BEING_SEND_TOKEN="$evil" node "$KIT/scope.mjs" show 2>/dev/null) == none ]] && ok "grant minted in a foreign state dir is refused" || bad "foreign state dir honoured"
th=$(printf '%s' forged | sha256sum | cut -c1-64); printf '{"scope":"full","expires":%s}' "$(( $(date +%s) * 1000 + 3600000 ))" >"$ST/grants/$th.json"
[[ $(BEING_SEND_TOKEN=forged node "$KIT/scope.mjs" show 2>/dev/null) == none ]] && ok "unsigned grant file is refused" || bad "unsigned grant honoured"

# 5. Teammate work: one run per chat, each scoped to that chat only.
rm -f "$TMP/claude.calls"
for m in "19:chatA|a1|kim" "19:chatB|b1|lee" "19:chatA|a2|kim"; do IFS='|' read -r c id who <<<"$m"
  printf '{"chatId":"%s","messageId":"%s","fromId":"%s","chatType":"oneOnOne","text":"hi from %s"}\n' "$c" "$id" "$who" "$who" >>"$ST/work.jsonl"; done
"$KIT/being-handle" work; wait_lanes
runs=$(grep -c '^== claude' "$TMP/claude.calls" || true)
scopes=$(grep '^== claude' "$TMP/claude.calls" | sed 's/.*scope=//' | sort | tr '\n' ' ')
[[ $runs == 2 && "$scopes" == "chats:19:chatA chats:19:chatB " ]] && ok "one work run per teammate chat, scope = that chat" || bad "team runs=$runs scopes=[$scopes]"
python3 - "$TMP/claude.calls" <<'PY' && ok "no run sees another chat's messages" || bad "a run saw another chat's messages"
import sys
runs=open(sys.argv[1]).read().split("== claude")[1:]
for r in runs:
    a,b="chatA" in r.split("lane=team")[1], "chatB" in r.split("lane=team")[1]
    if a and b: sys.exit(1)
PY

# 6. Fast client (triage/voice) gets no file tools and runs outside the workspace. A Claude fast client is warmed through the
# fast-warm daemon (being-teams keeps it running), so start it here as being-teams does.
rm -f "$TMP/claude.calls"
envrun node fast-warm.mjs serve </dev/null >/dev/null 2>&1 & wpid=$!
for _ in $(seq 1 50); do [[ -S "$ST/fast-warm.sock" ]] && break; sleep 0.1; done
"$KIT/being-handle" warm
for _ in $(seq 1 50); do grep -q '^\[--tools\]$' "$TMP/claude.calls" 2>/dev/null && break; sleep 0.2; done
[[ -s "$ST/fast-warm.pid" ]] && kill "$(cat "$ST/fast-warm.pid")" 2>/dev/null; wait "$wpid" 2>/dev/null || true
grep -q '^\[--tools\]$' "$TMP/claude.calls" && grep -A1 '^\[--tools\]$' "$TMP/claude.calls" | grep -q '^\[\]$' && ! grep -q 'allowedTools' "$TMP/claude.calls" \
  && grep -q "pwd=$ST/fast-cwd" "$TMP/claude.calls" && ok "claude fast client: --tools \"\", empty cwd" || bad "claude fast client: $(head -c 300 "$TMP/claude.calls")"
rm -rf "$ST/fast-daily"; sed -i.bak 's/^BEING_FAST_CLIENT=claude/BEING_FAST_CLIENT=codex/' "$KIT/.env"; rm -f "$KIT/.env.bak"
"$KIT/being-handle" warm
grep -q "pwd=$ST/fast-cwd" "$TMP/codex.calls" && grep -q "^\[$ST/fast-cwd\]$" "$TMP/codex.calls" && ok "codex fast client: runs in an empty dir" || bad "codex fast cwd"

# 7. Codex jobs: network off unless --network.
job() { rm -f "$TMP/codex.calls"; envrun ./being-job codex "$@" >/dev/null
  for _ in $(seq 1 50); do grep -q 'network_access' "$TMP/codex.calls" 2>/dev/null && break; sleep 0.2; done; }
job t1 --notify 19:x "task"; grep -q '^\[sandbox_workspace_write.network_access=false\]$' "$TMP/codex.calls" && ok "codex job: network off by default" || bad "codex job default network"
set +e; envrun ./being-job codex t2 --network --notify 19:x "task" >/dev/null 2>&1; rc=$?; set -e
[[ $rc == 3 ]] && ok "codex job: --network refused without the full scope" || bad "--network without full scope: exit $rc"
full=$(envrun node scope.mjs mint full 1)
BEING_SEND_TOKEN="$full" job t3 --network --notify 19:x "task"
grep -q '^\[sandbox_workspace_write.network_access=true\]$' "$TMP/codex.calls" && ok "codex job: --network opts in (full scope)" || bad "codex job --network"
set +e; envrun ./being-job agent t4 --network --notify 19:x "task" >/dev/null 2>&1; rc=$?; set -e
[[ $rc == 2 ]] && ok "--network refused for non-codex jobs" || bad "--network on agent job: exit $rc"
sleep 1

(( fails == 0 )) && echo "teams-kit-guards: all checks passed" || { echo "teams-kit-guards: $fails failed"; exit 1; }
