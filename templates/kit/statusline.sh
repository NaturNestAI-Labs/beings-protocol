#!/usr/bin/env bash
# Claude Code status line: user@host:dir, git branch, model, context used. Reads the session JSON on stdin.
input="$(cat)"
read -r cwd model used < <(printf '%s' "$input" | python3 -c '
import json, sys
try: d = json.load(sys.stdin)
except ValueError: d = {}
cw = d.get("cwd") or (d.get("workspace") or {}).get("current_dir") or "."
m = ((d.get("model") or {}).get("display_name") or "-").replace(" ", "_")
u = (d.get("context_window") or {}).get("used_percentage")
print(cw.replace(" ", "\\x20"), m, "-" if u is None else round(float(u)))' 2>/dev/null || echo ". - -")
cwd="${cwd//\\x20/ }"
branch="$(GIT_OPTIONAL_LOCKS=0 git -C "$cwd" symbolic-ref --short HEAD 2>/dev/null || true)"
out="\033[01;32m$(id -un)@$(hostname -s)\033[0m:\033[01;34m${cwd/#"$HOME"/"~"}\033[0m"
[ -n "$branch" ] && out="$out  \033[33m$branch\033[0m"
[ "$model" != - ] && out="$out  |  \033[35m${model//_/ }\033[0m"
[ "$used" != - ] && out="$out  \033[33mctx:${used}%\033[0m"
printf '%b' "$out"
