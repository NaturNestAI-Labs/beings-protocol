#!/usr/bin/env bash
# kit-install.sh <being-home> [--name <being>]: add the Graph webhook to an installed Teams kit (ops/teams-kit/webhook/),
# create the client-state secret and settings file, write the units. Nothing is enabled (README.md, "Switch on").
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=../../../scripts/kit-lib.sh
. "$SRC/../../../scripts/kit-lib.sh"
kit_args "$@" || exit 2
KIT="$HOME_DIR/ops/teams-kit"
[[ -d "$KIT" ]] || { echo "no Teams kit in $KIT; install it first (install.sh --with teams-kit)" >&2; exit 2; }
HOOK_STATE="${HOOK_STATE:-$HOME/.local/state/graph-webhook}"
kit_copy "$SRC" "$KIT/webhook" graph-webhook.mjs graph-subscribe.mjs graph-webhook.test.mjs hook-wait env.example README.md
mkdir -p "$HOOK_STATE"; chmod 700 "$HOOK_STATE"
if [[ ! -s "$HOOK_STATE/client-state" ]]; then
  # Random secret Graph echoes back on every notification; it never leaves this box except inside the subscription.
  (umask 077; head -c 96 /dev/urandom | base64 | tr -d '/+=\n' | cut -c1-64 >"$HOOK_STATE/client-state")
  kit_say "created $HOOK_STATE/client-state (0600)"
fi
ENVF="$HOME/.config/graph-webhook/env"
if [[ ! -e "$ENVF" ]]; then
  mkdir -p "$(dirname "$ENVF")"; chmod 700 "$(dirname "$ENVF")"
  kit_render "$SRC/env.example" "$ENVF" BEING_NAME="$BEING" && chmod 600 "$ENVF"
fi
for u in graph-webhook.service graph-subscribe.service graph-subscribe-renew.service graph-subscribe.timer graph-lifecycle.path; do
  kit_render "$SRC/units/$u" "$(kit_unit_dir)/$u" KIT="$KIT" HOOK_STATE="$HOOK_STATE"
done
kit_summary "webhook"
kit_say "next: set HOOK_PUBLIC in $ENVF, publish the route (README.md), then enable the units"
