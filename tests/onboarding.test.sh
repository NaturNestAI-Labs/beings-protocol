#!/usr/bin/env bash
# onboarding.test.sh: config reader, runner, units, webhook/desktop installs and routing, session reaper, harden-box
# and repair dry runs, verify/offboard. Offline, temp HOME, stubbed system tools.

# shellcheck disable=SC2015,SC2016  # ok/bad reporting chains; literal $ in stubs is intended
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TMP=$(mktemp -d); PIDS=()
# Inside tmux, bare tmux targets $TMUX and ignores TMUX_TMPDIR; drop it so tests never touch a live server.
unset TMUX TMUX_PANE
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null || true; done; TMUX_TMPDIR="$TMP" tmux kill-server 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
CFG="$REPO/scripts/being-config"
export HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/home/.config" XDG_STATE_HOME="$TMP/home/.local/state" TMUX_TMPDIR="$TMP"
mkdir -p "$HOME" "$TMP/bin"; export PATH="$TMP/bin:$PATH"
printf '#!/bin/sh\necho Linger=yes\n' >"$TMP/bin/loginctl"; chmod +x "$TMP/bin/loginctl"
tree() { (cd "$1" && find . -type f -printf '%p %s %m\n' | LC_ALL=C sort); }
waitfor() { for _ in $(seq 100); do eval "$1" && return 0; sleep 0.1; done; return 1; }
listen() { python3 -c 'import socket,sys,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(5); time.sleep(600)' "$1" & PIDS+=($!); }
freeport() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }

echo "[being.toml]"
"$CFG" --file "$REPO/templates/being.toml.example" check >/dev/null && ok "example config is valid" || bad "example config invalid"
[[ "$("$CFG" --file "$REPO/templates/being.toml.example" access | awk '$2=="on"{print $1}' | tr '\n' ' ')" == "owner_chat claude memory " ]] \
  && ok "setup menu: only owner_chat, claude, memory on" || bad "access defaults"
mk() { cp "$REPO/templates/being.toml.example" "$TMP/c.toml"; python3 - "$TMP/c.toml" "$@" <<'PY'
import re,sys
p=sys.argv[1]; s=open(p).read()
for kv in sys.argv[2:]:
    k,v=kv.split("=",1); s=re.sub(r"(?m)^%s = .*$" % re.escape(k), f"{k} = {v}", s, count=1)
open(p,"w").write(s)
PY
}
mk 'owner_mail_read=true'; "$CFG" --file "$TMP/c.toml" check >/dev/null && bad "owner row without owner session accepted" || ok "owner row needs an owner session"
mk 'owner_mail_read=true' 'owner_teams="ops/teams-kit/state/token-cache.json"'
out=$("$CFG" --file "$TMP/c.toml" check || true); grep -q 'must not share' <<<"$out" && ok "owner session sharing the Being's file refused" || bad "shared session accepted"
mk 'owner_chat=false'; "$CFG" --file "$TMP/c.toml" check >/dev/null && bad "owner_chat=false accepted" || ok "owner_chat is required"
printf '[access]\nowner_chat = true\nbogus = true\n[being]\nname = "nova"\n' >"$TMP/c.toml"
"$CFG" --file "$TMP/c.toml" check >/dev/null && bad "unknown access key accepted" || ok "unknown access key refused"
[[ "$("$CFG" --file "$REPO/templates/being.toml.example" get sessions.being_browser)" == "$HOME/.config/nova/being-browser" ]] \
  && ok "placeholders and ~ expanded" || bad "placeholder expansion"

echo "[runner]"
H="$TMP/beings/nova"; mkdir -p "$H/.beings" "$H/bin"
cp "$REPO/templates/being.toml.example" "$H/being.toml"
"$REPO/skills/runner/kit-install.sh" "$H" >"$TMP/out" 2>&1 && ok "runner kit-install" || bad "runner install: $(tail -3 "$TMP/out")"
ENVF="$HOME/.config/being-runner/env"; U="$HOME/.config/systemd/user"
[[ "$(stat -c %a "$ENVF")" == 600 ]] && ! grep -q '@[A-Z_]*@' "$ENVF" && grep -q "BEING_WORKSPACE=\"$H\"" "$ENVF" \
  && ok "runner env 0600, filled" || bad "runner env"
