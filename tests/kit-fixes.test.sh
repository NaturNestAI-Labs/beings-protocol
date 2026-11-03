#!/usr/bin/env bash
# kit-fixes: field fixes from Beings on teammates' boxes (CHANGELOG 0.5.0): owner id, persona, attachments, upgrades,
# SSH hardening, suspend, xrdp, cron time. No network, no sudo, no live services.
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
unset TMUX TMUX_PANE
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TK="$REPO/skills/teams-kit"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }

# 1. Empty OWNER_OID: the handler and the watcher refuse to start (else the owner runs as a teammate).
mkdir -p "$T/kit/state"
printf "BEING_NAME=nova\nBEING_STATE_DIR='%s'\nOWNER_OID=\n" "$T/kit/state" >"$T/kit/.env"
rc=0; BEING_KIT_HOME="$T/kit" bash "$TK/being-handle" triage </dev/null >/dev/null 2>"$T/err" || rc=$?
[[ $rc == 78 ]] && grep -q OWNER_OID "$T/err" && ok "being-handle refuses an empty OWNER_OID" || bad "being-handle with empty OWNER_OID: rc $rc"
rc=0; BEING_KIT_HOME="$T/kit" BEING_TEAMS_SYSTEMD=0 bash "$TK/being-teams" up </dev/null >/dev/null 2>"$T/err" || rc=$?
[[ $rc == 78 ]] && ok "being-teams up refuses an empty OWNER_OID" || bad "being-teams up with empty OWNER_OID: rc $rc"
grep -q 'OWNER_OID OWNER_DM_CHAT' "$TK/verify.sh" && ok "verify.sh requires OWNER_OID and OWNER_DM_CHAT" || bad "verify.sh required list"

