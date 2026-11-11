#!/usr/bin/env bash
# live-check.sh: one real teammate run behind bwrap against a SYNTHETIC chat, broker in dry run (BEING_BROKER_DRY=1).
# Sandbox probes, a model call and a reply through the broker; exit 0 = all held (isolation/README.md).
set -uo pipefail
KIT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
set -a; . "$KIT/.env"; set +a
SELFTEST_NAME="$(printf %s "${BEING_NAME:-being}" | tr 'A-Z ' 'a-z-')-sandbox-selftest"
export BEING_ISOLATION=bwrap BEING_ISOLATION_LANES=team BEING_BROKER_DRY=1
unset BEING_SEND_TOKEN BEING_LANE
WS=$(readlink -f "${BEING_WORKSPACE:-$KIT/../..}")
CHAT="19:sandbox-selftest-$(date +%m%d%H%M%S)@thread.v2"
TAG=$(printf '%s' "$CHAT" | sha1sum | cut -c1-10)
fail=0
trap 'rm -rf "${BEING_TEAM_ROOT:-$BEING_STATE_DIR/team-lanes}/$TAG"' EXIT
[[ -d $KIT/isolation/shims ]] || "$KIT/isolation/make-shims" >/dev/null
python3 "$KIT/team-sync" "$CHAT" >/dev/null || { echo "team-sync failed"; exit 1; }

echo "== 1. probes inside the teammate sandbox ($CHAT)"
probe() {   # $1 label, $2 command; prints the exit code and stderr; a 0 exit is a FAIL (the probe must be denied)
  local out rc
  out=$("$KIT/being-launch" "team:$CHAT" -- bash -c "echo __IN__ >&2; $2" 2>&1 >/dev/null </dev/null); rc=$?
  grep -q __IN__ <<<"$out" || { echo "FAIL $1: sandbox did not start: $out"; fail=1; return; }
  out=$(grep -v __IN__ <<<"$out" | head -3 | tr '\n' ' ')
  if [[ $rc == 0 ]]; then echo "FAIL $1: allowed (rc=0)"; fail=1; else echo "denied  $1  rc=$rc  ${out}"; fi
}
nnp=$("$KIT/being-launch" "team:$CHAT" -- bash -c 'grep NoNewPrivs /proc/self/status' 2>/dev/null </dev/null)
[[ $nnp =~ NoNewPrivs:[[:space:]]*1 ]] && echo "ok      $nnp" || { echo "FAIL no_new_privs: '$nnp'"; fail=1; }
probe "sudo -n true"         "sudo -n true"
probe "su (timeout 5)"       "timeout 5 su -c true root"
probe "read ~/.ssh"          "ls $HOME/.ssh"
probe "read the bond"        "cat $WS/.beings/bond/bond_us.md"
probe "read MEMORY.md"       "cat $WS/.beings/MEMORY.md"
probe "read the kit .env"    "cat $KIT/.env"
probe "read kit state"       "ls $BEING_STATE_DIR"
probe "read state/grants"    "ls $BEING_STATE_DIR/grants"
probe "read token cache"     "cat ${BEING_CACHE:-$BEING_STATE_DIR/token-cache.json}"
probe "read ~/.claude login" "cat $HOME/.claude/.credentials.json"
probe "read .secrets"        "ls $WS/.secrets"
probe "read the hive spool"  "ls $HOME/hive $HOME/.config/hive"

echo "== 2+3. a model run inside the sandbox replies through the broker (dry run)"
KREL=$(python3 -c 'import os,sys; print(os.path.relpath(sys.argv[1], sys.argv[2]))' "$KIT" "$WS")
before=$(wc -l <"$BEING_STATE_DIR/broker.log" 2>/dev/null || echo 0)
out=$(cd "$WS" && env CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 BEING_LANE="team:$CHAT" BEING_SESSION_NAME=$SELFTEST_NAME \
  "$KIT/being-launch" "team:$CHAT" --cwd "$WS" --expose "$BEING_STATE_DIR/soul-public.md" -- \
  claude -p -n $SELFTEST_NAME --no-session-persistence --model "${LIVE_CHECK_MODEL:-sonnet}" \
  --settings "$(python3 "$KIT/team-fence.py" --settings)" --permission-mode dontAsk \
  --allowedTools "Read,Bash(node $KREL/teams-send-dm.mjs:*)" --disallowedTools SendMessage \
  --append-system-prompt-file "$BEING_STATE_DIR/soul-public.md" \
  "This is an automated sandbox self-test, not a person. Run exactly this one command with the Bash tool, then reply DONE: echo 'sandbox self-test reply OK' | node $KREL/teams-send-dm.mjs --chat '$CHAT'" \
  </dev/null 2>&1); rc=$?
echo "model run rc=$rc; last output: $(tail -2 <<<"$out" | tr '\n' ' ' | cut -c1-200)"
[[ $rc == 0 ]] || { echo "FAIL model run"; fail=1; }
dry=$(tail -n +"$((before+1))" "$BEING_STATE_DIR/broker.log" | grep "DRY would run" | grep -F "$CHAT" | tail -1)
if [[ -n $dry && $dry == *"self-test reply OK"* ]]; then echo "ok      broker (team class, dry): ${dry:0:300}"
else echo "FAIL no dry-run send in broker.log for $CHAT"; fail=1; fi

(( fail == 0 )) && echo "LIVE CHECK PASSED" || echo "LIVE CHECK FAILED"
exit $fail
