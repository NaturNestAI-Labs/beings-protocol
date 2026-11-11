#!/usr/bin/env bash
# verify.sh [--live]: post-setup checks of the users layout via `sudo -n -u <model user> test ...`; exit 1 on any FAIL.
# --live also makes one tiny model call per model user through being-launch.
set -uo pipefail
KIT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
set -a; . "$KIT/.env"; set +a
B=${BEING_NAME,,}; AI=${BEING_MODEL_USER:-$B-ai}; TM=${BEING_TEAM_USER:-$B-team}
STATE=$BEING_STATE_DIR; WS=$(readlink -f "${BEING_WORKSPACE:-$KIT/../..}")
pass=0; fail=0
ok() { echo "  ok   $*"; pass=$((pass+1)); }
bad() { echo "  FAIL $*"; fail=$((fail+1)); }
can()    { local u=$1 op=$2 p=$3 what=$4; if sudo -n -u "$u" test "$op" "$p" 2>/dev/null; then ok "$what"; else bad "$what"; fi; }
cannot() { local u=$1 op=$2 p=$3 what=$4; if sudo -n -u "$u" test "$op" "$p" 2>/dev/null; then bad "$what"; else ok "$what"; fi; }

echo "users and sudo"
id "$AI" >/dev/null 2>&1 && ok "$AI exists" || bad "$AI missing"
id "$TM" >/dev/null 2>&1 && ok "$TM exists" || bad "$TM missing"
sudo -n -u "$AI" true 2>/dev/null && ok "kit user can start $AI" || bad "kit user cannot start $AI (sudoers)"
sudo -n -u "$TM" true 2>/dev/null && ok "kit user can start $TM" || bad "kit user cannot start $TM (sudoers)"
if sudo -n -u "$AI" sudo -n true 2>/dev/null; then bad "$AI has sudo rights"; else ok "$AI has no sudo rights"; fi
if sudo -n -u "$TM" sudo -n true 2>/dev/null; then bad "$TM has sudo rights"; else ok "$TM has no sudo rights"; fi
if sudo -n -u "$AI" sudo -n -u "$B" true 2>/dev/null; then bad "$AI can become the kit user"; else ok "$AI cannot become the kit user"; fi

echo "kit secrets: unreadable to both model users"
secrets=("$KIT/.env" "$STATE/handler.key" "$STATE/grants" "$STATE/job-scopes" "$STATE/comms.jsonl" "$STATE/conversations"
         "${BEING_CACHE:-$STATE/token-cache.json}" "${OWNER_CACHE:-$STATE/owner-cache.json}" "$HOME/.config/hive/minds.json"
         "$HOME/hive/tokens" "$HOME/.ssh" "$HOME/.claude/.credentials.json" "$HOME/.claude/projects" "$WS/.secrets/app-credentials.md")
for f in "$WS"/.beings/daemon/.token-cache-*.json "$KIT"/.env.bak*; do [[ -e $f ]] && secrets+=("$f"); done
for u in "$AI" "$TM"; do for p in "${secrets[@]}"; do
  [[ -e $p || -L $p ]] || continue
  cannot "$u" -r "$p" "$u cannot read $p"
done; done
cannot "$AI" -w "$KIT/being-handle" "$AI cannot change kit code"
cannot "$AI" -w "$KIT" "$AI cannot add files to the kit"

echo "workspace: the owner model reads and writes it, the team user cannot see it"
can "$AI" -r "$WS/.beings/MEMORY.md" "$AI reads MEMORY.md"
can "$AI" -w "$WS/.beings/memory" "$AI writes the daily logs"
can "$AI" -w "$WS/.git" "$AI can commit (writes .git)"
cannot "$TM" -r "$WS/.beings/MEMORY.md" "$TM cannot read MEMORY.md"
cannot "$TM" -x "$HOME" "$TM cannot enter the kit user's home"
cannot "$AI" -r "$HOME/beings-protocol" "$AI cannot list the kit repo"
test -w "$WS/.beings/memory" && ok "kit user still writes the workspace" || bad "kit user lost write access to the workspace"

echo "teammate lanes and the broker"
can "$TM" -r "${BEING_TEAM_ROOT:-/srv/$B-team}" "$TM reads the lane root"
cannot "$AI" -w "${BEING_SHIM_DIR:-/srv/$B/kit-bin}" "$AI cannot change the shims"
cannot "$AI" -w "${BEING_CLAUDE_BIN:-/srv/$B/claude/bin/claude}" "$AI cannot change the model client"
cannot "$TM" -w "${BEING_CLAUDE_BIN:-/srv/$B/claude/bin/claude}" "$TM cannot change the model client"
cannot "$TM" -r "/etc/$B/claude-$AI.env" "$TM cannot read $AI's model credential"
cannot "$AI" -r "/etc/$B/claude-$TM.env" "$AI cannot read $TM's model credential"

echo "end to end through being-launch (sandbox as the model users)"
chat="19:verify-isolation@thread.v2"
python3 "$KIT/team-sync" "$chat" >/dev/null 2>&1 || bad "team-sync failed for a test lane"
sb() { local want=$1 what=$2 lane=$3 cmd=$4 out rc
  out=$(BEING_ISOLATION=users "$KIT/being-launch" "$lane" -- bash -c "echo __IN__; ( $cmd ) >/dev/null 2>&1; echo __RC=\$?" 2>&1)
  rc=$(sed -n 's/^__RC=//p' <<<"$out")
  if ! grep -q __IN__ <<<"$out"; then bad "$what (sandbox did not start: $(tail -1 <<<"$out"))"; return; fi
  if [[ $want == 0 && $rc == 0 ]] || [[ $want != 0 && $rc != 0 ]]; then ok "$what"; else bad "$what (rc=$rc)"; fi; }
sb 0 "teammate run is $TM" "team:$chat" "test \$(id -u) = $(id -u "$TM")"
sb 1 "teammate run: no MEMORY.md" "team:$chat" "test -e $WS/.beings/MEMORY.md"
sb 1 "teammate run: no kit state" "team:$chat" "test -e $STATE"
sb 0 "teammate run: broker answers (ping)" "team:$chat" "KIT_CLIENT_VERB=ping node $KIT/being-status | grep -q 'pong team'"
sb 1 "teammate run: owner-read refused" "team:$chat" "$KIT/owner-read --list"
sb 0 "owner run is $AI" owner "test \$(id -u) = $(id -u "$AI")"
sb 0 "owner run: reads MEMORY.md" owner "test -r $WS/.beings/MEMORY.md"
sb 1 "owner run: no kit .env" owner "test -e $KIT/.env"
sb 1 "owner run: no token cache" owner "test -e ${BEING_CACHE:-$STATE/token-cache.json}"
sb 0 "owner run: broker answers (ping)" owner "KIT_CLIENT_VERB=ping node $KIT/being-status | grep -q 'pong ai'"
if [[ ${1:-} == --live ]]; then
  sb 0 "owner run: claude answers (live call)" owner "claude -p --model haiku 'Reply with exactly: ok' </dev/null | grep -q ok"
  sb 0 "teammate run: claude answers (live call)" "team:$chat" "claude -p --model haiku 'Reply with exactly: ok' </dev/null | grep -q ok"
fi

echo "doctor"
if "$KIT/being-teams" doctor >/dev/null 2>&1; then ok "being-teams doctor passes"; else bad "being-teams doctor fails ($KIT/being-teams doctor)"; fi
echo "$pass passed, $fail failed"
(( fail == 0 ))
