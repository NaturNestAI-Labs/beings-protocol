#!/usr/bin/env bash
# install-kit.test.sh: install.sh --with operations,teams-kit in throwaway homes (offline; uses this checkout).
# TEST_BASH=/path/to/bash-3.2 runs install.sh under that shell (macOS default).
# shellcheck disable=SC2015,SC2016  # ok/bad reporting chains; literal $ in owner fixtures is intended
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
# Stub basic-memory so install.sh never bootstraps uv from the network.
mkdir -p "$TMP/stub"; printf '#!/bin/sh\nexit 0\n' >"$TMP/stub/basic-memory"; chmod +x "$TMP/stub/basic-memory"
INSTALL="$REPO/install.sh"
inst() { (cd "$1" && shift && HOME="$TMP/home" PATH="$TMP/stub:$PATH" BEING_NO_SYSTEMD=1 "${TEST_BASH:-bash}" "$INSTALL" "$@" --yes --no-memory) >"$TMP/out" 2>&1; }
plain() { rm -rf "$1"; mkdir -p "$1/.beings"; git -C "$1" init -q; }
# Portable (GNU and BSD/macOS): no stat -c, sed -i or sha256sum.
sum() { if command -v sha256sum >/dev/null; then sha256sum; else shasum -a 256; fi; }
tree() { (cd "$1" && find . -path ./.git -prune -o -type f -print | LC_ALL=C sort | while IFS= read -r f; do printf '%s %s\n' "$(sum <"$f" | cut -c1-64)" "$f"; done); }
is600() { [[ -n "$(find "$1" -prune -perm 0600)" ]]; }   # exact mode, GNU and BSD find
drop_line() { grep -v "$1" "$2" >"$2.tmp" || true; cat "$2.tmp" >"$2"; rm -f "$2.tmp"; }