# 2. Teammate persona: headings match loosely; no match gives a minimal persona, never an empty one.
out="$(cd "$TK" && BEING_STATE_DIR="$T/kit/state" BEING_NAME=Nova python3 -c '
import soul
a = soul.public_soul("# Nova\n## 2. Identity 🌱\nI am Nova.\n## Private notes\nsecret\n")
b = soul.public_soul("# Nova\n## Who I am\nx\n")
print("A" if "I am Nova." in a and "secret" not in a else "a-bad")
print("B" if "not anyone'"'"'s assistant" in b else "b-bad")' 2>/dev/null)"
[[ $out == $'A\nB' ]] && ok "persona: loose heading match, minimal fallback" || bad "persona: $out"

# 3. Attachments: a teammate lane may open only its own chat's folder.
own="team-$(printf '%s' '19:x' | sha1sum | cut -c1-10)"
fence() { printf '%s' "$1" | BEING_LANE='team:19:x' BEING_STATE_DIR=/srv/b/state OWNER_NAME='Sam Lee' python3 "$TK/team-fence.py" >/dev/null 2>&1 && echo allow || echo block; }
r1="$(fence "{\"tool_name\":\"Read\",\"tool_input\":{\"file_path\":\"/srv/b/state/attachments/$own/a.pdf\"},\"cwd\":\"/tmp\"}")"
r2="$(fence '{"tool_name":"Read","tool_input":{"file_path":"/srv/b/state/attachments/team-0123456789/a.pdf"},"cwd":"/tmp"}')"
r3="$(fence '{"tool_name":"Bash","tool_input":{"command":"ls /srv/b/state/attachments"},"cwd":"/tmp"}')"
r4="$(fence '{"tool_name":"Bash","tool_input":{"command":"echo the attachments are below"},"cwd":"/tmp"}')"
[[ "$r1 $r2 $r3 $r4" == "allow block block allow" ]] && ok "fence: own attachments only" || bad "fence attachments: $r1 $r2 $r3 $r4"
grep -q "'attachments', laneDir(process.env.BEING_LANE)" "$TK/teams-fetch-attachment.mjs" && ok "fetch saves per lane" || bad "fetch path"

# 4. Upgrades: a local edit is labelled LOCAL CHANGES, an untouched file "upstream only".
( set +u; . "$REPO/scripts/kit-lib.sh"
  d="$T/up"; mkdir -p "$d"
  for f in a b; do echo v1 >"$T/$f.new"; kit_place "$T/$f.new" "$d/$f"; done
  echo "owner fix" >>"$d/a"
  for f in a b; do echo v2 >"$T/$f.new"; kit_place "$T/$f.new" "$d/$f"; done
  for f in a b; do echo v3 >"$T/$f.new"; kit_place "$T/$f.new" "$d/$f"; done   # a second update keeps one line per file
  echo "$KIT_LOCAL" >"$T/local" )
c="$T/up/.kit-upgrade/CHANGES.txt"
grep -qP '^a\tLOCAL CHANGES' "$c" && grep -qP '^b\tupstream only' "$c" && [[ $(wc -l <"$c") == 2 ]] && [[ $(cat "$T/local") -ge 1 ]] \
  && grep -q 'owner fix' "$T/up/a" && ok "manifest: local edits flagged, kept, one line per file" || bad "manifest: $(cat "$c" 2>/dev/null)"

# A pre-manifest upgrade must stage the first changed file without aborting the component.
legacy="$T/legacy"; mkdir -p "$legacy/ops/tunnel" "$T/legacy-home"
printf 'local edit\n' >"$legacy/ops/tunnel/being-tunnel"
rc=0
HOME="$T/legacy-home" bash "$REPO/skills/tunnel/kit-install.sh" "$legacy" --name nova >"$T/legacy.out" 2>&1 || rc=$?
if [[ $rc == 0 ]] && grep -qx 'local edit' "$legacy/ops/tunnel/being-tunnel" \
  && cmp -s "$REPO/skills/tunnel/being-tunnel" "$legacy/ops/tunnel/.kit-upgrade/being-tunnel" \
  && grep -qP '^being-tunnel\tLOCAL CHANGES' "$legacy/ops/tunnel/.kit-upgrade/CHANGES.txt"; then
  ok "pre-manifest component upgrade: succeeds, keeps local edit, stages and flags upstream"
else bad "pre-manifest component upgrade: rc $rc"; fi

# 5. Box hardening (dry run): our SSH file sorts before cloud-init's, suspend masked, xrdp path on request.
printf '[being]\nname = "nova"\nlinux_user = "%s"\n[box]\noffice_subnet = "192.0.2.0/24"\n' "$(id -un)" >"$T/h.toml"
"$REPO/scripts/harden-box.sh" --config "$T/h.toml" --desktop --rdp xrdp --dry-run >"$T/h.out" 2>&1 || true
grep -q '01-being-harden.conf' "$T/h.out" && ! grep -q '60-being-harden.conf (mode' "$T/h.out" && ok "ssh: 01-being-harden.conf" || bad "ssh file name"
grep -q 'systemctl mask sleep.target suspend.target' "$T/h.out" && ok "suspend masked" || bad "suspend not masked"
grep -q 'apt-get install -y xrdp' "$T/h.out" && grep -q '45-being-colord.rules' "$T/h.out" && ok "xrdp path" || bad "xrdp path"

# 6. Memory backup on cron: the time is converted to box time; no CRON_TZ line.
mkdir -p "$T/bin" "$T/mh/ops/teams-kit"
printf '#!/bin/sh\n[ "$1" = -l ] && exit 0\ncat >"%s"\n' "$T/crontab.out" >"$T/bin/crontab"; chmod +x "$T/bin/crontab"
TZ=UTC PATH="$T/bin:$PATH" BEING_HOME="$T/mh" BEING_NAME=nova BEING_TZ=Asia/Kolkata BEING_SYNC_AT=22:00 \
  bash "$REPO/skills/memory/bin/being-memory-sync" install --cron >/dev/null 2>&1 || true
grep -q '^30 16 \* \* \* ' "$T/crontab.out" 2>/dev/null && ! grep -q CRON_TZ "$T/crontab.out" && ok "cron in box time (22:00 IST = 16:30 UTC)" \
  || bad "cron line: $(cat "$T/crontab.out" 2>/dev/null)"

# 7. Run on a Being's box, a test must not reach the live Being: every shell test drops BEING_*/OWNER_*/HOOK_* first.
miss=""; for f in "$REPO"/tests/*.test.sh; do grep -qF "grep -E '^(BEING_|OWNER_|M365_|HOOK_)'" "$f" || miss+=" $(basename "$f")"; done
[[ -z $miss ]] && ok "tests drop the host Being's environment" || bad "tests keep the host environment:$miss"

echo "kit-fixes: $fails failure(s)"; (( fails == 0 ))
