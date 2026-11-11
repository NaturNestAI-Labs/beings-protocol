#!/usr/bin/env bash
# kit-install.sh <being-home> [--name <being>]: box side of the desktop (session-end script + reap timer) under
# ops/desktop/. The laptop side is `being-desktop install <being>` on the owner's laptop. Nothing is enabled.
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=../../scripts/kit-lib.sh
. "$SRC/../../scripts/kit-lib.sh"
kit_args "$@" || exit 2
DST="$HOME_DIR/ops/desktop"
cfg() { if [[ -f "$HOME_DIR/being.toml" ]]; then "$KIT_REPO/scripts/being-config" --file "$HOME_DIR/being.toml" get "$1" "$2"; else echo "$2"; fi; }
kit_copy "$SRC" "$DST" being-desktop rdp-session-end.sh README.md
mkdir -p "$HOME/.local/bin"
[[ -e "$HOME/.local/bin/rdp-session-end" ]] || ln -s "$DST/rdp-session-end.sh" "$HOME/.local/bin/rdp-session-end"
for u in rdp-session-reap.service rdp-session-reap.timer; do
  kit_render "$SRC/$u" "$(kit_unit_dir)/$u" DESKTOP="$DST" REAP_GRACE="$(cfg desktop.reap_grace_sec 600)" RDP_PORT="$(cfg box.rdp_port 3389)"
done
kit_summary "desktop (box side)"
kit_say "next: harden-box.sh --desktop (RDP server + firewall), then systemctl --user enable --now rdp-session-reap.timer"
kit_say "owner's laptop: skills/desktop/being-desktop install $BEING --config <being.toml>"
