#!/usr/bin/env bash
# being-cli.test.sh: the launcher's monitor/access/login/stacks/stack/doctor, being-config, the memory backup,
# session registry and index repair, offline in a throwaway HOME (docker, node, basic-memory and git remote stubbed).
# shellcheck disable=SC2015  # ok/bad reporting chains
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
H="$TMP/home"; W="$TMP/w/nova"; STUB="$TMP/stub"; LOG="$TMP/calls.log"
mkdir -p "$H" "$W/bin" "$W/.beings" "$STUB"
cp "$REPO/templates/kit/bin/being" "$W/bin/nova"
cp "$REPO/templates/kit/bin/being-config" "$REPO/templates/kit/bin/stack-runner" "$REPO/templates/kit/bin/desktop-shim" "$W/bin/"
chmod +x "$W/bin/"*
W="$(cd "$W" && pwd -P)"
CFG=$W/bin/being-config

# docker stub: logs every call; DOCKER_PS / DOCKER_ARMED / DOCKER_CONFIG_RC shape its answers.
cat >"$STUB/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1" in
  ps) if [[ " $* " == *" -a"* || " $* " == *" -aq "* ]]; then printf '%s\n' ${DOCKER_ALL:-}; else printf '%s\n' ${DOCKER_PS:-}; fi ;;
  inspect) printf '%b' "${DOCKER_ARMED:-}" ;;
  compose) [[ " $* " == *" config -q"* ]] && exit "${DOCKER_CONFIG_RC:-0}"; exit 0 ;;
  *) exit 0 ;;