[[ -f "$U/nova-session.service" && -f "$U/nova-heartbeat.timer" && -f "$U/nova-poller.service" ]] && ! grep -lq '@[A-Z_]*@' "$U"/nova-* \
  && grep -q "tmux new-session -d -s nova -c $H" "$U/nova-session.service" && ok "units rendered for nova" || bad "units"
[[ -L "$HOME/.local/bin/being-job" ]] && ok "being-job linked" || bad "being-job link"
before=$(tree "$H"); "$REPO/skills/runner/kit-install.sh" "$H" >/dev/null 2>&1; [[ "$(tree "$H")" == "$before" ]] && ok "re-install changes nothing" || bad "re-install changed files"
# Jobs: stub model clients; the hook records the job file it was given.
cat >"$TMP/bin/claude" <<'EOF'
#!/usr/bin/env bash
f=$(printf '%s\n' "$@" | sed -n 's/^RESULT file: //p'); [[ -n "${STUB_NO_RESULT:-}" ]] || echo "result ok" >"$f"
EOF
chmod +x "$TMP/bin/claude"
printf '#!/bin/sh\necho "$1" >>"%s/hook.calls"\n' "$TMP" >"$TMP/bin/job-hook"; chmod +x "$TMP/bin/job-hook"
sed -i "s#^BEING_ON_JOB_DONE=.*#BEING_ON_JOB_DONE=\"$TMP/bin/job-hook\"#" "$ENVF"
J="$H/ops/runner/being-job"; JS="$HOME/.local/state/being-runner/jobs"
id=$("$J" run echo -- sh -c 'echo hi')
waitfor "grep -q '\"status\": \"done\"' '$JS/$id.json'" && grep -q '^hi$' "$JS/$id.log" && ok "run job done, log written" || bad "run job"
waitfor "grep -q '$id' '$HOME/.local/state/being-runner/work.jsonl' && grep -q '$id.json' '$TMP/hook.calls'" && ok "work.jsonl line + BEING_ON_JOB_DONE called" || bad "job done hook"
id=$("$J" agent research "do a thing"); waitfor "grep -q '\"status\": \"done\"' '$JS/$id.json'" && ok "agent job with a result: done" || bad "agent job: $(cat "$JS/$id.json")"
id=$(STUB_NO_RESULT=1 "$J" agent lazy "do a thing"); waitfor "grep -q '\"status\": \"no-result\"' '$JS/$id.json'" && ok "agent job without a result: no-result" || bad "no-result"
id=$("$J" run sleeper -- sleep 300); waitfor "[[ -f '$JS/$id.pid' ]]"; pg=$(cat "$JS/$id.pid")
"$J" stop "$id" testing >/dev/null; waitfor "! kill -0 $pg 2>/dev/null" && grep -q '"status": "stopped"' "$JS/$id.json" && ok "stop ends the job's process group" || bad "stop"
"$J" status ../../etc/passwd >/dev/null 2>&1 && bad "status accepted a path" || ok "job ids are validated"
B="$H/ops/runner/being-blocker"
"$B" "t1" "e1" "n1" | grep -q 'no BEING_BLOCKER_SEND' && ok "blocker logs without a sender" || bad "blocker no sender"
printf '#!/bin/sh\ncat >"%s/sent.html"\n' "$TMP" >"$TMP/bin/sender"; chmod +x "$TMP/bin/sender"
BEING_BLOCKER_SEND="$TMP/bin/sender" "$B" "deploy <x>" "err & fail" "need" | grep -q 'blocker sent' && grep -q 'deploy &lt;x&gt;' "$TMP/sent.html" \
  && ok "blocker sends escaped HTML on stdin" || bad "blocker send"
