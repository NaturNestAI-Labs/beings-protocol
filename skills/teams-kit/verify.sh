#!/usr/bin/env bash
# verify.sh [--no-send] [--wait-reply <min>]: settings, who-am-I for the four sessions (Being/owner x Teams/Outlook),
# test DM read back, blocker path, units enabled and active, linger. Run in ops/teams-kit; exit 1 on any FAIL.
set -euo pipefail
KIT="${BEING_KIT_HOME:-$(cd "$(dirname "$(readlink -f "$0")")" && pwd)}"
SEND=1 WAIT_MIN=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-send) SEND=0; shift ;;
    --wait-reply) WAIT_MIN="${2:?minutes}"; shift 2 ;;
    *) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
  esac
done
OKS=0 WARNS=0 FAILS=0
ok() { echo "  ok   $*"; OKS=$((OKS + 1)); }
warn() { echo "  WARN $*"; WARNS=$((WARNS + 1)); }
bad() { echo "  FAIL $*"; FAILS=$((FAILS + 1)); }
real() { readlink -f "$1" 2>/dev/null || echo "$1"; }

echo "[settings]"
if [[ -f "$KIT/.env" ]] && bash -c 'set -euo pipefail; set -a; . "$1"' _ "$KIT/.env" >/dev/null 2>&1; then
  set -a
  # shellcheck source=/dev/null
  . "$KIT/.env"
  set +a
  ok ".env sources cleanly"
else bad ".env missing or does not source"; echo "verify: stopped"; exit 1; fi
for k in BEING_NAME BEING_UPN BEING_STATE_DIR BEING_CACHE OWNER_UPN OWNER_OID OWNER_DM_CHAT M365_CLIENT_ID M365_TENANT_ID; do
  [[ -n "${!k:-}" ]] || bad "$k is empty in .env"
done
[[ "$(stat -c %a "$KIT/.env")" == 600 ]] && ok ".env is 0600" || bad ".env mode $(stat -c %a "$KIT/.env") (chmod 600)"

if sw="$(cd "$KIT" && python3 -c 'import soul; soul.public_soul(soul.read(soul.SOUL))' 2>&1 >/dev/null)" && [[ $sw == *"no public section"* ]]; then
  warn "SOUL.md has no section teammate lanes may see (BEING_SOUL_PUBLIC_SECTIONS): they get a minimal persona"
fi

echo "[sessions: who am I]"
OWNER_ON=0; [[ "${BEING_OWNER_DELEGATE:-0}" == 1 && -n "${OWNER_CACHE:-}" ]] && OWNER_ON=1
check_session() {   # label upn cache scopes required(1|0)
  local label="$1" upn="$2" cache="$3" scopes="$4" req="$5" out
  if [[ -z "$cache" || ! -s "$cache" ]]; then
    if [[ $req == 1 ]]; then bad "$label: no token cache (sign in: README.md, Set up)"; else warn "$label: not signed in"; fi
    return
  fi
  [[ "$(stat -c %a "$cache")" == 600 ]] || bad "$label: cache mode $(stat -c %a "$cache") (chmod 600)"
  if out="$(cd "$KIT" && node whoami.mjs --upn "$upn" --cache "$cache" --scopes "$scopes" --label "$label" 2>&1)"; then ok "$out"
  elif [[ $req == 1 ]]; then bad "$label: $(tail -1 <<<"$out")"
  else warn "$label: $(tail -1 <<<"$out")"; fi
}
mail_cache() { local m="$1" base="$2" who="$3"; [[ -n "$m" ]] && { echo "$m"; return; }; [[ -s "$(dirname "$base")/$who-outlook-cache.json" ]] && echo "$(dirname "$base")/$who-outlook-cache.json" || echo "$base"; }
B_MAIL="$(mail_cache "${BEING_MAIL_CACHE:-}" "$BEING_CACHE" being)"
check_session "Being Teams" "$BEING_UPN" "$BEING_CACHE" "Chat.ReadWrite,ChatMessage.Send,User.Read" 1
check_session "Being Outlook" "$BEING_UPN" "$B_MAIL" "Mail.ReadWrite,Mail.Send,User.Read" "$([[ "${BEING_MAIL_WATCH:-0}" == 1 ]] && echo 1 || echo 0)"
if (( OWNER_ON )); then
  O_MAIL="$(mail_cache "${OWNER_MAIL_CACHE:-}" "$OWNER_CACHE" owner)"
  for c in "$OWNER_CACHE" "$O_MAIL"; do
    [[ "$(real "$c")" == "$(real "$BEING_CACHE")" || "$(real "$c")" == "$(real "$B_MAIL")" ]] && bad "owner and Being share a token cache ($c): they must be separate sessions"
  done
  check_session "Owner Teams" "$OWNER_UPN" "$OWNER_CACHE" "Chat.Read,User.Read" 1
  check_session "Owner Outlook" "$OWNER_UPN" "$O_MAIL" "Mail.Read,User.Read" 1
