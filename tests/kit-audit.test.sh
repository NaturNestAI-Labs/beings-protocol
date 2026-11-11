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

# 5. Components install over curl and through <being> update (both fetch kit-files.txt): every list matches git.
miss=""
for d in "$REPO"/skills/*/; do c=$(basename "$d"); [[ $c == teams-kit || $c == memory ]] && continue
  want=$(git -C "$REPO" ls-files -s -- "skills/$c/" | awk -v p="skills/$c/" '{f=$4; sub("^" p, "", f); if (f != "kit-files.txt") print ($1 == "100755" ? f " +x" : f)}' | LC_ALL=C sort)
  have=$( { grep -v "^[[:space:]]*\(#\|$\)" "$d/kit-files.txt" 2>/dev/null || true; } | LC_ALL=C sort)
  [[ -n $want && $want == "$have" ]] || miss+=" $c"
done
[[ -z $miss ]] && ok "every component ships a kit-files.txt that matches git" || bad "kit-files.txt missing or stale:$miss"
D="$T/dl"; mkdir -p "$D" "$T/hc"; cp "$REPO/install.sh" "$D/"
CW=teams-kit,owner-access,runner,monitor
out=$(cd "$D" && HOME="$T/hc" BEINGS_BASE_URL="file://$REPO" timeout 180 bash "$D/install.sh" --global --name curlnova --no-memory --with "$CW" --yes 2>&1) && rc=0 || rc=$?
[[ $rc == 0 && -x "$T/hc/beings/curlnova/ops/runner/being-job" && -f "$T/hc/beings/curlnova/ops/teams-kit/owner-access-doctor.mjs" ]] \
  && ok "install over curl with skill components works" || bad "curl install --with $CW: rc $rc $(tail -2 <<<"$out")"
out=$(cd "$T/hc/beings/curlnova" && HOME="$T/hc" BEINGS_BASE_URL="file://$REPO" timeout 180 bash "$D/install.sh" --update --name curlnova --with "$CW" --yes 2>&1) && rc=0 || rc=$?
[[ $rc == 0 ]] && ok "update over curl with skill components works" || bad "curl update: rc $rc $(tail -2 <<<"$out")"
hooks=$(grep -ohE '\$KIT_REPO/[A-Za-z0-9_./-]+' "$REPO"/skills/*/kit-install.sh "$REPO"/scripts/kit-lib.sh | sed 's#^\$KIT_REPO/##' | sort -u)
sup=$(sed -n '/^KIT_HOOK_SUPPORT="/,/"$/p' "$REPO/install.sh"); nope=""
for h in $hooks; do grep -qF "$h" <<<"$sup" || nope+=" $h"; done
[[ -z $nope ]] && ok "everything a component hook reads from the kit is fetched for curl installs" || bad "not in KIT_HOOK_SUPPORT:$nope"

# 6. macOS: install.sh, kit-lib.sh and the launcher run on bash 3.2 and BSD tools.
b4=$(grep -nHE 'declare -A|mapfile|readarray|\$\{[A-Za-z_]+(,,|\^\^)\}|&>>|local -n|declare -n|-printf |sed -i' \
  "$REPO/install.sh" "$REPO/scripts/kit-lib.sh" "$REPO/templates/kit/bin/being" | grep -v '^\S*:[0-9]*:\s*#' || true)
[[ -z $b4 ]] && ok "no bash 4 or GNU-only constructs where macOS runs" || bad "macOS-unsafe: $b4"
if command -v shasum >/dev/null; then
  NB="$T/nosha"; mkdir -p "$NB"; for c in bash cut shasum perl awk mktemp mv cmp mkdir dirname basename cat rm touch; do
    p=$(command -v "$c" || true); [[ -n $p ]] && ln -s "$p" "$NB/$c"; done
  echo x >"$T/f1"; want=$(sha256sum "$T/f1" | cut -d' ' -f1)
  got=$(PATH="$NB" bash -c '. "$1"; kit_sha "$2"' _ "$REPO/scripts/kit-lib.sh" "$T/f1" 2>/dev/null || true)
  [[ $got == "$want" ]] && ok "kit_sha works without sha256sum (macOS)" || bad "kit_sha without sha256sum: '$got'"
fi
KD="$T/kp"; mkdir -p "$KD"; echo old >"$KD/a.txt"
for v in new1 new2; do echo "$v" >"$T/tmpf"; bash -c '. "$1"; kit_place "$2" "$3"' _ "$REPO/scripts/kit-lib.sh" "$T/tmpf" "$KD/a.txt" >/dev/null; done
[[ $(grep -c '^a.txt	' "$KD/.kit-upgrade/CHANGES.txt") == 1 && $(cat "$KD/.kit-upgrade/a.txt") == new2 ]] \
  && ok "a staged file keeps one CHANGES.txt line" || bad "CHANGES.txt: $(cat "$KD/.kit-upgrade/CHANGES.txt")"

echo "kit-audit: $([[ $fails == 0 ]] && echo 'all checks passed' || echo "$fails FAILED")"
exit $(( fails > 0 ))
