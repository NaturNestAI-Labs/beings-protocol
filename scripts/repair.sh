#!/usr/bin/env bash
# repair.sh [<being-home>] [--name <being>] [--shared-sessions <dir>] [--dry-run]: make a Being work again on this
# machine after an OS switch or reinstall. Idempotent; rebuilds only per-machine pieces (the home itself is shared).
set -euo pipefail
HOME_DIR="" BEING="" SHARED="${BEING_SHARED_SESSIONS:-}" DRY=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) BEING="${2:?}"; shift 2 ;;
    --shared-sessions) SHARED="${2:?}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    -h|--help) sed -n '2,3p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) HOME_DIR="$1"; shift ;;
  esac
done
HOME_DIR="$(cd "${HOME_DIR:-.}" && pwd -P)"
[[ -d "$HOME_DIR/.beings" ]] || { echo "no .beings/ in $HOME_DIR: pass the Being's home" >&2; exit 2; }
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
if [[ -z "$BEING" && -f "$HOME_DIR/being.toml" ]]; then BEING="$("$HERE/being-config" --file "$HOME_DIR/being.toml" get being.name 2>/dev/null || true)"; fi
if [[ -z "$BEING" && -f "$HOME_DIR/ops/teams-kit/.env" ]]; then
  # shellcheck source=/dev/null
  BEING="$(set -a; . "$HOME_DIR/ops/teams-kit/.env" >/dev/null 2>&1; printf '%s' "${BEING_NAME:-}")"
fi
[[ "$BEING" =~ ^[a-z][a-z0-9-]*$ ]] || { echo "Being name unknown: pass --name <being>" >&2; exit 2; }
run() { if (( DRY )); then printf '  + %s\n' "$*"; else "$@"; fi; }
export PATH="$HOME/.local/bin:$PATH"
echo "repair: $BEING at $HOME_DIR$( (( DRY )) && echo ' (dry run)')"

echo "[1/6] ~/.local/bin on PATH"
grep -qs '.local/bin' "$HOME/.profile" || { (( DRY )) && echo "  + add PATH line to ~/.profile" || echo 'export PATH="$HOME/.local/bin:$PATH"' >>"$HOME/.profile"; }

echo "[2/6] basic-memory"
if ! command -v basic-memory >/dev/null; then
  if command -v uv >/dev/null; then run uv tool install basic-memory
  elif command -v pipx >/dev/null; then run pipx install basic-memory
  else run python3 -m pip install --user basic-memory; fi
fi
echo "  $(command -v basic-memory || echo 'not installed (dry run)')"

echo "[3/6] memory project '$BEING' -> $HOME_DIR/memory-graph"
if command -v basic-memory >/dev/null && [[ -d "$HOME_DIR/memory-graph" ]]; then
  line="$(basic-memory project list 2>/dev/null | grep -E "(^|[^a-z0-9-])$BEING([^a-z0-9-]|$)" || true)"
  if [[ -z "$line" ]]; then run basic-memory project add "$BEING" "$HOME_DIR/memory-graph"
  elif [[ "$line" != *"$HOME_DIR/memory-graph"* ]]; then echo "  WARN project '$BEING' points elsewhere; fix with: basic-memory project remove $BEING && re-run"; fi
  run basic-memory reindex -p "$BEING" || echo "  WARN reindex failed; run: basic-memory reindex -p $BEING"
else echo "  skipped (no basic-memory or no memory-graph/)"; fi

echo "[4/6] Claude session store"
slug="$(printf '%s' "$HOME_DIR" | sed 's#[/.]#-#g')"; link="$HOME/.claude/projects/$slug"
if [[ -n "$SHARED" ]]; then
  run mkdir -p "$SHARED" "$HOME/.claude/projects"
  if [[ -e "$link" && ! -L "$link" ]]; then run cp -an "$link/." "$SHARED/"; run mv "$link" "$link.bak-premerge"; fi
  [[ -L "$link" ]] || run ln -s "$SHARED" "$link"
  echo "  $link -> $SHARED"
else echo "  local ($link); pass --shared-sessions <dir> to share transcripts between OSes"; fi

echo "[5/6] Teams kit packages"
if [[ -f "$HOME_DIR/ops/teams-kit/package.json" ]]; then
  if [[ -d "$HOME_DIR/ops/teams-kit/node_modules/@azure/msal-node" ]]; then echo "  ok"
  else (cd "$HOME_DIR/ops/teams-kit" && run npm install --no-audit --no-fund); fi
else echo "  no Teams kit"; fi

echo "[6/6] services"
if command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
  run systemctl --user daemon-reload
  udir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  for f in $(grep -lsF "$HOME_DIR" "$udir"/*.service "$udir"/*.timer "$udir"/*.path 2>/dev/null || true); do
    u="$(basename "$f")"
    systemctl --user is-enabled -q "$u" 2>/dev/null || continue
    [[ "$u" == *.service ]] && [[ -e "$udir/${u%.service}.timer" ]] && continue   # started by its timer
    printf '  %-36s %s\n' "$u" "$(systemctl --user is-active "$u" 2>/dev/null || true)"
  done
  loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q '=yes' || echo "  WARN linger is off: ask an admin for 'sudo loginctl enable-linger $(id -un)'"
else echo "  no systemd user session here"; fi
echo "done. Enabled units that are not active: systemctl --user restart <unit>, then check its log."
