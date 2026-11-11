#!/usr/bin/env bash
# sudo harden-box.sh --config <being.toml> [--user <u>] [--rotate-password] [--desktop [--rdp gnome|xrdp]] [--dry-run]: one-time box
# hardening: SSH key-only, firewall (office subnet only), linger, per-box password, RDP server (docs/PROVISIONING.md).
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
CFG="" USER_NAME="" ROTATE=0 DESKTOP=0 DRY=0 RDP_KIND=auto
while [[ $# -gt 0 ]]; do
  case "$1" in
    --config) CFG="${2:?}"; shift 2 ;;
    --user) USER_NAME="${2:?}"; shift 2 ;;
    --rotate-password) ROTATE=1; shift ;;
    --desktop) DESKTOP=1; shift ;;
    --rdp) RDP_KIND="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
  esac
done
[[ -f "$CFG" ]] || { echo "pass --config <being.toml>" >&2; exit 2; }
get() { "$HERE/being-config" --file "$CFG" get "$1" "${2:-}"; }
USER_NAME="${USER_NAME:-$(get being.linux_user "$(get being.name)")}"
SUBNET="$(get box.office_subnet '')"; SSH_PORT="$(get box.ssh_port 22)"; RDP_PORT="$(get box.rdp_port 3389)"
python3 -c 'import ipaddress,sys; n=ipaddress.ip_network(sys.argv[1], strict=False); sys.exit(1 if n.prefixlen == 0 else 0)' "$SUBNET" 2>/dev/null \
  || { echo "set [box].office_subnet to the office network (CIDR, not 0.0.0.0/0); got '${SUBNET}'" >&2; exit 2; }
[[ "$SSH_PORT" =~ ^[0-9]+$ && "$RDP_PORT" =~ ^[0-9]+$ ]] || { echo "bad port in [box]" >&2; exit 2; }
RDPTXT=""; (( DESKTOP )) && RDPTXT=" and RDP"
(( DRY )) || [[ $EUID -eq 0 ]] || { echo "run with sudo (or --dry-run to see the plan)" >&2; exit 2; }

run() { if (( DRY )); then printf '  + %s\n' "$*"; else "$@"; fi; }
put() {   # put <file> <mode>: content on stdin
  if (( DRY )); then printf '  + write %s (mode %s):\n' "$1" "$2"; sed 's/^/      /'; else install -m "$2" /dev/stdin "$1"; fi
}
step() { printf '\n[%s] %s\n' "$1" "$2"; }

id "$USER_NAME" >/dev/null 2>&1 || { echo "no Linux user '$USER_NAME' (create it first: docs/PROVISIONING.md)" >&2; exit 2; }
UHOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
echo "harden-box: user $USER_NAME, office subnet $SUBNET, ssh $SSH_PORT$( (( DESKTOP )) && echo ", rdp $RDP_PORT")$( (( DRY )) && echo ' (dry run)')"

step 1 "password"
if (( ROTATE )); then
  echo "  Set a new password for $USER_NAME, used on this box only (never reuse it, never send it in chat)."
  run passwd "$USER_NAME"
else echo "  skipped (--rotate-password to set a per-box password now)"; fi

step 2 "SSH: keys only"
# Lockout guard: the Being and the admin running this must already log in with a key.
for u in "$USER_NAME" ${SUDO_USER:+"$SUDO_USER"}; do
  h="$(getent passwd "$u" | cut -d: -f6)"
  [[ -s "$h/.ssh/authorized_keys" ]] || { echo "  $u has no ~/.ssh/authorized_keys: add a key first, or you lose SSH access" >&2; (( DRY )) || exit 1; }
done
grep -qiE '^\s*Include\s+/etc/ssh/sshd_config.d/' /etc/ssh/sshd_config 2>/dev/null || echo "  WARN /etc/ssh/sshd_config does not include sshd_config.d/; add the lines below to it by hand"
# sshd keeps the FIRST value it reads and reads sshd_config.d/ in name order: a cloud-init 50-*.conf with
# "PasswordAuthentication yes" beats any later file, so ours sorts first.
[[ -f /etc/ssh/sshd_config.d/60-being-harden.conf ]] && run rm -f /etc/ssh/sshd_config.d/60-being-harden.conf
put /etc/ssh/sshd_config.d/01-being-harden.conf 644 <<'EOF'
# Written by harden-box.sh (Beings kit). Remove this file and reload ssh to undo.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
EOF
run sshd -t
run systemctl reload ssh || run systemctl reload sshd
if (( ! DRY )) && sshd -T 2>/dev/null | grep -qx 'passwordauthentication yes'; then
  echo "  FAIL password SSH is still on; it is set here first:" >&2
  grep -lis '^\s*PasswordAuthentication\s\+yes' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null | sed 's/^/    /' >&2
  exit 1