esac
EOF
# node stub: device login writes the cache; the inline who-am-I prints the expected account.
cat >"$STUB/node" <<'EOF'
#!/usr/bin/env bash
echo "node $*" >>"$CALLS"
if [[ "$1" == teams-login-device.mjs ]]; then
  while (( $# )); do [[ "$1" == --cache ]] && { echo '{}' >"$2"; }; shift; done; exit 0
fi
[[ "$1" == --input-type=module ]] && { echo "$V_UPN"; exit 0; }
exit 0
EOF
printf '#!/bin/sh\nexit 0\n' >"$STUB/systemctl"; printf '#!/bin/sh\nexit 1\n' >"$STUB/crontab"
chmod +x "$STUB"/*
run() { env -i HOME="$H" PATH="$STUB:$H/.local/bin:/usr/bin:/bin" CALLS="$LOG" "$@"; }
nova() { run "${EXTRA[@]}" bash "$W/bin/nova" "$@"; }
EXTRA=()

# 1. being-config: TOML subset.
cat >"$TMP/b.toml" <<'EOF'
[being]
name = "nova"   # trailing comment
owner = 'Sam O"Brien'
[access]
owner_chat = true   # inline
being_mail = true
memory = false
[kit]
tags = ["a",
  "b", # inline
]
[kit]
with = ["operations", "monitor"]
EOF
[[ "$("$CFG" "$TMP/b.toml" get being.owner)" == 'Sam O"Brien' ]] && ok "config: literal string" || bad "config literal string"
[[ "$("$CFG" "$TMP/b.toml" list access | paste -sd, -)" == "owner_chat,being_mail" ]] && ok "config: access list (allow + true - false)" || bad "config access list: $("$CFG" "$TMP/b.toml" list access | paste -sd, -)"
[[ "$("$CFG" "$TMP/b.toml" get kit.with | paste -sd, -)" == "operations,monitor" ]] && ok "config: multi-line array" || bad "config array"
[[ "$("$CFG" "$TMP/b.toml" get being.tz fallback)" == fallback ]] && ok "config: default for a missing key" || bad "config default"
printf '[a.b]\nx = 1\n' >"$TMP/dot.toml"; [[ "$("$CFG" "$TMP/dot.toml" get a.b.x)" == 1 ]] && ok "config: dotted table" || bad "dotted table"
printf '[a]\nx = { y = 1 }\n' >"$TMP/bad.toml"; "$CFG" "$TMP/bad.toml" check 2>/dev/null && bad "inline table accepted" || ok "config: unsupported syntax refused"
printf '[a]\nx = {y = 1}\n' >"$TMP/bad2.toml"; "$CFG" "$TMP/bad2.toml" check 2>/dev/null && bad "inline table accepted" || ok "config: inline tables refused"

# 2. stack new: runner generated, registered, never overwritten silently.
mkdir -p "$TMP/app"; touch "$TMP/app/docker-compose.yml"
(cd "$TMP/app" && run bash "$W/bin/nova" stack new shop --url http://localhost:8080 >/dev/null) || bad "stack new failed"
R="$H/.local/bin/shop"; REG="$H/.config/nova/stacks.tsv"
[[ -x "$R" ]] && bash -n "$R" && ok "runner written and parses" || bad "runner missing or broken"
grep -q 'COMPOSE="${SHOP_COMPOSE:-docker-compose.yml}"' "$R" && grep -q "DIR=\"\${SHOP_HOME:-$(cd "$TMP/app" && pwd -P)}\"" "$R" \
  && ok "runner: SHOP_HOME override, compose file detected" || bad "runner placeholders"
grep -q $'^shop\tshop\tshop$' "$REG" && ok "registered in stacks.tsv" || bad "registry line"
nova stack new shop >/dev/null 2>&1 && bad "existing runner overwritten" || ok "existing runner kept without --force"
nova stack new 'Bad Name' >/dev/null 2>&1 && bad "bad app name accepted" || ok "bad app name refused"
nova stack new evil --home "$TMP/a\"b" >/dev/null 2>&1 && bad "quote in --home accepted" || ok "unsafe --home refused"

# 3. Runner verbs against the docker stub.
EXTRA=(DOCKER_ALL="c1 c2"); : >"$LOG"; run "${EXTRA[@]}" bash "$R" up >/dev/null
grep -q 'compose -p shop .*up -d' "$LOG" && grep -q 'update --restart=no c1 c2' "$LOG" && ok "up disarms boot restart" || bad "up: $(tr '\n' ';' <"$LOG")"
EXTRA=(DOCKER_PS="c1" DOCKER_CONFIG_RC=1); : >"$LOG"; run "${EXTRA[@]}" bash "$R" down >/dev/null
! grep -q 'compose .* stop' "$LOG" && grep -q 'docker stop c1' "$LOG" && ok "down works with a broken compose config" || bad "down: $(tr '\n' ';' <"$LOG")"
EXTRA=(); echo no | run bash "$R" reset >/dev/null 2>&1 && bad "reset without confirmation" || ok "reset needs the typed name"

# 4. Fleet: down only touches running stacks; audit and disarm respect the allow list.
EXTRA=(DOCKER_PS="c1"); : >"$LOG"; nova stacks down >/dev/null
grep -q 'docker stop c1' "$LOG" && ok "stacks down runs each runner's down" || bad "stacks down"
EXTRA=(DOCKER_ALL="a b" DOCKER_ARMED='/shop-db\tunless-stopped\n/nova-teams\talways\n/quiet\tno\n')
out="$(nova stacks audit)"
grep -q 'shop-db' <<<"$out" && ! grep -q 'nova-teams' <<<"$out" && ! grep -q quiet <<<"$out" && ok "audit lists armed containers except allowed" || bad "audit: $out"
: >"$LOG"; nova stacks disarm >/dev/null
grep -q 'update --restart=no shop-db$' "$LOG" && ok "disarm skips the Being's own services" || bad "disarm: $(grep update "$LOG")"
EXTRA=()
nova stacks add tool tool >/dev/null && grep -q $'^tool\ttool\t$' "$REG" && nova stacks remove tool >/dev/null && ! grep -q '^tool' "$REG" \
  && ok "stacks add/remove" || bad "stacks add/remove"
nova stack new anyapp --shim --unit anyapp.service >/dev/null && bash -n "$H/.local/bin/anyapp" \
  && grep -q 'UNIT="${ANYAPP_UNIT:-anyapp.service}"' "$H/.local/bin/anyapp" && ok "desktop shim generated" || bad "desktop shim"

# 5. monitor: hint when missing, runs the component when present.
nova monitor >/dev/null 2>&1 && bad "monitor without component succeeded" || ok "monitor hints when not installed"
mkdir -p "$W/ops/monitor"; printf '#!/bin/sh\necho monitor-ran "$@"\n' >"$W/ops/monitor/monitor"; chmod +x "$W/ops/monitor/monitor"
[[ "$(nova monitor --list)" == "monitor-ran --list" ]] && ok "monitor runs ops/monitor" || bad "monitor exec"

# 6. Sessions: four separate caches, owner off by default, who-am-I stamps.
KIT="$W/ops/teams-kit"; mkdir -p "$KIT/state"
cat >"$KIT/.env" <<ENV
BEING_NAME=nova
BEING_UPN=nova@example.test
BEING_CACHE='$KIT/state/token-cache.json'
OWNER_UPN=sam@example.test
OWNER_CACHE='$TMP/owner/owner-token-cache.json'
BEING_OWNER_DELEGATE=0
ENV
cp "$TMP/b.toml" "$W/being.toml"
out="$(nova access)"
for s in "Being Teams" "Being Outlook" "Owner Teams" "Owner Outlook"; do grep -q "$s" <<<"$out" || bad "access misses $s"; done
grep -q "being_mail .*its own mailbox" <<<"$out" && ok "access shows the [access] list and four sessions" || bad "access: $out"
: >"$LOG"; nova login being >/dev/null 2>&1 || bad "login being failed: $(tail -2 "$LOG")"
grep -q "teams-login-device.mjs --upn nova@example.test --cache $KIT/state/token-cache.json --scopes Chat.ReadWrite" "$LOG" \
  && grep -q "teams-login-device.mjs --upn nova@example.test --cache $KIT/state/being-outlook-cache.json --scopes Mail.ReadWrite" "$LOG" \
  && ok "login being: Teams and Outlook into separate caches" || bad "login being: $(cat "$LOG")"
: >"$LOG"; nova login being --outlook >/dev/null 2>&1; [[ "$(grep -c teams-login-device "$LOG")" == 1 ]] && grep -q being-outlook "$LOG" \
  && ok "login being --outlook only" || bad "login --outlook"
nova login owner --teams >/dev/null 2>&1 && bad "owner login while delegate off" || ok "owner login refused while BEING_OWNER_DELEGATE=0"
sed -i 's/^BEING_OWNER_DELEGATE=0/BEING_OWNER_DELEGATE=1/' "$KIT/.env"
: >"$LOG"; nova login owner >/dev/null 2>&1 && grep -q "owner-token-cache.json --scopes Chat.ReadWrite" "$LOG" \
  && grep -q "owner-outlook-cache.json --scopes Mail" "$LOG" && ok "login owner: own Teams and Outlook caches" || bad "login owner: $(cat "$LOG")"
out="$(nova access)"
grep -E 'Being Teams +nova@example.test +present +nova@example.test +[0-9]{4}-' <<<"$out" >/dev/null \
  && grep -E 'Owner Outlook +sam@example.test +present +sam@example.test' <<<"$out" >/dev/null && ok "access shows who-am-I and last confirmed" || bad "access stamps: $out"
echo "BEING_MAIL_CACHE='$KIT/state/token-cache.json'" >>"$KIT/.env"
nova login being --outlook >/dev/null 2>&1 && bad "shared cache accepted" || ok "two sessions sharing a cache refused"
sed -i '/^BEING_MAIL_CACHE=/d' "$KIT/.env"
nova login being --web >/dev/null 2>&1 && bad "being --web accepted" || ok "web sign-in is owner only"

# 7. doctor: index size, secrets folder, logins outside the access list.
mkdir -p "$H/.claude/projects/$(printf '%s' "$W" | sed 's#[^A-Za-z0-9]#-#g')/memory"
IDX="$H/.claude/projects/$(printf '%s' "$W" | sed 's#[^A-Za-z0-9]#-#g')/memory/MEMORY.md"
head -c 30000 /dev/zero | tr '\0' 'x' >"$IDX"
chmod 755 "$H/.config/nova"
out="$(nova doctor 2>&1)" && bad "doctor passed with problems" || true
grep -q "MEMORY.md is 30000 bytes" <<<"$out" && ok "doctor: index over ~24 KB fails" || bad "doctor index: $out"
grep -q "should be 0700" <<<"$out" && ok "doctor: secrets folder mode" || bad "doctor secrets mode"
grep -q "owner teams is signed in but not on the \[access\] list" <<<"$out" && ok "doctor: login outside the access list" || bad "doctor access: $out"
printf 'short\n' >"$IDX"; chmod 700 "$H/.config/nova"
sed -i 's/^owner_chat = true/owner_chat = true\nowner_teams_read = true\nowner_mail_read = true/' "$W/being.toml"
out="$(nova doctor 2>&1)" && ok "doctor passes once fixed" || bad "doctor still failing: $(grep FAIL <<<"$out")"

# 8. Session registry: never forgets, exit 2 when a transcript disappears.
SREG="$REPO/skills/memory/bin/being-session-registry"; STORE="$TMP/store"; mkdir -p "$STORE"
printf '{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"hello"}}\n' >"$STORE/s1.jsonl"
printf '{"type":"user","timestamp":"2026-01-02T00:00:00Z","message":{"content":"two"}}\n' >"$STORE/s2.jsonl"
run BEING_HOME="$W" BEING_SESSION_STORE="$STORE" python3 "$SREG" >/dev/null && ok "registry: first scan" || bad "registry first scan"
rm "$STORE/s1.jsonl"; set +e; run BEING_HOME="$W" BEING_SESSION_STORE="$STORE" python3 "$SREG" >/dev/null; rc=$?; set -e
[[ $rc == 2 ]] && grep -q '"present": false' "$W/.beings/sessions/manifest.jsonl" && grep -q 's1' "$W/.beings/sessions/INDEX.md" \
  && ok "registry: deletion detected and kept" || bad "registry deletion rc=$rc"
run BEING_HOME="$W" BEING_SESSION_STORE="$STORE" python3 "$SREG" >/dev/null && ok "registry: tripwire fires once" || bad "registry repeat"

# 9. Memory backup: commit + push, missed-day audit, large-file holdback, push failure kept local.
B="$TMP/being"; mkdir -p "$B/bin" "$B/.beings"; git init -q -b main "$B"; git init -q --bare "$TMP/remote.git"
git -C "$B" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init
git -C "$B" remote add origin "$TMP/remote.git"
cp "$REPO/skills/memory/bin/being-memory-sync" "$REPO/skills/memory/bin/being-session-registry" "$B/bin/"
AM="$TMP/automem"; mkdir -p "$AM"; echo "- [fact](fact.md)" >"$AM/MEMORY.md"
head -c 2000000 /dev/zero >"$B/big.bin"
sync_() { run GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com \
  BEING_AUTO_MEMORY_DIR="$AM" BEING_SESSION_STORE="$STORE" BEING_SYNC_MAX_MB=1 BEING_SYNC_SCAN=0 BEING_LOG_DIR="$TMP/logs" "$@" bash "$B/bin/being-memory-sync" run; }
mkdir -p "$B/.beings/operations"; date -d '3 days ago' +%F >"$B/.beings/operations/last-success-date"
sync_ && ok "memory sync run" || bad "memory sync failed: $(tail -3 "$TMP/logs/memory-sync.log")"
git -C "$TMP/remote.git" show main:.beings/auto-memory/MEMORY.md 2>/dev/null | grep -q fact && ok "auto-memory snapshot pushed" || bad "snapshot not pushed"
[[ "$(grep -c '"catch-up"' "$B/.beings/operations/sync-history.jsonl")" == 2 ]] && ok "two missed days logged" || bad "catch-up lines: $(grep -c catch-up "$B/.beings/operations/sync-history.jsonl")"
grep -q 'big.bin' "$B/.beings/operations/large-files-kept-local.tsv" && ! git -C "$B" ls-files --error-unmatch big.bin >/dev/null 2>&1 \
  && ok "large file kept local and listed" || bad "large file holdback"
[[ "$(cat "$B/.beings/operations/last-success-date")" == "$(date +%F)" ]] && ok "last success recorded" || bad "last success"
git -C "$B" remote set-url origin "$TMP/missing.git"; echo more >>"$AM/MEMORY.md"
sync_ && bad "push to a missing remote reported success" || { grep -q '"push-failed"' "$B/.beings/operations/sync-history.jsonl" && ok "push failure logged, kept local" || bad "push-failed not logged"; }
git -C "$B" log --oneline | grep -q 'memory snapshot' && ok "snapshot committed locally" || bad "no local commit"
out="$(run BEING_SYNC_AT=25:00 bash "$B/bin/being-memory-sync" install 2>&1)" && bad "bad BEING_SYNC_AT accepted" || ok "install validates BEING_SYNC_AT"

# 10. Index repair picks the verb the installed basic-memory has.
printf '#!/bin/sh\necho "bm $*" >>"$CALLS"\ncase "$1 $2" in "reindex --help") exit 0;; esac\nexit 0\n' >"$STUB/basic-memory"; chmod +x "$STUB/basic-memory"
: >"$LOG"; run BEING_HOME="$W" bash "$REPO/skills/memory/bin/being-bm-repair" >/dev/null
grep -q "bm reindex --full --project nova" "$LOG" && ok "bm repair: reindex --full on current versions" || bad "bm repair: $(cat "$LOG")"

# 11. publish-check blocks a committed secret (needs gitleaks; skipped without it).
if command -v gitleaks >/dev/null 2>&1; then
  P="$TMP/pub"; git init -q -b main "$P"; gc() { git -C "$P" -c user.name=t -c user.email=t@example.com "$@"; }
  gc commit -q --allow-empty -m init; echo hello >"$P/a.txt"; gc add a.txt; gc commit -q -m clean
  (cd "$P" && run PATH="$PATH" bash "$REPO/templates/kit/guards/publish-check.sh" HEAD~1..HEAD >/dev/null 2>&1) && ok "publish-check: clean commit passes" || bad "publish-check clean"
  printf 'API_TOKEN=%s\n' "$(head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9)" >"$P/b.txt"; gc add b.txt; gc commit -q -m leak
  (cd "$P" && run PATH="$PATH" bash "$REPO/templates/kit/guards/publish-check.sh" HEAD~1..HEAD >/dev/null 2>&1) && bad "publish-check missed a secret" || ok "publish-check: secret blocked"
else
  echo "  skip publish-check (gitleaks not installed)"
fi

(( fails == 0 )) && echo "being-cli: all checks passed" || { echo "being-cli: $fails failed"; exit 1; }