BEING_BLOCKER_SEND=false "$B" a b c >/dev/null 2>&1 && bad "failed send reported as sent" || ok "failed send exits non-zero"
[[ $(wc -l <"$HOME/.local/state/being-runner/blockers.jsonl") -eq 3 ]] && ok "every blocker logged" || bad "blocker log count"
if command -v tmux >/dev/null; then
  tmux new-session -d -s nova "cat"; sleep 0.3
  "$H/ops/runner/being-heartbeat" >/dev/null && sleep 0.3 && tmux capture-pane -p -t =nova: | grep -q 'HEARTBEAT.md' && ok "heartbeat nudges the tmux session" || bad "heartbeat"
  tmux kill-server 2>/dev/null || true
fi
BEING_SESSION=nosuch "$H/ops/runner/being-heartbeat" | grep -q skipped && ok "heartbeat skips a missing session" || bad "heartbeat missing session"

echo "[webhook install]"
mkdir -p "$H/ops/teams-kit"
"$REPO/skills/teams-kit/webhook/kit-install.sh" "$H" >"$TMP/out" 2>&1 && ok "webhook kit-install" || bad "webhook install: $(tail -3 "$TMP/out")"
HS="$HOME/.local/state/graph-webhook"; cs="$(cat "$HS/client-state")"
[[ ${#cs} -eq 64 && "$(stat -c %a "$HS/client-state")" == 600 && "$(stat -c %a "$HS")" == 700 ]] && ok "client-state 64 chars, 0600 in 0700" || bad "client-state"
grep -q '^HOOK_PUBLIC=https://nova-hook' "$HOME/.config/graph-webhook/env" && [[ "$(stat -c %a "$HOME/.config/graph-webhook/env")" == 600 ]] && ok "webhook env filled, 0600" || bad "webhook env"
grep -q "ExecStart=/usr/bin/env node $H/ops/teams-kit/webhook/graph-webhook.mjs" "$U/graph-webhook.service" && grep -q "PathModified=$HS/lifecycle.jsonl" "$U/graph-lifecycle.path" \
  && ok "webhook units point at the kit and state" || bad "webhook units"
"$REPO/skills/teams-kit/webhook/kit-install.sh" "$H" >/dev/null 2>&1; [[ "$(cat "$HS/client-state")" == "$cs" ]] && ok "re-install keeps the secret" || bad "secret replaced"
port=$(freeport); HOOK_PORT=$port node "$H/ops/teams-kit/webhook/graph-webhook.mjs" >"$TMP/hook.log" 2>&1 & PIDS+=($!)
waitfor "curl -s -o /dev/null http://127.0.0.1:$port/" && [[ "$(curl -s -X POST "http://127.0.0.1:$port/graph/notify?validationToken=abc")" == abc ]] \
  && ok "installed receiver answers validation" || bad "receiver"
"$REPO/skills/teams-kit/webhook/hook-wait" 1 && ok "hook-wait returns after the tick" || bad "hook-wait"

echo "[desktop]"
"$REPO/skills/desktop/kit-install.sh" "$H" >"$TMP/out" 2>&1 && [[ -x "$H/ops/desktop/rdp-session-end.sh" && -f "$U/rdp-session-reap.timer" ]] \
  && grep -q 'REAP_GRACE=600' "$U/rdp-session-reap.service" && ok "desktop box side installed" || bad "desktop install: $(tail -3 "$TMP/out")"
lp=$(freeport); rp=$(freeport)
cat >"$TMP/d.toml" <<EOF
[being]
name = "nova"
[box]
lan_address = "127.0.0.1"
office_subnet = "127.0.0.0/8"
rdp_port = $rp
[tunnel]
domain = "example.com"
[desktop]
local_port = $lp
EOF
"$REPO/skills/desktop/being-desktop" install nova --config "$TMP/d.toml" </dev/null >"$TMP/out" 2>&1 && ok "being-desktop install" || bad "desktop install: $(tail -3 "$TMP/out")"
C="$HOME/.config/nova-box"
grep -q '^DESKTOP_HOST=nova-desktop.example.com$' "$C/box.env" && grep -q '^BOX_LAN_HOST=127.0.0.1$' "$C/box.env" && ok "box.env from being.toml" || bad "box.env: $(cat "$C/box.env")"
[[ "$(stat -c %a "$C/rdp.env")" == 600 && "$(stat -c %a "$C")" == 700 ]] && ok "rdp.env 0600 in 0700" || bad "rdp.env modes"
"$REPO/skills/desktop/being-desktop" install nova --config "$TMP/d.toml" </dev/null >/dev/null 2>&1
[[ $(grep -c '^Host nova-box$' "$HOME/.ssh/config") -eq 1 && $(grep -c '^Host nova-lan$' "$HOME/.ssh/config") -eq 1 ]] && ok "ssh aliases added once" || bad "ssh config"
printf 'RDP_PASS=%q\n' 'pa ss$word' >"$C/rdp.env"
cat >"$TMP/bin/xfreerdp3" <<EOF
#!/bin/sh
echo "\$*" >>"$TMP/rdp.argv"; cat >"$TMP/rdp.stdin"
EOF
printf '#!/bin/sh\necho "$*" >>"%s/ssh.calls"\n' "$TMP" >"$TMP/bin/ssh"; chmod +x "$TMP/bin/xfreerdp3" "$TMP/bin/ssh"
listen "$rp"; waitfor "ss -Hltn '( sport = :$rp )' | grep -q ."
"$HOME/.local/bin/nova-desktop" >"$TMP/out" 2>&1 && grep -q "/v:127.0.0.1:$rp" "$TMP/rdp.argv" && ok "LAN route when the RDP port answers" || bad "LAN route: $(cat "$TMP/out")"
! grep -q 'pa ss' "$TMP/rdp.argv" && [[ "$(cat "$TMP/rdp.stdin")" == 'pa ss$word' ]] && ok "password on stdin, not argv" || bad "password handling"
grep -q '^nova-lan .*rdp-session-end} now\|^.*nova-lan.*now' "$TMP/ssh.calls" && ok "close ends the session via the LAN alias" || bad "cleanup alias: $(cat "$TMP/ssh.calls")"
# Off the office network: no LAN probe (the port still answers), tunnel forwarder started, stopped after close.
sed -i 's#^BOX_LAN_SUBNET=.*#BOX_LAN_SUBNET=192.0.2.0/24#' "$C/box.env"; : >"$TMP/ssh.calls"
cat >"$TMP/bin/cloudflared" <<EOF
#!/bin/sh
case "\$2" in login) echo FAKEJWTSESSION; exit 0 ;; rdp) exec python3 -c 'import socket,time; s=socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(("127.0.0.1", $lp)); s.listen(5); time.sleep(600)' ;; esac
EOF
chmod +x "$TMP/bin/cloudflared"
"$HOME/.local/bin/nova-desktop" >"$TMP/out" 2>&1 && tail -1 "$TMP/rdp.argv" | grep -q "/v:localhost:$lp" && ok "off-LAN goes straight to the tunnel" || bad "tunnel route: $(cat "$TMP/out")"
! grep -q FAKEJWT "$TMP/out" "$HOME/.local/state/nova-desktop/"* 2>/dev/null && ok "access login output discarded" || bad "login output leaked"
waitfor "! ss -Hltn '( sport = :$lp )' | grep -q ." && ok "forwarder stopped after close" || bad "forwarder left running"
grep -q 'nova-box' "$TMP/ssh.calls" && ! grep -q 'nova-lan' "$TMP/ssh.calls" && ok "off-LAN cleanup uses the tunnel alias only" || bad "off-LAN cleanup"
out=$("$HOME/.local/bin/nova-desktop" status 2>&1 || true); grep -q 'password:   present (mode 600)' <<<"$out" && ok "status" || bad "status: $out"

echo "[rdp-session-end]"
mkdir -p "$TMP/rbin"
cat >"$TMP/rbin/loginctl" <<EOF
#!/bin/sh
case "\$1" in
  list-sessions) echo "7 1000 $(id -un) seat0" ;;
  show-session) case "\$4" in Remote) echo yes ;; Service) echo gdm-password ;; esac ;;
  terminate-session) echo "\$2" >>"$TMP/terminated" ;;
