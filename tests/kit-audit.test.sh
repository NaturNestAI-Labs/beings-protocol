#!/usr/bin/env bash
# kit-audit.test.sh: regressions for the 11 Nov end-to-end kit audit (units, jobs, loop timeouts, update URLs).
# Offline; systemctl and systemd-run are stubbed. Linux (setsid, flock).
# shellcheck disable=SC2015  # ok/bad reporting chains
set -euo pipefail
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TK="$REPO/skills/teams-kit"; RN="$REPO/skills/runner"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
unset TMUX TMUX_PANE INVOCATION_ID
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }

# Stubs: systemctl logs its calls; "show -p InvocationID" answers $STUB_INV. systemd-run logs and runs the command.
mkdir -p "$T/bin"
cat >"$T/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$STUB_LOG"
case "$*" in
  *"show -p InvocationID"*) echo "${STUB_INV:-}" ;;
  *is-enabled*) exit 0 ;;
  *"show -p MainPID"*) echo 0 ;;
  *" start "*|*" stop "*|*" restart "*) exit 99 ;;
esac
exit 0
STUB
cat >"$T/bin/systemd-run" <<'STUB'
#!/usr/bin/env bash
echo "systemd-run $*" >>"$STUB_LOG"
while [[ $# -gt 0 && $1 == -* ]]; do [[ $1 == --unit ]] && shift; shift; done
exec "$@"
STUB
chmod +x "$T/bin/systemctl" "$T/bin/systemd-run"
export PATH="$T/bin:$PATH" STUB_LOG="$T/systemctl.log" HOME="$T/home"
mkdir -p "$HOME/.config/systemd/user"

# 1. A Teams unit from an older kit (ExecStart=being-teams up) must not start or stop itself from inside its own job.
K="$T/kit"; cp -R "$TK" "$K"; rm -rf "$K/node_modules"; ST="$T/state"; mkdir -p "$ST"
printf 'BEING_NAME=nova\nBEING_STATE_DIR=%s\nOWNER_OID=00000000-0000-0000-0000-00000000a001\n' "$ST" >"$K/.env"
sleep 60 & live=$!; echo "$live" >"$ST/loop.pid"
: >"$STUB_LOG"; out=$(INVOCATION_ID=inv-1 STUB_INV=inv-1 timeout 20 "$K/being-teams" up 2>&1) || true
! grep -qE -- '--user (start|restart) ' "$STUB_LOG" && grep -q 'already up' <<<"$out" \
  && ok "up inside its own older unit does not wait on itself" || bad "up inside own unit: $out / $(cat "$STUB_LOG")"
: >"$STUB_LOG"; INVOCATION_ID=other STUB_INV=inv-1 timeout 20 "$K/being-teams" up >/dev/null 2>&1 || true
grep -q -- '--user start nova-teams.service' "$STUB_LOG" && ok "up from a shell still goes through systemd" || bad "up from shell: $(cat "$STUB_LOG")"
: >"$STUB_LOG"; INVOCATION_ID=inv-1 STUB_INV=inv-1 timeout 20 "$K/being-teams" down >/dev/null 2>&1 || true
! grep -q -- '--user stop ' "$STUB_LOG" && ! kill -0 "$live" 2>/dev/null && ok "down inside its own older unit stops the loop itself" \
  || bad "down inside own unit: $(cat "$STUB_LOG")"
kill "$live" 2>/dev/null || true
printf '[Service]\nType=forking\nExecStart=%s/being-teams up\n' "$K" >"$HOME/.config/systemd/user/nova-teams.service"
rc=0; out=$("$K/being-teams" doctor 2>&1) || rc=$?
[[ $rc != 0 ]] && grep -q 'FAIL nova-teams.service is from an older kit' <<<"$out" && ok "doctor fails an older Teams unit" || bad "doctor old unit: rc $rc $out"
printf '[Service]\nType=simple\nExecStart=%s/being-teams __run\n' "$K" >"$HOME/.config/systemd/user/nova-teams.service"
out=$("$K/being-teams" doctor 2>&1) || true
! grep -q 'older kit' <<<"$out" && ok "doctor passes a current Teams unit" || bad "doctor current unit: $out"

# 2. Runner being-job: an argument with newlines stays whole; a job started from a unit gets its own scope.
W="$T/ws"; RS="$T/rstate"; mkdir -p "$W"
printf 'BEING_STATE_DIR=%s\nBEING_WORKSPACE=%s\n' "$RS" "$W" >"$T/runner.env"
rjob() { BEING_RUNNER_ENV="$T/runner.env" "$RN/being-job" "$@"; }
wait_job() { local i; for (( i = 0; i < 100; i++ )); do grep -q "\"$1\"" "$RS/work.jsonl" 2>/dev/null && return 0; sleep 0.1; done; return 1; }
id=$(rjob run ml -- bash -c "echo one >$T/lines
echo two >>$T/lines")
wait_job "$id" && [[ "$(cat "$T/lines" 2>/dev/null)" == $'one\ntwo' ]] && ok "runner run job keeps a multi-line argument whole" \
  || bad "runner multi-line payload: $(cat "$T/lines" 2>/dev/null)"
: >"$STUB_LOG"; id=$(INVOCATION_ID=inv-2 rjob run inunit -- true)
wait_job "$id" && grep -q 'systemd-run --user --scope' "$STUB_LOG" && ok "runner job started in a unit runs in its own scope" \
  || bad "runner own scope: $(cat "$STUB_LOG")"
: >"$STUB_LOG"; id=$(rjob run shell -- true)
wait_job "$id" && ! grep -q 'systemd-run --user --scope --quiet --collect --unit' "$STUB_LOG" && ok "runner job from a shell gets no scope" \
  || bad "runner scope outside a unit: $(cat "$STUB_LOG")"
grep -qF '"<why, plain words>" "<what you need>" "<exact error, logged only>"' "$RN/being-job" \
  && grep -qF '"<why, plain words>" "<what you need>" "<exact error, logged only>"' "$TK/being-job" \
  && grep -qF '"<why, plain words>" "<what you need>" "<exact error, logged only>"' "$TK/being-handle" \
  && ok "job and handler rules keep the exact error out of the owner's blocker text" || bad "blocker argument order in job rules"

# 3. Every Graph or side step of the watcher loop is bounded, so one hung call cannot stall message detection.
body=$(sed -n '/^loop() {/,/^}/p' "$TK/being-teams")
unb=$(grep -nE '(node (teams-detect|teams-presence|mail|scope)\.mjs|python3 "\$KIT/being-(retry|watchdog)")' <<<"$body" | grep -v 'timeout "\$STEP_MAX"' || true)
[[ -z $unb && -n $body ]] && ok "watcher loop steps run under a timeout" || bad "unbounded loop steps: $unb"
grep -q 'AbortSignal.timeout(GRAPH_TIMEOUT_MS)' "$TK/graph.mjs" && ok "Graph reads time out" || bad "Graph reads have no timeout"

# 4. The Teams unit survives one of its runs being killed for memory.
H2="$T/h2"; mkdir -p "$H2"
HOME="$H2" INVOCATION_ID= timeout 20 "$K/being-teams" autostart on >/dev/null 2>&1 || true
grep -q '^OOMPolicy=continue' "$H2/.config/systemd/user/nova-teams.service" 2>/dev/null \
  && grep -q '^OOMPolicy=continue' "$TK/systemd/being-teams.service.example" && ok "Teams unit keeps running after an OOM kill" \
  || bad "Teams unit OOMPolicy: $(grep -c OOMPolicy "$H2/.config/systemd/user/nova-teams.service" 2>&1)"

echo "kit-audit: $([[ $fails == 0 ]] && echo 'all checks passed' || echo "$fails FAILED")"
exit $(( fails > 0 ))
