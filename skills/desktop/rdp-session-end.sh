#!/usr/bin/env bash
# rdp-session-end now|reap: log out this user's RDP sessions. now: unless a client is still connected (viewer closed);
# reap: only after no client for REAP_GRACE seconds (timer; covers crashes and a sleeping laptop).
set -uo pipefail
GRACE=${REAP_GRACE:-600}; PORT=${RDP_PORT:-3389}; SERVICE=${RDP_LOGIN_SERVICE:-gdm-password}
MARK="${XDG_STATE_HOME:-$HOME/.local/state}/rdp-idle-since"

remote_sessions() {
  loginctl list-sessions --no-legend 2>/dev/null | awk -v u="$(id -un)" '$3==u {print $1}' | while read -r s; do
    [[ $(loginctl show-session "$s" -p Remote --value) == yes && $(loginctl show-session "$s" -p Service --value) == "$SERVICE" ]] && echo "$s"
  done
}
client_connected() { ss -Htn state established "( sport = :$PORT )" 2>/dev/null | grep -q .; }
end_all() { local s; for s in $(remote_sessions); do loginctl terminate-session "$s" && echo "ended session $s"; done; rm -f "$MARK"; }

case "${1:-reap}" in
  # A late close from an old viewer must not end a newer live session; the reaper covers it.
  now) if client_connected; then echo "client still connected; leaving it to the reaper"; else end_all; fi ;;
  reap)
    [[ -z $(remote_sessions) ]] && { rm -f "$MARK"; exit 0; }
    if client_connected; then rm -f "$MARK"; exit 0; fi
    mkdir -p "$(dirname "$MARK")"; [[ -f $MARK ]] || date +%s >"$MARK"
    if (( $(date +%s) - $(cat "$MARK") >= GRACE )); then end_all; fi ;;
  *) echo "usage: rdp-session-end [now|reap]" >&2; exit 2 ;;
esac
