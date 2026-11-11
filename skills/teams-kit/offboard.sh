#!/usr/bin/env bash
# offboard.sh [--yes] [--keep-caches]: take the Teams kit off this box (dry run without --yes): services, Graph
# subscription, send grants, local sign-ins, standby marker, then the manual steps (docs/PROVISIONING.md).
set -euo pipefail
KIT="${BEING_KIT_HOME:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
DO=0 KEEP=0
for a in "$@"; do case "$a" in --yes) DO=1 ;; --keep-caches) KEEP=1 ;; *) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;; esac; done
set -a
# shellcheck source=/dev/null
. "$KIT/.env"
set +a
N="${BEING_NAME:?BEING_NAME missing in .env}"; ST="${BEING_STATE_DIR:?}"
run() { if (( DO )); then "$@" || echo "  (failed: $*)"; else printf '  + %s\n' "$*"; fi; }
gone() { if (( DO )); then shred -u "$1" 2>/dev/null || rm -f "$1"; else printf '  + remove %s\n' "$1"; fi; }
(( DO )) || echo "offboard $N: dry run (pass --yes to do it)"

echo "[1] stop services"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  mapfile -t units < <(systemctl --user list-unit-files --no-legend 2>/dev/null | awk '{print $1}' | grep -E \
    "^($N-(teams|deadman|session|poller|heartbeat)\.(service|timer)|being-routine@.*|graph-(webhook|subscribe|subscribe-renew|lifecycle)\.(service|timer|path)|rdp-session-reap\.timer)$" || true)
  for u in "${units[@]}"; do run systemctl --user disable --now "$u"; done
  (( ${#units[@]} )) || echo "  none installed"
else echo "  no systemd user session"; fi
run "$KIT/being-teams" down

echo "[2] Graph subscription"
if [[ -f "$KIT/webhook/graph-subscribe.mjs" ]]; then run node "$KIT/webhook/graph-subscribe.mjs" delete; else echo "  no webhook installed"; fi

echo "[3] send grants and handler key"
for f in "$ST/handler.key" "$ST"/grants/*; do [[ -e "$f" ]] && gone "$f"; done
echo "  standby marker: nothing sends from this host if it is restarted"
(( DO )) && : >"$ST/STANDBY" || echo "  + touch $ST/STANDBY"

echo "[4] local sign-ins"
if (( KEEP )); then echo "  kept (--keep-caches)"
else
  for f in "${BEING_CACHE:-}" "${BEING_MAIL_CACHE:-}" "${OWNER_CACHE:-}" "${OWNER_MAIL_CACHE:-}"; do [[ -n "$f" && -e "$f" ]] && gone "$f"; done
  for d in "${BEING_BROWSER_PROFILE:-}" "${OWNER_BROWSER_PROFILE:-}"; do [[ -n "$d" && -d "$d" ]] && run rm -rf -- "$d"; done
fi

cat <<EOF

Manual steps (need an admin or another machine):
  - Entra: revoke the Being's sign-in sessions; if the owner signed in here, the owner revokes their own sessions too.
  - Entra: remove the app consent or the Being's account access if the Being is retired; remove its licences.
  - Admin box: being-tunnel delete $N (DNS, routes, connector token, tunnel, service tokens, Access apps).
  - Claude / Codex: sign the Being's seats out on this box (claude /logout, codex logout) and free the seats if retired.
  - Remove the laptop side: ~/.local/bin/$N-desktop, ~/.config/$N-box/, the "$N-box" block in ~/.ssh/config.
  - Box admin: remove the Being's SSH keys from authorized_keys, disable linger, then lock or delete the Linux user.
  - Rotate anything the Being could read that others still use (app keys in its key folder).
  - Keep the Being's home repo (memory and records); remove ops/teams-kit/.env only after the steps above.
EOF
