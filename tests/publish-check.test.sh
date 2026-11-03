#!/usr/bin/env bash
# publish-check.test.sh: templates/kit/guards/publish-check.sh on a throwaway repo. Fail-closed checks always run;
# the scan checks need gitleaks and trufflehog on PATH (skipped, and reported, without them).
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
PC="$REPO/templates/kit/guards/publish-check.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
export PUBLISH_CHECK_CONFIG="$TMP/cfg" GIT_CONFIG_GLOBAL=/dev/null; mkdir -p "$TMP/cfg"
cd "$TMP" && git init -q r && cd r && git config user.email t@example.test && git config user.name t
echo "hello" >a.txt && git add a.txt && git commit -qm base

rc=0; GITLEAKS=/nonexistent "$PC" HEAD >/dev/null 2>&1 || rc=$?
[[ $rc == 2 ]] && ok "missing gitleaks fails closed (exit 2)" || bad "missing gitleaks: exit $rc"
rc=0; (cd "$TMP" && "$PC" HEAD >/dev/null 2>&1) || rc=$?
[[ $rc == 2 ]] && ok "outside a repo fails closed (exit 2)" || bad "outside a repo: exit $rc"

if ! command -v gitleaks >/dev/null || ! command -v trufflehog >/dev/null; then
  echo "  SKIP scan checks: gitleaks and trufflehog not on PATH"
else
  rc=0; "$PC" HEAD >/dev/null 2>&1 || rc=$?
  [[ $rc == 0 ]] && ok "clean commit passes" || bad "clean commit: exit $rc"
  printf "server at %s.%s.%s.%s\n" 10 1 2 3 >b.txt && git add b.txt && git commit -qm ip
  rc=0; out=$("$PC" HEAD~1..HEAD 2>&1) || rc=$?
  [[ $rc == 1 && $out == *private-ip* ]] && ok "private IP blocks (exit 1)" || bad "private IP: exit $rc"
  echo 'internal.example\.org' >"$TMP/cfg/deny.txt"
  echo "see wiki.internal.example.org" >c.txt && git add c.txt && git commit -qm host
  rc=0; out=$("$PC" HEAD~1..HEAD 2>&1) || rc=$?
  [[ $rc == 1 && $out == *deny:1* ]] && ok "deny.txt words block" || bad "deny.txt: exit $rc"
  echo 'wiki\.internal' >"$(git rev-parse --git-common-dir)/publish-check-allow"
  rc=0; "$PC" HEAD~1..HEAD >/dev/null 2>&1 || rc=$?
  [[ $rc == 0 ]] && ok "a reviewed allow line clears it" || bad "allow line: exit $rc"
  tok=$(printf '{"a":"%s","t":"0a1b2c3d-0000-4000-8000-123456789abc","s":"c2VjcmV0c2VjcmV0c2VjcmV0"}' "$(printf 'f%.0s' {1..32})" | base64 -w0)
  echo "token: $tok" >d.txt && git add d.txt && git commit -qm tok
  rc=0; out=$("$PC" HEAD~1..HEAD 2>&1) || rc=$?
  [[ $rc == 1 && $out == *cloudflare-tunnel-token* ]] && ok "Cloudflare tunnel token blocks" || bad "tunnel token: exit $rc"
  rc=0; printf 'refs/heads/main %s refs/heads/main %s\n' "$(git rev-parse HEAD)" "$(git rev-parse HEAD~1)" | "$PC" --pre-push origin >/dev/null 2>&1 || rc=$?
  [[ $rc == 1 ]] && ok "pre-push mode scans the pushed range" || bad "pre-push: exit $rc"
fi
echo "publish-check: $fails failure(s)"
[[ $fails == 0 ]]
