#!/usr/bin/env bash
# kit-install.sh <being-home> [being.toml]: install owner-access into the Being's Teams kit (OWNER_ACCESS_KIT_DIR), with
# every ability off. Never touches an existing owner-access.toml, .env, token cache or browser profile.
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=../../scripts/kit-lib.sh
. "$SRC/../../scripts/kit-lib.sh"
HOME_DIR=${1:?usage: kit-install.sh <being-home> [being.toml]}
TOML=${2:-}; [[ $TOML == --name ]] && TOML=""
[[ -n $TOML ]] || TOML=${BEING_CONFIG_FILE:-}
KIT=${OWNER_ACCESS_KIT_DIR:-$HOME_DIR/ops/teams-kit}
[[ -f $KIT/graph.mjs && -f $KIT/scope.mjs ]] || { echo "owner-access: Teams kit not found at $KIT (install --with teams-kit first)" >&2; exit 1; }

FILES=(oa-env.mjs oa-config.mjs sessions.mjs owner-session.mjs guards.mjs ledger.mjs go-approval.mjs manifest-set.mjs mailbox-lib.mjs channel-lib.mjs
  forward-rules.mjs browser-route.mjs owner-browser.mjs owner-web.mjs shared-mailbox-drafts.mjs shared-inbox-monitor.mjs channel-posts.mjs mail-forward-rules.mjs
  owner-access-doctor.mjs verify-upload.py owner-web owner-access-login owner-access-run shared-inbox-monitor.sh)
kit_copy "$SRC" "$KIT" "${FILES[@]}"
kit_render "$SRC/README.md" "$KIT/OWNER-ACCESS.md"
tmp="$(mktemp)"; install -m 600 "$SRC/owner-access.toml.example" "$tmp"
kit_place "$tmp" "$KIT/owner-access.toml.example"
if [[ ! -e $KIT/shared-inbox-job.md ]]; then
  kit_copy "$SRC" "$KIT" shared-inbox-job.md.example
fi
kit_summary "owner-access"
STATE=$KIT/state
mkdir -p "$STATE/owner-access" "$STATE/sessions"; chmod 700 "$STATE" "$STATE/owner-access" "$STATE/sessions"
grep -qx 'owner-access.toml' "$KIT/.gitignore" 2>/dev/null || echo 'owner-access.toml' >>"$KIT/.gitignore"

echo "owner-access: installed into $KIT (every ability OFF)."
if [[ -n $TOML && -f $TOML ]]; then
  ticked=$(awk '/^\[access\]/{a=1;next} /^\[/{a=0} a && /=[[:space:]]*true/{sub(/[[:space:]]*=.*/,""); print "  " $0}' "$TOML")
  [[ -n $ticked ]] && printf 'being.toml [access] ticks (switch the owner rows on in owner-access.toml by hand):\n%s\n' "$ticked"
fi
cat <<MSG
Next, two SEPARATE sign-ins (own token cache and own browser profile each; never copied between boxes):
  1. Being:  being login being --teams --outlook [--browser]      (or: $KIT/owner-access-login being ...)
  2. Owner:  being login owner --teams --outlook [--browser]      (or: $KIT/owner-access-login owner ...)
     The owner types their own password and code. Needs BEING_OWNER_DELEGATE=1 and OWNER_CACHE in $KIT/.env.
Then: cp $KIT/owner-access.toml.example $KIT/owner-access.toml (chmod 600), switch on only what the owner ticked,
and run: node $KIT/owner-access-doctor.mjs
MSG