# 1. The curl file list matches the skill directory and its modes.
if git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  listed=$(bash -c 'source <(sed -n "/^TEAMS_KIT_FILES=(/,/^)/p;/^TEAMS_KIT_EXEC=(/,/^)/p" "$1")
    for f in "${TEAMS_KIT_FILES[@]}"; do echo "100644 $f"; done; for f in "${TEAMS_KIT_EXEC[@]}"; do echo "100755 $f"; done' _ "$REPO/install.sh" | sort)
  actual=$(git -C "$REPO" ls-files -s skills/teams-kit | awk '{ sub("skills/teams-kit/", "", $4); print $1, $4 }' | sort)
  [[ "$listed" == "$actual" ]] && ok "TEAMS_KIT_FILES/EXEC match skills/teams-kit" || bad "kit file list drifted: $(diff <(echo "$listed") <(echo "$actual") | tr '\n' ' ')"
fi

# 2. Hostile owner names: .env sources cleanly, values survive, templates filled literally.
n=0
for owner in "your partner" "Sam O'Brien" "Sam O'Brien & Co" 'A "quoted" $HOME `x` \ name' "Ana/Lee | ops"; do
  home="$TMP/case$((++n))"; plain "$home"
  inst "$home" --update --name nova --with teams-kit --owner "$owner" || { bad "install for [$owner]: $(tail -3 "$TMP/out")"; continue; }
  env="$home/ops/teams-kit/.env"
  got=$(env -i PATH="$PATH" bash -c 'set -euo pipefail; set -a; . "$1"; set +a; printf "%s|%s|%s" "$OWNER_NAME" "$BEING_NAME" "$BEING_STATE_DIR"' _ "$env") \
    && [[ "$got" == "$owner|nova|$(cd "$home" && pwd -P)/ops/teams-kit/state" ]] && ok ".env sources, owner=[$owner]" || bad ".env for [$owner]: got [${got:-source failed}]"
  is600 "$env" && ok ".env is 0600" || bad ".env is not 0600"
  grep -qF -- "$owner" "$home/.beings/AUTONOMY-MATRIX.md" && ok "template owner filled literally" || bad "template owner for [$owner]"
done
awk -F= '/^[A-Z0-9_]+=/{ v=substr($0, index($0,"=")+1); sub(/[ \t]+#.*/, "", v)
  if (v ~ /^'"'"'.*'"'"'$/ || v ~ /^[^ \t'"'"'"$`\\]*$/) next; print "bad line: " $0; bad=1 } END { exit bad }' \
  "$TMP"/case*/ops/teams-kit/.env && ok "all .env lines audited" || bad ".env line audit"

# 3. Kit pieces and executables are in place.
h="$TMP/case1"
for f in .beings/GUARDRAILS.md .beings/AUTONOMY-MATRIX.md .beings/JOB-CHECKLIST.md .beings/facts/_TEMPLATE.md .beings/.kit-version bin/nova; do
  [[ -e "$h/$f" ]] || bad "missing $f"
done
[[ -x "$h/bin/nova" && -x "$h/ops/teams-kit/being-teams" && ! -x "$h/ops/teams-kit/fmt.mjs" ]] && ok "kit files and modes" || bad "kit modes"
grep -qxF "ops/teams-kit/.env" "$h/.gitignore" && ok ".env gitignored" || bad ".env not gitignored"

# 4. Re-run is idempotent; the name comes from the kit .env, not the directory.
before=$(tree "$h")
inst "$h" --update --with teams-kit && [[ "$(tree "$h")" == "$before" ]] && ok "re-run changes nothing (name read from .env)" || bad "re-run changed files: $(tail -3 "$TMP/out")"
# The check above only bites without claude on PATH; this one does not depend on the host.
DT="$(sed -n '/^detect_tools() {/,/^}/p' "$INSTALL")"; BASH_BIN="$(command -v bash)"; mkdir -p "$TMP/dtbin"; ln -s "$(command -v ls)" "$TMP/dtbin/ls"
dt() { (cd "$1" && PATH="$TMP/dtbin" "$BASH_BIN" -c "$DT"'; detect_tools'); }
mkdir -p "$TMP/dt1/.claude" "$TMP/dt2/.claude/skills"; ln -s ../.agents/skills "$TMP/dt1/.claude/skills"
[[ "$(dt "$TMP/dt1")" != *claude-code* && "$(dt "$TMP/dt2")" == *claude-code* ]] && ok "the kit's .claude/skills link alone is not Claude Code" || bad "detect_tools: [$(dt "$TMP/dt1")] [$(dt "$TMP/dt2")]"

# 5. Upgrade never overwrites: edited files stay, upstream versions go to .kit-upgrade/, new .env keys are merged.
echo "# my rule" >>"$h/.beings/GUARDRAILS.md"; echo "// local patch" >>"$h/ops/teams-kit/fmt.mjs"
drop_line '^BEING_DETECT_CHATS=' "$h/ops/teams-kit/.env"; echo "BEING_UPN=me@example.test" >>"$h/ops/teams-kit/.env"
inst "$h" --update --with teams-kit
grep -q "# my rule" "$h/.beings/GUARDRAILS.md" && grep -q "local patch" "$h/ops/teams-kit/fmt.mjs" && ok "user edits kept" || bad "user edits lost"
cmp -s "$h/ops/teams-kit/.kit-upgrade/fmt.mjs" "$REPO/skills/teams-kit/fmt.mjs" && ok "new version staged in .kit-upgrade/" || bad ".kit-upgrade missing"
grep -q '^BEING_DETECT_CHATS=' "$h/ops/teams-kit/.env" && grep -q '^BEING_UPN=me@example.test' "$h/ops/teams-kit/.env" && ok ".env merged, values kept" || bad ".env merge"
# A key that is new upstream (absent from the installed .env.example too) still reaches .env.
drop_line '^BEING_OWNER_DELEGATE=' "$h/ops/teams-kit/.env"; drop_line '^BEING_OWNER_DELEGATE=' "$h/ops/teams-kit/.env.example"
inst "$h" --update --with teams-kit
grep -q '^BEING_OWNER_DELEGATE=0' "$h/ops/teams-kit/.env" && ok "new upstream .env key merged (owner sign-in stays off)" || bad "new upstream key not merged"

# 6. Refusals happen before anything is written.
h="$TMP/noname"; plain "$h"; before=$(tree "$h")
inst "$h" --update --with operations && bad "--update --with without --name should fail" || { [[ "$(tree "$h")" == "$before" ]] && ok "no --name: refused, nothing written" || bad "no --name wrote files"; }
inst "$h" --with operations && bad "--with without --global/--update should fail" || ok "--with alone refused"
inst "$h" --update --name nova --with bogus && bad "unknown component accepted" || ok "unknown component refused"

# 7. --check reports and writes nothing.
before=$(tree "$TMP/case2"); inst "$TMP/case2" --check
grep -q "kit $(sed -n 's/^KIT_VERSION="\(.*\)"/\1/p' "$REPO/install.sh")" "$TMP/out" && [[ "$(tree "$TMP/case2")" == "$before" ]] && ok "--check is read-only" || bad "--check"

# 8. Operations: tools, templates, secrets folder, shared skills, auto-memory link, global guardrails.
h="$TMP/case1"; G="$TMP/home"
for f in bin/being-config bin/being-memory-sync bin/being-session-registry bin/publish-check ops/kit-templates/stack-runner; do
  [[ -x "$h/$f" ]] || bad "not executable: $f"
done
for f in ops/kit-templates/systemd/standby-gate.conf.example ops/kit-templates/jobs/scheduled-job/run.sh ops/kit-templates/being.toml.example; do
  [[ -f "$h/$f" ]] || bad "missing $f"
done
grep -qF "$(cd "$h" && pwd -P)/ops/teams-kit/state/STANDBY" "$h/ops/kit-templates/systemd/standby-gate.conf.example" && ok "unit templates filled with the home path" || bad "unit template placeholders"
[[ "$(find "$G/.config/nova" -prune -perm 0700 | wc -l)" == 1 ]] && ok "secrets folder ~/.config/nova is 0700" || bad "secrets folder"
[[ -L "$h/.claude/skills" && "$(readlink "$h/.claude/skills")" == ../.agents/skills ]] && ok "shared skills folder" || bad "shared skills"
[[ -L "$h/.beings/auto-memory-live" ]] && grep -qxF ".beings/auto-memory-live" "$h/.gitignore" && ok "auto-memory link, gitignored" || bad "auto-memory link"
for f in "$G/.claude/CLAUDE.md" "$G/.codex/instructions.md" "$G/.codex/AGENTS.md"; do
  [[ "$(grep -c 'beings-kit:guardrails begin' "$f" 2>/dev/null)" == 1 ]] || bad "guardrails block count in $f"
done
grep -q "Never claim a check passed" "$G/.claude/CLAUDE.md" && ok "guardrails written once for Claude Code and Codex" || bad "guardrails content"

# 9. --update refreshes the block from .beings/GUARDRAILS.md; text around it is kept.
echo "my own global note" >>"$G/.claude/CLAUDE.md"
echo "10. **House rule.** Always say which box you are on." >>"$h/.beings/GUARDRAILS.md"
inst "$h" --update --with operations
grep -q "House rule" "$G/.claude/CLAUDE.md" && grep -q "House rule" "$G/.codex/instructions.md" && grep -q "my own global note" "$G/.claude/CLAUDE.md" \
  && [[ "$(grep -c 'beings-kit:guardrails begin' "$G/.claude/CLAUDE.md")" == 1 ]] && ok "--update refreshed the guardrails block in place" || bad "guardrails refresh"

# 10. --config being.toml: name, owner, access and components come from the file; flags win.
h="$TMP/cfg"; plain "$h"
cat >"$TMP/being.toml" <<'TOML'
[being]
name = "kira"
owner = "Ana Lee"
track_private = true
[kit]
with = ["operations"]
[access]
owner_chat = true
memory = true
TOML
inst "$h" --update --config "$TMP/being.toml" && [[ -x "$h/bin/kira" ]] && grep -q "Ana Lee" "$h/.beings/AUTONOMY-MATRIX.md" \
  && cmp -s "$TMP/being.toml" "$h/being.toml" && ok "--config: name, owner, components, being.toml copied" || bad "--config: $(tail -3 "$TMP/out")"
! grep -qxF ".beings-local/" "$h/.gitignore" 2>/dev/null && ok "track_private: .beings-local/ not ignored" || bad "track_private"
grep -q "owner_chat, memory" "$TMP/out" && ok "access list shown at install" || bad "access list not shown"
h="$TMP/cfg2"; plain "$h"; inst "$h" --update --config "$TMP/being.toml" --owner "Sam Lee" --name nova
[[ -x "$h/bin/nova" ]] && grep -q "Sam Lee" "$h/.beings/AUTONOMY-MATRIX.md" && ok "flags win over --config" || bad "flag precedence"
printf '[being]\nname = {x = 1}\n' >"$TMP/bad.toml"; h="$TMP/cfg3"; plain "$h"; before=$(tree "$h")
inst "$h" --update --config "$TMP/bad.toml" && bad "bad being.toml accepted" || { [[ "$(tree "$h")" == "$before" ]] && ok "bad being.toml refused, nothing written" || bad "bad config wrote files"; }

# 11. Memory hooks: echo-only reminders removed, recall + date kept, the user's own hooks untouched.
h="$TMP/hooks"; plain "$h"; mkdir -p "$h/.claude"; echo "# CLAUDE.md" >"$h/CLAUDE.md"
cat >"$h/.claude/settings.local.json" <<'JSON'
{"hooks": {
 "PreCompact": [{"matcher": "", "hooks": [{"type": "command", "command": "echo 'MEMORY PRESERVATION: Context is about to be compressed.'"}]}],
 "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "echo 'SESSION END: Write a session summary note'"}]}],
 "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "echo 'AUTONOMY CHECK: Before running this shell command'"}]},
                {"matcher": "Bash", "hooks": [{"type": "command", "command": "my-own-guard"}]}],
 "PostToolUse": [{"matcher": "Write|Edit", "hooks": [{"type": "command", "command": "echo 'MEMORY CHECK: You just modified a file.'"}]}]
}}
JSON
inst "$h" --update --name nova --with operations
python3 - "$h/.claude/settings.local.json" <<'PY' && ok "old reminder hooks removed, own hooks kept" || bad "hook migration: $(cat "$h/.claude/settings.local.json")"
import json, sys
d = json.load(open(sys.argv[1]))["hooks"]
assert sorted(d) == ["PreToolUse", "SessionStart", "UserPromptSubmit"], sorted(d)
assert [c["command"] for h in d["PreToolUse"] for c in h["hooks"]] == ["my-own-guard"]
PY

# 12. Generic component: skills/<name>/ copied to ops/<name>/ and its kit-install.sh hook runs with the settings.
K="$TMP/kitcopy"; mkdir -p "$K"; (cd "$REPO" && tar --exclude=.git --exclude=node_modules -cf - .) | (cd "$K" && tar -xf -)
mkdir -p "$K/skills/demo"; printf '#!/bin/sh
echo demo
' >"$K/skills/demo/demo-tool"; chmod +x "$K/skills/demo/demo-tool"
cat >"$K/skills/demo/kit-install.sh" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s|%s|%s|%s|%s\n' "$1" "$BEING_NAME" "$OWNER_NAME" "$BEING_ACCESS" "$BEING_KIT_UPDATE" >>"$1/ops/demo/hook.log"
HOOK
INSTALL="$K/install.sh"; h="$TMP/comp"; plain "$h"
inst "$h" --update --config "$TMP/being.toml" --with demo
[[ -x "$h/ops/demo/demo-tool" ]] && grep -qF "$(cd "$h" && pwd -P)|kira|Ana Lee|owner_chat,memory|1" "$h/ops/demo/hook.log" \
  && ok "component copied and its hook ran with the settings" || bad "component: $(tail -3 "$TMP/out")"
inst "$h" --update --with nosuchthing && bad "unknown component accepted" || ok "unknown component refused"
INSTALL="$REPO/install.sh"

# 13. Status line: set when absent, an existing one is kept.
h="$TMP/sl"; plain "$h"; rm -f "$G/.claude/settings.json"
inst "$h" --update --name nova --with statusline
grep -q 'beings-statusline.sh' "$G/.claude/settings.json" && [[ -x "$G/.claude/beings-statusline.sh" ]] && ok "status line installed" || bad "status line"
echo '{"statusLine": {"type": "command", "command": "mine"}}' >"$G/.claude/settings.json"
inst "$h" --update --name nova --with statusline; grep -q '"mine"' "$G/.claude/settings.json" && ok "existing status line kept" || bad "status line overwritten"

(( fails == 0 )) && echo "install-kit: all checks passed" || { echo "install-kit: $fails failed"; exit 1; }
