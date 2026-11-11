#!/usr/bin/env bash
# kit-install.sh <being-home> [--name <being>]: add being-tunnel (run on the admin box, not the Being's box) and its
# connector unit template under ops/tunnel/. Creates nothing in Cloudflare (README.md).
set -euo pipefail
SRC="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# shellcheck source=../../scripts/kit-lib.sh
. "$SRC/../../scripts/kit-lib.sh"
kit_args "$@" || exit 2
DST="$HOME_DIR/ops/tunnel"
kit_copy "$SRC" "$DST" being-tunnel cloudflared-tunnel.service.example README.md
mkdir -p "$HOME/.local/bin"
[[ -e "$HOME/.local/bin/being-tunnel" ]] || ln -s "$DST/being-tunnel" "$HOME/.local/bin/being-tunnel"
kit_summary "tunnel"
kit_say "next (admin box): being-tunnel create $BEING --config $HOME_DIR/being.toml --record $DST/tunnel-$BEING.json"
