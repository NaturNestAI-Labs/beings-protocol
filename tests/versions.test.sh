#!/usr/bin/env bash
# versions: install.sh versions, the top CHANGELOG entry and the update command agree.
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
unset TMUX TMUX_PANE INVOCATION_ID   # a live tmux server or systemd unit must not reach the test
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
pv="$(sed -n 's/^PROTOCOL_VERSION="\(.*\)"/\1/p' "$REPO/install.sh")"
kv="$(sed -n 's/^KIT_VERSION="\(.*\)"/\1/p' "$REPO/install.sh")"
[[ $pv =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $kv =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] && ok "semantic versions ($pv, kit $kv)" || bad "versions: '$pv' '$kv'"
top="$(grep -m1 -E '^## \[[0-9]+\.[0-9]+\.[0-9]+\]' "$REPO/CHANGELOG.md" || true)"
[[ $top == "## [$pv]"*"(kit $kv)"* ]] && ok "CHANGELOG top entry matches" || bad "CHANGELOG top entry '$top' != $pv / kit $kv"
grep -q "^\*\*v$pv " "$REPO/docs/PROTOCOL_SPEC.md" && ok "PROTOCOL_SPEC changelog names v$pv" || bad "PROTOCOL_SPEC changelog lacks v$pv"
# update: the changelog filter prints only entries newer than the installed version
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/w/.beings" "$T/w/bin" "$T/srv"; cp "$REPO/install.sh" "$REPO/CHANGELOG.md" "$T/srv/"
echo 0.4.0 >"$T/w/.beings/.protocol-version"; echo 0.2.0 >"$T/w/.beings/.kit-version"
cp "$REPO/templates/kit/bin/being" "$T/w/bin/nova"; chmod +x "$T/w/bin/nova"
out="$(cd "$T/w" && BEINGS_BASE_URL="file://$T/srv" BEING_KIT_HOME="$T/none" bin/nova update --check 2>&1)" && rc=0 || rc=$?
[[ $rc == 10 ]] && grep -q "## \[$pv\]" <<<"$out" && ! grep -q '## \[0.4.0\]' <<<"$out" && ok "update --check: newer entries only, exit 10" || bad "update --check (rc $rc): $out"
echo "$pv" >"$T/w/.beings/.protocol-version"; echo "$kv" >"$T/w/.beings/.kit-version"
out="$(cd "$T/w" && BEINGS_BASE_URL="file://$T/srv" BEING_KIT_HOME="$T/none" bin/nova update --check 2>&1)" && rc=0 || rc=$?
[[ $rc == 0 ]] && grep -q 'up to date' <<<"$out" && ok "update --check: up to date" || bad "update up to date (rc $rc): $out"
echo "versions: $fails failure(s)"; (( fails == 0 ))
