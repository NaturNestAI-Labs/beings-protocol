#!/usr/bin/env bash
# setup-users.sh [--apply] [--with-hidepid]: the ROOT half of the users layout (isolation/README.md). Default: dry run.
# Idempotent with --apply. Env overrides: BEING KIT_USER MODEL_USER TEAM_USER WS_GROUP KIT.
set -euo pipefail
export PATH="/usr/local/sbin:/usr/sbin:/sbin:$PATH"
APPLY=0; HIDEPID=0
for a in "$@"; do case $a in --apply) APPLY=1 ;; --with-hidepid) HIDEPID=1 ;; *) echo "usage: $0 [--apply] [--with-hidepid]" >&2; exit 2 ;; esac; done
B=${BEING:-${SUDO_USER:-$(id -un)}}; KU=${KIT_USER:-$B}; AI=${MODEL_USER:-$B-ai}; TM=${TEAM_USER:-$B-team}; WSG=${WS_GROUP:-$B-ws}
KIT=${KIT:-$(getent passwd "$KU" | cut -d: -f6)/beings-protocol/skills/teams-kit}
LIBEXEC=/usr/local/libexec/$B; ETC=/etc/$B; SRV=/srv/$B; TEAMROOT=/srv/$B-team; SUDOERS=/etc/sudoers.d/$B-isolation

run() { if (( APPLY )); then echo "+ $*"; "$@"; else printf '  '; printf '%q ' "$@"; echo; fi; }
note() { echo "# $*"; }
die() { echo "setup-users: $*" >&2; exit 1; }

(( APPLY )) && [[ $EUID -ne 0 ]] && die "--apply needs root (sudo $0 --apply)"
(( APPLY )) || echo "DRY RUN (nothing changes). As root: sudo $0 --apply"

note "preflight"
id "$KU" >/dev/null 2>&1 || die "kit user $KU does not exist"
[[ -x $KIT/isolation/model-run ]] || die "$KIT/isolation/model-run missing (wrong KIT?)"
command -v bwrap >/dev/null || die "bubblewrap missing: apt-get install bubblewrap"
command -v setfacl >/dev/null || die "acl tools missing: apt-get install acl"
command -v visudo >/dev/null || die "visudo missing"
uns=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)
aa=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)
echo "  unprivileged_userns_clone=$uns apparmor_restrict_unprivileged_userns=$aa"
[[ $uns == 1 ]] || die "unprivileged user namespaces are off: bubblewrap cannot run (sysctl kernel.unprivileged_userns_clone=1)"

note "1. groups and users"
getent group "$WSG" >/dev/null || run groupadd --system "$WSG"
id "$AI" >/dev/null 2>&1 || run useradd --system --create-home --home-dir "/home/$AI" --shell /bin/bash --user-group \
  --comment "$B model runs (owner lane, jobs)" "$AI"
id "$TM" >/dev/null 2>&1 || run useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --user-group \
  --comment "$B teammate lanes" "$TM"
run usermod -aG "$WSG" "$AI"
run usermod -aG "$WSG" "$KU"      # the workspace is shared kit user + model user, by group (setgid dirs, umask 002)
run usermod -aG "$TM" "$KU"       # lane dirs are kit-user-owned, group = the team user's (team-sync writes them)
run passwd -l "$AI"; run passwd -l "$TM"   # no password logins
[[ -d /home/$AI ]] && run chmod 0700 "/home/$AI" || true

note "2. directories the model users can reach (nothing under the kit user's home except the workspace, by ACL later)"
run install -d -o root -g root -m 0755 "$SRV"
run install -d -o "$KU" -g "$KU" -m 0711 "$SRV/run"          # per-run broker sockets (0600 + one ACL entry each)
run install -d -o "$KU" -g "$KU" -m 0755 "$SRV/kit-bin"      # model-side shims (kit-client), kit-user-owned, read-only to models
run install -d -o "$KU" -g "$KU" -m 0755 "$SRV/claude"       # the model client install the model users run but can't change
run install -d -o "$KU" -g "$TM" -m 2750 "$TEAMROOT"         # one dir per teammate lane (team-sync)

note "3. model credentials: root-owned, readable by that user only (filled by the owner, see README 'Claude Code auth')"
run install -d -o root -g root -m 0755 "$ETC"
for u in "$AI" "$TM"; do
  f=$ETC/claude-$u.env
  if [[ -e $f ]]; then echo "  (keep existing $f)"; else run install -o root -g "$u" -m 0440 /dev/null "$f"; fi
done

note "4. model-run, root-owned (the kit user starts sandboxes as the model users through it)"
run install -d -o root -g root -m 0755 "$LIBEXEC"
run install -o root -g root -m 0755 "$KIT/isolation/model-run" "$LIBEXEC/model-run"

note "5. sudoers: kit user → model users only. Validated with visudo -c before it is installed."
tmp=$(mktemp)
cat >"$tmp" <<EOF
# $B OS isolation (teams-kit isolation/setup-users.sh). The kit user ($KU) starts model clients as $AI / $TM.
# The model users have no sudo rights: they reach the kit only through kit-broker sockets.
Defaults>$AI,$TM env_reset
$KU ALL=($AI,$TM) NOPASSWD: ALL
EOF
if (( APPLY )); then
  visudo -cf "$tmp" || { rm -f "$tmp"; die "sudoers snippet failed visudo -c; nothing installed"; }
  install -o root -g root -m 0440 "$tmp" "$SUDOERS"; visudo -c >/dev/null || { rm -f "$SUDOERS"; die "full visudo -c failed; snippet removed"; }
  echo "+ installed $SUDOERS"
else
  echo "  write $SUDOERS (0440):"; sed 's/^/    | /' "$tmp"
  if visudo -cf "$tmp" >/dev/null 2>&1; then echo "  (visudo -cf on this snippet: parsed OK)"; else echo "  !! visudo -cf rejects this snippet:"; visudo -cf "$tmp" 2>&1 | sed "s/^/     /"; fi
fi
rm -f "$tmp"

note "6. keep bubblewrap allowed to create user namespaces if Ubuntu's AppArmor restriction is turned on later"
if [[ -d /etc/apparmor.d && -e /etc/apparmor.d/abi/4.0 ]]; then
  if [[ -e /etc/apparmor.d/bwrap-userns-restrict || -e /etc/apparmor.d/bwrap ]]; then echo "  (a bwrap AppArmor profile already exists: leave it)"
  else
    prof='abi <abi/4.0>,\ninclude <tunables/global>\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\n  userns,\n  include if exists <local/bwrap>\n}\n'
    if (( APPLY )); then printf "$prof" >/etc/apparmor.d/bwrap && apparmor_parser -r /etc/apparmor.d/bwrap && echo "+ /etc/apparmor.d/bwrap loaded"
    else echo "  write /etc/apparmor.d/bwrap (unconfined + userns for /usr/bin/bwrap only) and apparmor_parser -r it"; fi
  fi
else echo "  (no AppArmor 4 abi: nothing to do)"; fi

if (( HIDEPID )); then
  note "7. optional: hide other users' processes (/proc hidepid). The teammate lanes already have their own /proc."
  echo "  Add to /etc/fstab:  proc /proc proc defaults,hidepid=invisible 0 0   then: mount -o remount,hidepid=invisible /proc"
  echo "  (not applied automatically: check polkit/systemd-logind on this box first)"
fi

note "done. Next, as $KU (no root): $KIT/isolation/migrate.sh  (dry run), then --apply; then the owner: model credentials (README)."