esac
EOF
printf '#!/bin/sh\n[ -e "%s/client" ] && echo "ESTAB 0 0 192.0.2.10:3389 192.0.2.20:50000"\nexit 0\n' "$TMP" >"$TMP/rbin/ss"; chmod +x "$TMP/rbin/"*
RS="$REPO/skills/desktop/rdp-session-end.sh"; rpath="$TMP/rbin:$PATH"
touch "$TMP/client"; PATH="$rpath" "$RS" now | grep -q 'still connected' && [[ ! -e "$TMP/terminated" ]] && ok "now: skips a session still in use" || bad "now with client"
rm "$TMP/client"; PATH="$rpath" "$RS" now >/dev/null && grep -q '^7$' "$TMP/terminated" && ok "now: ends an unused session" || bad "now without client"
rm -f "$TMP/terminated"; PATH="$rpath" REAP_GRACE=600 "$RS" reap; [[ ! -e "$TMP/terminated" ]] && ok "reap: waits for the grace period" || bad "reap early"
PATH="$rpath" REAP_GRACE=0 "$RS" reap >/dev/null; [[ -e "$TMP/terminated" ]] && ok "reap: ends after the grace period" || bad "reap late"

echo "[harden-box]"
printf '[being]\nname = "nova"\nlinux_user = "%s"\n[box]\noffice_subnet = "192.0.2.0/24"\n' "$(id -un)" >"$TMP/h.toml"
"$REPO/scripts/harden-box.sh" --config "$TMP/h.toml" --desktop --dry-run >"$TMP/out" 2>&1 \
  && grep -qE 'ufw allow from 192.0.2.0/24 to any port 22 proto tcp|allow tcp 22 and 3389 from 192.0.2.0/24' "$TMP/out" && grep -qE 'port 3389|22 and 3389' "$TMP/out" \
  && grep -q 'PasswordAuthentication no' "$TMP/out" && grep -q 'enable-linger' "$TMP/out" && grep -q 'nothing changed' "$TMP/out" \
  && ok "dry run plans ssh, firewall, linger, desktop" || bad "harden dry run: $(tail -5 "$TMP/out")"
