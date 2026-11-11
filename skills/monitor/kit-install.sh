#!/usr/bin/env bash
# Install the monitor into a Being's home: <home>/ops/monitor/monitor.py, run by `being monitor`.
#   kit-install.sh <being-home>
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=../../scripts/kit-lib.sh
. "$SRC/../../scripts/kit-lib.sh"
HOME_DIR=${1:?usage: kit-install.sh <being-home>}
[[ -d "$HOME_DIR/.beings" ]] || { echo "kit-install: $HOME_DIR is not a Being home (no .beings/)" >&2; exit 2; }
command -v python3 >/dev/null || { echo "kit-install: python3 is required" >&2; exit 2; }
DEST="$HOME_DIR/ops/monitor"
mkdir -p "$DEST"
tmp="$(mktemp)"; install -m 755 "$SRC/monitor.py" "$tmp"
kit_place "$tmp" "$DEST/monitor.py"
kit_copy "$SRC" "$DEST" README.md
kit_summary "monitor"
echo "monitor installed: $DEST/monitor.py (run: being monitor, or python3 $DEST/monitor.py --list)"
