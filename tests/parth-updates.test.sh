#!/usr/bin/env bash
# Offline regressions for additive component installs and verification send opt-in.
set -euo pipefail
unset TMUX TMUX_PANE INVOCATION_ID
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export HOME="$T/home" XDG_CONFIG_HOME="$T/config"
mkdir -p "$HOME" "$T/being/.beings" "$T/being/ops/teams-kit"
K="$T/being/ops/teams-kit"
touch "$K/graph.mjs" "$K/scope.mjs"
for mode in legacy tracked; do
  for f in mailbox-lib.mjs shared-mailbox-drafts.mjs; do
    printf 'local guard %s\n' "$mode" >"$K/$f"
  done
  bash "$REPO/skills/owner-access/kit-install.sh" "$T/being" >"$T/install.log"
  for f in mailbox-lib.mjs shared-mailbox-drafts.mjs; do
    grep -qx "local guard $mode" "$K/$f"
    cmp "$REPO/skills/owner-access/$f" "$K/.kit-upgrade/$f"
    grep -q "$f" "$K/.kit-upgrade/CHANGES.txt"
  done
  grep -q 'LOCAL CHANGES' "$K/.kit-upgrade/CHANGES.txt"
  grep -q 'merge by hand' "$T/install.log"
  [[ $(stat -c %a "$K/owner-access.toml.example") == 600 ]]
  # Establish a baseline for the next iteration, then edit it again.
  for f in mailbox-lib.mjs shared-mailbox-drafts.mjs; do cp "$REPO/skills/owner-access/$f" "$K/$f"; done
  bash "$REPO/skills/owner-access/kit-install.sh" "$T/being" >"$T/install.log"
done
bash "$REPO/skills/monitor/kit-install.sh" "$T/being" >"$T/monitor.log"
[[ -x "$T/being/ops/monitor/monitor.py" ]]
printf 'local monitor\n' >"$T/being/ops/monitor/monitor.py"
bash "$REPO/skills/monitor/kit-install.sh" "$T/being" >"$T/monitor.log"
grep -qx 'local monitor' "$T/being/ops/monitor/monitor.py"
cmp "$REPO/skills/monitor/monitor.py" "$T/being/ops/monitor/.kit-upgrade/monitor.py"
echo '  ok component installs preserve legacy and tracked edits, stage upstream, report changes'

# Execute the actual option parser without session files, API calls or service probes.
sed '/^OKS=0/,$d' "$REPO/skills/teams-kit/verify.sh" >"$T/options.sh"
# shellcheck disable=SC2016
printf '\nprintf "send=%%s wait=%%s\\n" "$SEND" "$WAIT_MIN"\n' >>"$T/options.sh"
[[ $(bash "$T/options.sh") == 'send=0 wait=0' ]]
[[ $(bash "$T/options.sh" --no-send) == 'send=0 wait=0' ]]
[[ $(bash "$T/options.sh" --send) == 'send=1 wait=0' ]]
[[ $(bash "$T/options.sh" --send --wait-reply 1) == 'send=1 wait=1' ]]
[[ $(bash "$T/options.sh" --send --no-send) == 'send=0 wait=0' ]]
for arg in 1 invalid; do
  rc=0; bash "$T/options.sh" --wait-reply "$arg" >"$T/options.log" 2>&1 || rc=$?
  [[ $rc == 2 ]]
done
grep -q 'verify.sh --no-send' "$REPO/skills/runner/being-update"
echo '  ok verification is send-opt-in; update retains --no-send; waiting cannot enable sending'