fi

step 3 "firewall: SSH$RDPTXT from $SUBNET only"
if command -v ufw >/dev/null; then
  run ufw allow from "$SUBNET" to any port "$SSH_PORT" proto tcp comment "being ssh"
  (( DESKTOP )) && run ufw allow from "$SUBNET" to any port "$RDP_PORT" proto tcp comment "being rdp"
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw --force enable
else
  echo "  WARN ufw not installed: allow tcp $SSH_PORT$( (( DESKTOP )) && echo " and $RDP_PORT") from $SUBNET only, deny other incoming, in your firewall"
fi
echo "  The tunnel needs no inbound port: cloudflared connects out."

step 4 "linger (the Being's services run without a login and start after a reboot); never suspend"
run loginctl enable-linger "$USER_NAME"
# A desktop login screen suspends an idle box after ~20 min; a Being's box must stay up.
run systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target

if (( DESKTOP )); then
  if [[ $RDP_KIND == auto ]]; then   # GNOME's system-mode RDP fails at the login-screen handover on 24.04; xrdp works there
    ver="$(. /etc/os-release 2>/dev/null; echo "${VERSION_ID:-0}")"
    RDP_KIND=$(python3 -c 'import sys; print("xrdp" if float(sys.argv[1] or 0) < 25 else "gnome")' "$ver" 2>/dev/null || echo gnome)
  fi
  if [[ $RDP_KIND == xrdp ]]; then
    step 5 "remote desktop (xrdp, the user's own desktop session)"
    run apt-get install -y xrdp
    run adduser xrdp ssl-cert
    [[ "$RDP_PORT" == 3389 ]] || run sed -i "s/^port=3389$/port=$RDP_PORT/" /etc/xrdp/xrdp.ini
    # Without this rule every xrdp login pops a colour-profile password prompt.
    put /etc/polkit-1/rules.d/45-being-colord.rules 644 <<'RULE'
polkit.addRule(function(action, subject) {
  if (action.id.indexOf("org.freedesktop.color-manager.") == 0 && subject.isInGroup("users")) return polkit.Result.YES;
});
RULE
    if [[ ! -f "$UHOME/.xsessionrc" ]]; then   # the Ubuntu session, not a bare GNOME one
      printf '%s\n' 'export GNOME_SHELL_SESSION_MODE=ubuntu' 'export XDG_CURRENT_DESKTOP=ubuntu:GNOME' \
        'export XDG_CONFIG_DIRS=/etc/xdg/xdg-ubuntu:/etc/xdg' | put "$UHOME/.xsessionrc" 644
      run chown "$USER_NAME:" "$UHOME/.xsessionrc"
    fi
    run systemctl enable --now xrdp
    echo "  RDP signs in with $USER_NAME's own Linux password (the owner keeps it)."
  else
    step 5 "remote desktop (GNOME Remote Desktop, system mode: RDP, then the Ubuntu login screen)"
    if command -v grdctl >/dev/null; then
      run grdctl --system rdp enable
      [[ "$RDP_PORT" == 3389 ]] || run grdctl --system rdp set-port "$RDP_PORT"
      echo "  RDP credentials for $USER_NAME: you are asked for the password (store it on the owner's laptop in rdp.env)."
      run grdctl --system rdp set-credentials "$USER_NAME"
      run systemctl enable --now gnome-remote-desktop.service
    else
      echo "  WARN grdctl not found: install gnome-remote-desktop (Ubuntu desktop) and re-run with --desktop, or use --rdp xrdp"
    fi
  fi
fi

step 6 "check"
if (( DRY )); then echo "  dry run: nothing changed"; exit 0; fi
sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin) ' | sed 's/^/  /'
command -v ufw >/dev/null && ufw status | sed 's/^/  /'
echo "  linger: $(loginctl show-user "$USER_NAME" -p Linger --value 2>/dev/null)"
[[ -d "$UHOME" ]] && echo "  done. Test a new SSH login with a key from another terminal before closing this one."
