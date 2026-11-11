#!/usr/bin/env bash
# rollback.sh [--apply] [--full]: undo the users layout (default: dry run); --full also drops the ACL and workspace group.
# The root part (users, sudoers, /srv, /etc/<being>) is printed for an admin (isolation/README.md).
set -euo pipefail
KIT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
set -a; . "$KIT/.env"; set +a
B=${BEING_NAME,,}; KU=$(id -un); AI=${BEING_MODEL_USER:-$B-ai}; TM=${BEING_TEAM_USER:-$B-team}; WSG=$B-ws
STATE=$BEING_STATE_DIR; WS=$(readlink -f "${BEING_WORKSPACE:-$KIT/../..}")
APPLY=0; FULL=0
for a in "$@"; do case $a in --apply) APPLY=1 ;; --full) FULL=1 ;; *) echo "usage: $0 [--apply] [--full]" >&2; exit 2 ;; esac; done
run() { if (( APPLY )); then echo "+ $*"; "$@"; else printf '  '; printf '%q ' "$@"; echo; fi; }
(( APPLY )) || echo "DRY RUN (nothing changes): $0 --apply [--full]"

echo "# 1. model runs back to the kit user (one line in the kit .env)"
run cp -p "$KIT/.env" "$KIT/.env.bak-rollback-$(date +%y%m%d-%H%M)"
run sed -i 's/^BEING_ISOLATION=.*/BEING_ISOLATION=off/' "$KIT/.env"
echo "# 2. kit token cache back where kit-user scripts expect it"
for l in "$WS"/.beings/daemon/.token-cache-*.json; do
  [[ -L $l ]] || continue; t=$(readlink "$l"); run rm "$l"; run mv "$t" "$l"
done
echo "# 3. .mcp.json"
[[ -f $WS/.mcp.json.pre-isolation ]] && run mv "$WS/.mcp.json.pre-isolation" "$WS/.mcp.json"
if (( FULL )); then
  echo "# 4. traverse ACL and workspace group"
  run setfacl -x "u:$AI" "$HOME" "$(dirname "$WS")"
  run chgrp -R -h "$(id -gn)" "$WS"
fi
echo "# then: $KIT/being-teams restart   (warm lanes pick up the change)"
cat <<EOF

# ROOT part (admin, only to remove the users for good; after the kit-user part above):
sudo rm -f /etc/sudoers.d/$B-isolation && sudo visudo -c
sudo pkill -u $AI; sudo pkill -u $TM
sudo tar czf /root/$B-ai-home-\$(date +%F).tgz -C /home $AI   # its transcripts (owner/job sessions since the switch)
sudo userdel -r $AI; sudo userdel $TM; sudo groupdel $WSG
sudo gpasswd -d $KU $TM 2>/dev/null; sudo groupdel $TM 2>/dev/null
sudo rm -rf /srv/$B /srv/$B-team /etc/$B /usr/local/libexec/$B
EOF
