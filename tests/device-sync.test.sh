#!/usr/bin/env bash
# device-sync.test.sh: the owner device sync recipe scripts, offline (local bare remotes only).
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
SRC="$REPO/docs/recipes/owner-device-sync"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
export HOME="$TMP/home" GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
mkdir -p "$HOME/code"
git config --global init.defaultBranch main

mkrepo() {   # $1 name: bare remote + clone under ~/code, plus a second clone that pushes new commits
  git init -q --bare "$TMP/remote/$1.git"
  git clone -q "$TMP/remote/$1.git" "$TMP/up-$1" 2>/dev/null
  git -C "$TMP/up-$1" commit -q --allow-empty -m init && git -C "$TMP/up-$1" push -q origin HEAD:main
  git clone -q "$TMP/remote/$1.git" "$HOME/code/$1"
  git -C "$TMP/up-$1" commit -q --allow-empty -m next && git -C "$TMP/up-$1" push -q origin HEAD:main
}
for r in clean dirty diverged; do mkrepo "$r"; done
touch "$HOME/code/dirty/wip.txt"
git -C "$HOME/code/diverged" commit -q --allow-empty -m local

export DEVICE_SYNC_ROOTS="$HOME/code" DEVICE_SYNC_STATE="$TMP/state" DEVICE_SYNC_CONF="$TMP/none.conf"
out=$(bash "$SRC/ff-pull.sh" --dry-run)
[[ $(git -C "$HOME/code/clean" rev-parse HEAD) != $(git -C "$TMP/up-clean" rev-parse HEAD) ]] && ok "dry run changes nothing" || bad "dry run moved a branch"
out=$(bash "$SRC/ff-pull.sh")
[[ $(git -C "$HOME/code/clean" rev-parse HEAD) == $(git -C "$TMP/up-clean" rev-parse HEAD) ]] && ok "clean checkout fast-forwarded" || bad "clean checkout not updated"
grep -q '^SKIPPED dirty:main dirty worktree' <<<"$out" && [[ -e "$HOME/code/dirty/wip.txt" ]] && ok "dirty worktree left alone" || bad "dirty worktree: $out"
grep -q '^SKIPPED diverged:main diverged' <<<"$out" && ok "diverged branch left alone" || bad "diverged: $out"
grep -q '^LOCALONLY diverged:main' <<<"$out" && ok "local-only commits reported" || bad "local-only not reported"
[[ -z $(git -C "$HOME/code/dirty" stash list) ]] && ok "nothing stashed" || bad "a stash was created"

rc=0; bash "$SRC/daily-sync.sh" --no-notify >/dev/null || rc=$?
[[ $rc == 1 && ! -f "$TMP/state/success" ]] && ok "skips count as failure, no success marker" || bad "rc=$rc with skips"
rm "$HOME/code/dirty/wip.txt"; git -C "$HOME/code/diverged" reset -q --hard origin/main
rc=0; bash "$SRC/daily-sync.sh" --no-notify >/dev/null || rc=$?
[[ $rc == 0 && $(cat "$TMP/state/success") == $(date +%F) ]] && ok "success writes today's marker" || bad "rc=$rc on clean run"
n=$(ls "$TMP/state/reports" | wc -l)
bash "$SRC/daily-sync.sh" --no-notify >/dev/null
[[ $(ls "$TMP/state/reports" | wc -l) == "$n" ]] && ok "second run the same day is a no-op" || bad "re-ran after success"
exec 9>"$TMP/state/lock"; flock -n 9
rc=0; bash "$SRC/daily-sync.sh" --force >/dev/null || rc=$?
[[ $rc == 75 ]] && ok "held lock exits 75" || bad "lock rc=$rc"
exec 9>&-

touch "$HOME/code/dirty/wip.txt"
git -C "$TMP/up-dirty" commit -q --allow-empty -m more && git -C "$TMP/up-dirty" push -q origin HEAD:main
cat >"$TMP/notify" <<'N'
#!/usr/bin/env bash
cat >>"$NOTIFY_OUT"
N
chmod +x "$TMP/notify"
export DEVICE_SYNC_NOTIFY="$TMP/notify" NOTIFY_OUT="$TMP/notices"
bash "$SRC/daily-sync.sh" --force >/dev/null || true
bash "$SRC/daily-sync.sh" --force >/dev/null || true
[[ $(grep -c . "$TMP/notices") == 1 ]] && ok "failure notice sent once per day" || bad "notices: $(cat "$TMP/notices" 2>/dev/null)"
grep -q 'wip.txt\|SKIPPED' "$TMP/notices" && bad "notice leaks report lines" || ok "notice holds only a count and a path"

(( fails == 0 )) && echo "device-sync: all passed" || { echo "device-sync: $fails failed"; exit 1; }
