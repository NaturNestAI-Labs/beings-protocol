#!/usr/bin/env bash
# migrate.sh [--apply | --enable | --check]: the KIT-USER half of the users layout (no root), after setup-users.sh.
# No flag = dry run; the flags and the undo (rollback.sh) are described in isolation/README.md.
set -euo pipefail
KIT="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
set -a; . "$KIT/.env"; set +a
B=${BEING:-${BEING_NAME,,}}; KU=$(id -un); AI=${MODEL_USER:-$B-ai}; TM=${TEAM_USER:-$B-team}; WSG=${WS_GROUP:-$B-ws}
STATE=${BEING_STATE_DIR:?}; WS=$(readlink -f "${BEING_WORKSPACE:-$KIT/../..}")
SRV=/srv/$B; TEAMROOT=/srv/$B-team; ETC=/etc/$B; LIBEXEC=/usr/local/libexec/$B
MODE=dry; case "${1:-}" in --apply) MODE=apply ;; --enable) MODE=enable ;; --check) exec "$KIT/isolation/verify.sh" ;; "") ;; *) echo "usage: $0 [--apply|--enable|--check]" >&2; exit 2 ;; esac
run() { if [[ $MODE == dry ]]; then printf '  '; printf '%q ' "$@"; echo; else echo "+ $*"; "$@"; fi; }
note() { echo "# $*"; }
have() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  --   $1"; return 1; fi; }
[[ $KU != root ]] || { echo "migrate.sh runs as the kit user, not root" >&2; exit 1; }

note "preflight (root half: isolation/setup-users.sh)"
ready=1
have "model user $AI exists" "id $AI" || ready=0
have "team user $TM exists" "id $TM" || ready=0
have "group $WSG has $KU" "id -nG $KU | tr ' ' '\n' | grep -qx $WSG" || ready=0
have "sudo: $KU may start processes as $AI" "sudo -n -u $AI true" || ready=0
have "model-run at $LIBEXEC/model-run (root-owned)" "test -x $LIBEXEC/model-run && test \$(stat -c %U $LIBEXEC/model-run) = root" || ready=0
have "$SRV/{run,kit-bin,claude} and $TEAMROOT exist" "test -d $SRV/run -a -d $SRV/kit-bin -a -d $SRV/claude -a -d $TEAMROOT" || ready=0
have "bwrap works for $AI" "sudo -n -u $AI bwrap --ro-bind / / true" || ready=0
if [[ $MODE != dry && $ready == 0 ]]; then echo "setup-users.sh (root) has not run yet; dry run only" >&2; exit 3; fi

if [[ $MODE == dry || $MODE == apply ]]; then
note "1. the kit user's home: nothing for 'other'; $AI may traverse to the workspace (ACL, no listing)"
echo "  other-accessible entries now: $(find "$HOME" -xdev -perm /o=rwx 2>/dev/null | wc -l)"
run chmod -R o-rwx "$HOME"
run setfacl -m "u:$AI:--x" "$HOME" "$(dirname "$WS")"

note "2. workspace shared by group $WSG (setgid dirs, group-writable; the model runs with umask 002)"
run find "$WS" -xdev -path "$WS/.secrets" -prune -o -exec chgrp -h "$WSG" {} +
run find "$WS" -xdev -path "$WS/.secrets" -prune -o ! -type l -exec chmod g+rwX {} +
run find "$WS" -xdev -path "$WS/.secrets" -prune -o -type d -exec chmod g+s {} +
run git -C "$WS" config core.sharedRepository group
note "   .secrets stays the kit user's (0700). Only .secrets/model/ (create it, move model-usable keys there) is shared"
if [[ -d $WS/.secrets/model ]]; then
  run chgrp "$WSG" "$WS/.secrets" "$WS/.secrets/model"; run chmod 0710 "$WS/.secrets"; run chmod -R g+rX,g-w "$WS/.secrets/model"
fi
for f in "$WS"/.beings/daemon/.token-cache-*.json; do
  [[ -f $f && ! -L $f ]] || continue
  note "   a kit token cache inside the workspace moves to kit state (symlink left for kit-user scripts)"
  run mv "$f" "$STATE/ws-$(basename "$f" | sed 's/^\.//')"
  run ln -s "$STATE/ws-$(basename "$f" | sed 's/^\.//')" "$f"
done