"$REPO/scripts/harden-box.sh" --config "$TMP/h.toml" --dry-run | grep -q 'port 3389' && bad "RDP opened without --desktop" || ok "no RDP rule without --desktop"
sed -i 's#192.0.2.0/24#0.0.0.0/0#' "$TMP/h.toml"; "$REPO/scripts/harden-box.sh" --config "$TMP/h.toml" --dry-run >/dev/null 2>&1 && bad "0.0.0.0/0 accepted" || ok "open subnet refused"
sed -i 's#0.0.0.0/0#<office-cidr>#' "$TMP/h.toml"; "$REPO/scripts/harden-box.sh" --config "$TMP/h.toml" --dry-run >/dev/null 2>&1 && bad "placeholder subnet accepted" || ok "placeholder subnet refused"
if [[ $EUID -ne 0 ]]; then sed -i 's#<office-cidr>#192.0.2.0/24#' "$TMP/h.toml"
  "$REPO/scripts/harden-box.sh" --config "$TMP/h.toml" >/dev/null 2>&1 && bad "ran without sudo" || ok "needs sudo unless --dry-run"; fi

echo "[repair]"
before=$(tree "$H")
"$REPO/scripts/repair.sh" "$H" --dry-run >"$TMP/out" 2>&1 && grep -q 'repair: nova' "$TMP/out" && [[ "$(tree "$H")" == "$before" ]] \
  && ok "repair dry run names the Being, changes nothing" || bad "repair: $(tail -5 "$TMP/out")"