else
  ok "Owner Teams / Owner Outlook: off (owner access not switched on)"
  [[ -n "${OWNER_CACHE:-}" && -s "${OWNER_CACHE:-}" ]] && warn "an owner token cache exists while owner access is off: delete it or switch owner access on"
fi
for b in BEING_BROWSER_PROFILE OWNER_BROWSER_PROFILE; do
  p="${!b:-}"; [[ -n "$p" ]] || continue
  if [[ ! -d "$p" ]]; then warn "$b: $p not created yet"
  elif [[ "$(stat -c %a "$p")" != 700 ]]; then bad "$b: mode $(stat -c %a "$p") (chmod 700)"
  else ok "$b: present, 0700"; fi
done
[[ -n "${BEING_BROWSER_PROFILE:-}" && -n "${OWNER_BROWSER_PROFILE:-}" && "$(real "$BEING_BROWSER_PROFILE")" == "$(real "$OWNER_BROWSER_PROFILE")" ]] \
  && bad "Being and owner share one browser profile: they must be separate sessions"

NONCE="kv-$(date +%H%M%S)-$RANDOM"; START="$(date -u +%FT%TZ)"
if (( SEND )) && (( FAILS == 0 )); then
  echo "[send: test DM to the owner, read back]"
  msg="Kit check $NONCE: this is a test message from verify.sh."
  (( WAIT_MIN > 0 )) && msg="$msg Please reply: ok $NONCE"
  if out="$(cd "$KIT" && printf '%s\n' "$msg" | node teams-send-dm.mjs --verbatim 2>&1)" && [[ "$out" =~ sent\ to\ ([^ ]+)\ as\ message\ ([^ ]+) ]]; then
    chat="${BASH_REMATCH[1]}"; ok "sent ($NONCE)"
    if (cd "$KIT" && node teams-read.mjs --chat "$chat" --top 5 2>/dev/null) | grep -qF "$NONCE"; then ok "read back from the chat"
    else bad "sent message not found when reading the chat back"; fi
  else bad "send failed: $(tail -1 <<<"$out")"; fi
  echo "[blocker path]"
  before=$(wc -l <"$BEING_STATE_DIR/blockers.jsonl" 2>/dev/null || echo 0)
  if out="$("$KIT/being-blocker" "kit verify $NONCE" "none: this is a test of the blocker path" "nothing; ignore this message" 2>&1)"; then
    after=$(wc -l <"$BEING_STATE_DIR/blockers.jsonl" 2>/dev/null || echo 0)
    (( after > before )) && ok "blocker logged and $out" || bad "blocker not logged"
  else bad "being-blocker failed: $(tail -1 <<<"$out")"; fi
  if (( WAIT_MIN > 0 )); then
    echo "[reply: waiting up to $WAIT_MIN min for 'ok $NONCE' through the watcher]"
    log="${BEING_COMMS_LOG:-$BEING_STATE_DIR/comms.jsonl}"; got=0
    for ((i = 0; i < WAIT_MIN * 12; i++)); do
      if [[ -f "$log" ]] && python3 -c 'import json,sys
for l in open(sys.argv[1]):
    try: e=json.loads(l)
    except ValueError: continue
    if e.get("dir")=="in" and sys.argv[2] in (e.get("text") or "") and (e.get("loggedAt") or "")>=sys.argv[3]: sys.exit(0)
sys.exit(1)' "$log" "$NONCE" "$START"; then got=1; break; fi
      sleep 5
    done
    (( got )) && ok "reply detected and logged by the watcher" || bad "no reply seen in $WAIT_MIN min (is the watcher running?)"
  fi
elif (( SEND )); then echo "[send] skipped: fix the FAILs above first"
else echo "[send] skipped (--no-send)"; fi

echo "[services]"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  for u in "$BEING_NAME-teams.service" "$BEING_NAME-deadman.timer" graph-webhook.service graph-subscribe.timer graph-lifecycle.path \
           "$BEING_NAME-session.service" "$BEING_NAME-heartbeat.timer" "cloudflared-$BEING_NAME.service" rdp-session-reap.timer; do
    en="$(systemctl --user is-enabled "$u" 2>/dev/null || true)"
    case "$en" in
      enabled) systemctl --user is-active -q "$u" && ok "$u: enabled, active" || bad "$u: enabled but $(systemctl --user is-active "$u" 2>/dev/null || true)" ;;
      disabled) warn "$u: installed but not enabled (installed is not running)" ;;
      *) [[ "$u" == "$BEING_NAME-teams.service" ]] && warn "$u: not installed (being-teams autostart on)" ;;
    esac
  done
else warn "no systemd user session: services not checked"; fi
loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q '=yes' && ok "linger on" \
  || bad "linger off: services stop at logout and stay down after a reboot (admin: sudo loginctl enable-linger $(id -un))"

echo "verify: $OKS ok, $WARNS warn, $FAILS fail"
(( FAILS == 0 ))