note "3. the model client: one install the model users run and cannot change ($SRV/claude, kit-user-owned)"
ver=$(claude --version 2>/dev/null | awk '{print $1}')
run npm install -g --prefix "$SRV/claude" "@anthropic-ai/claude-code@${ver:-latest}"

note "4. $AI's own config (its HOME; transcripts of owner/job runs live there from now on)"
run sudo -n -u "$AI" mkdir -p "/home/$AI/.claude" "/home/$AI/.local/bin"
run sudo -n -u "$AI" sh -c "printf '%s\n' '{\"cleanupPeriodDays\": 3650, \"autoUpdates\": false}' >/home/$AI/.claude/settings.json"
run sudo -n -u "$AI" git config --global --add safe.directory "$WS"
run sudo -n -u "$AI" git config --global core.sharedRepository group
for k in user.name user.email; do v=$(git -C "$WS" config --get "$k" || true); [[ -n $v ]] && run sudo -n -u "$AI" git config --global "$k" "$v"; done
note "   basic-memory for $AI (its own index of the same .beings/; nothing shared with the kit user's index)"
run sudo -n -u "$AI" sh -c "cd && curl -LsSf https://astral.sh/uv/install.sh | sh && ~/.local/bin/uv tool install basic-memory && ~/.local/bin/basic-memory project add $B '$WS/.beings' --default"
note "   hive MCP: .mcp.json points at <kit>/hive-mcp-stdio (kit user: ssh \${BEING_HIVE_SSH} as now; sandbox: the broker shim)"
if [[ -f $WS/.mcp.json ]] && ! grep -q hive-mcp-stdio "$WS/.mcp.json"; then
  run cp -p "$WS/.mcp.json" "$WS/.mcp.json.pre-isolation"
  run python3 -c 'import json,sys; p,k=sys.argv[1:3]; d=json.load(open(p)); d["mcpServers"]["hive"]={"command":k+"/hive-mcp-stdio","args":[]}; json.dump(d,open(p,"w"),indent=2)' "$WS/.mcp.json" "$KIT"
fi

note "5. kit side: nothing the model could change, the shims where the model users can read them"
run chmod -R go-w "$KIT"
run chmod 0700 "$STATE"
run "$KIT/isolation/make-shims" "$SRV/kit-bin"
note "   then run: $0 --check (perms), then the owner: model credentials (README 'Claude Code auth'), then $0 --enable"
fi

if [[ $MODE == dry || $MODE == enable ]]; then
note "--enable: flip the kit .env (backup first)"
ok=1
have "credential for $AI ($ETC/claude-$AI.env non-empty, or its own claude login)" \
  "sudo -n -u $AI sh -c 'test -s $ETC/claude-$AI.env || test -s ~/.claude/.credentials.json'" || ok=0
have "credential for $TM ($ETC/claude-$TM.env non-empty)" "sudo -n -u $TM test -s $ETC/claude-$TM.env" || ok=0
have "being-handle and being-job launch through being-launch (isolation/wire-in.patch applied)" \
  "grep -q being-launch $KIT/being-handle && grep -q being-launch $KIT/being-job" || ok=0
have "public soul for teammate lanes ($STATE/soul-public.md)" "test -s $STATE/soul-public.md" || ok=0
settings=(BEING_ISOLATION=users BEING_MODEL_USER=$AI BEING_TEAM_USER=$TM BEING_SHIM_DIR=$SRV/kit-bin BEING_RUN_DIR=$SRV/run
          BEING_TEAM_ROOT=$TEAMROOT BEING_CLAUDE_BIN=$SRV/claude/bin/claude BEING_CLAUDE_ENV_DIR=$ETC BEING_BROKER_RAW_JOBS=1)
printf '  .env: %s\n' "${settings[@]}"
if [[ $MODE == enable ]]; then
  [[ $ok == 1 ]] || { echo "not enabling: fix the items marked -- above" >&2; exit 3; }
  cp -p "$KIT/.env" "$KIT/.env.bak-isolation-$(date +%y%m%d-%H%M)"
  for s in "${settings[@]}"; do
    k=${s%%=*}
    if grep -q "^$k=" "$KIT/.env"; then sed -i "s#^$k=.*#$s#" "$KIT/.env"; else echo "$s" >>"$KIT/.env"; fi
  done
  echo "enabled. Next: $KIT/being-teams restart, then $0 --check and one test message per lane."
fi
fi
