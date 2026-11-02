#!/usr/bin/env bash
# kit-install.sh <being-home> [--name <being>]: install the standalone job runner and the session, poller and heartbeat
# unit templates. Additive; nothing is enabled (README.md, "Switch on").
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=../../scripts/kit-lib.sh
. "$SRC/../../scripts/kit-lib.sh"
kit_args "$@" || exit 2
DST="$HOME_DIR/ops/runner"; UNITS="$(kit_unit_dir)"; BINDIR="$HOME/.local/bin"
kit_copy "$SRC" "$DST" being-job being-blocker being-heartbeat heavy-lock env.example README.md
ENVF="$HOME/.config/being-runner/env"
if [[ ! -e "$ENVF" ]]; then
  mkdir -p "$(dirname "$ENVF")"; chmod 700 "$(dirname "$ENVF")"
  kit_render "$SRC/env.example" "$ENVF" BEING_NAME="$BEING" WORKSPACE="$HOME_DIR" RUNNER="$DST"
  chmod 600 "$ENVF"
fi
for u in being-session.service being-poller.service being-heartbeat.service being-heartbeat.timer; do
  kit_render "$KIT_REPO/templates/kit/units/$u" "$UNITS/$BEING-${u#being-}" BEING_NAME="$BEING" WORKSPACE="$HOME_DIR" RUNNER="$DST"
done
# Commands on PATH, unless another runner (e.g. the Teams kit's) already owns the name.
mkdir -p "$BINDIR"
for f in being-job being-blocker heavy-lock; do
  if [[ ! -e "$BINDIR/$f" ]]; then ln -s "$DST/$f" "$BINDIR/$f"
  elif [[ "$(readlink -f "$BINDIR/$f")" != "$(readlink -f "$DST/$f")" ]]; then kit_say "kept $BINDIR/$f (points elsewhere)"; fi
done
kit_summary "runner"
kit_say "settings: $ENVF (set BEING_BLOCKER_SEND); units in $UNITS are off: systemctl --user enable --now $BEING-session $BEING-heartbeat.timer"
loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q '=yes' || kit_say "WARN linger is off: ask an admin for 'sudo loginctl enable-linger $(id -un)'"