"$REPO/scripts/repair.sh" "$TMP" >/dev/null 2>&1 && bad "repair accepted a non-Being dir" || ok "repair refuses a dir without .beings/"

echo "[verify / offboard]"
K="$H/ops/teams-kit"; ST="$K/state"; mkdir -p "$ST/grants"
cp "$REPO/skills/teams-kit/verify.sh" "$REPO/skills/teams-kit/offboard.sh" "$K/"
echo '{}' >"$ST/token-cache.json"; echo x >"$ST/handler.key"; echo g >"$ST/grants/one"; chmod 600 "$ST/token-cache.json"
cat >"$K/.env" <<EOF
BEING_NAME=nova
BEING_UPN=nova@example.com
BEING_STATE_DIR='$ST'
BEING_CACHE='$ST/token-cache.json'
OWNER_UPN=owner@example.com
OWNER_OID=00000000-0000-0000-0000-00000000a001
OWNER_DM_CHAT=owner-one-to-one-chat
M365_CLIENT_ID=00000000-0000-0000-0000-0000000000c1
M365_TENANT_ID=00000000-0000-0000-0000-0000000000a1
BEING_OWNER_DELEGATE=0
EOF
chmod 600 "$K/.env"; printf '#!/bin/sh\necho "down: $*"\n' >"$K/being-teams"; chmod +x "$K/being-teams"
cat >"$TMP/bin/node" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == whoami.mjs ]] || exit 1
while [[ $# -gt 0 ]]; do case "$1" in --upn) u=$2 ;; --label) l=$2 ;; esac; shift; done; echo "$l: signed in as $u"
EOF
chmod +x "$TMP/bin/node"; printf '#!/bin/sh\nexit 1\n' >"$TMP/bin/systemctl"; chmod +x "$TMP/bin/systemctl"
"$K/verify.sh" --no-send >"$TMP/out" 2>&1 && grep -q 'Being Teams: signed in as nova@example.com' "$TMP/out" && grep -q 'Being Outlook: signed in' "$TMP/out" \
  && grep -q 'Owner Teams / Owner Outlook: off' "$TMP/out" && ok "verify: Being sessions checked, owner off" || bad "verify: $(cat "$TMP/out")"
echo '{}' >"$TMP/owner.json"; chmod 600 "$TMP/owner.json"; printf "OWNER_CACHE='%s'\n" "$TMP/owner.json" >>"$K/.env"
out=$("$K/verify.sh" --no-send 2>&1 || true); grep -q 'WARN an owner token cache exists while owner access is off' <<<"$out" && ok "verify warns on a stray owner cache" || bad "stray owner cache"
printf "BEING_OWNER_DELEGATE=1\nOWNER_MAIL_CACHE='%s'\n" "$ST/token-cache.json" >>"$K/.env"
"$K/verify.sh" --no-send >"$TMP/out" 2>&1 && bad "shared owner/Being cache passed" || { grep -q 'share a token cache' "$TMP/out" && grep -q 'Owner Teams: signed in as owner@example.com' "$TMP/out" \
  && ok "verify: four sessions checked, shared cache fails" || bad "verify owner: $(cat "$TMP/out")"; }
before=$(tree "$K"); "$K/offboard.sh" >"$TMP/out" 2>&1 && [[ "$(tree "$K")" == "$before" ]] && grep -q 'dry run' "$TMP/out" && ok "offboard without --yes changes nothing" || bad "offboard dry run"
"$K/offboard.sh" --yes >"$TMP/out" 2>&1 && [[ ! -e "$ST/token-cache.json" && ! -e "$ST/handler.key" && ! -e "$ST/grants/one" && ! -e "$TMP/owner.json" && -e "$ST/STANDBY" ]] \
  && grep -q 'being-tunnel delete nova' "$TMP/out" && ok "offboard --yes: caches, grants removed, standby, manual steps" || bad "offboard: $(tail -5 "$TMP/out")"

(( fails == 0 )) && echo "onboarding: all checks passed" || { echo "onboarding: $fails failed"; exit 1; }
