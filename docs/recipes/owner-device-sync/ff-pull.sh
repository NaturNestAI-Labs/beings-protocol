#!/usr/bin/env bash
# Fast-forward local branches of every git repo under the configured roots to their upstreams. Never forces, stashes,
# merges or rebases; dirty, diverged or mid-merge worktrees are reported and left alone.
#   ff-pull.sh [--dry-run]     settings: DEVICE_SYNC_ROOTS, DEVICE_SYNC_DEPTH, DEVICE_SYNC_REMOTE_MATCH (see README)
set -uo pipefail
DRY=0
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) echo "unknown argument: $a" >&2; exit 2 ;; esac; done
IFS=: read -r -a ROOTS <<<"${DEVICE_SYNC_ROOTS:?set DEVICE_SYNC_ROOTS (colon-separated directories)}"
DEPTH=${DEVICE_SYNC_DEPTH:-3}; MATCH=${DEVICE_SYNC_REMOTE_MATCH:-.}
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=20}"
clean() { sed -E 's#//[^/@ ]*@#//#g' | tail -1; }   # drop credentials from URLs in git output
declare -A SEEN=()
scanned=0
for root in "${ROOTS[@]}"; do
  root=${root/#\~/$HOME}
  [[ -d $root ]] || { echo "SKIPPED root $root missing"; continue; }
  while IFS= read -r -d '' g; do
    wt=$(dirname "$g")
    common=$(git -C "$wt" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
    [[ -n ${SEEN[$common]:-} ]] && continue
    SEEN[$common]=1; scanned=$((scanned + 1))
    url=$(git -C "$wt" remote get-url origin 2>/dev/null) || continue
    [[ $url =~ $MATCH ]] || continue
    repo=$(basename "$url" .git)
    if ! out=$(timeout 180 git -C "$wt" fetch --all --quiet 2>&1 </dev/null); then
      echo "FAIL $repo: fetch failed: $(clean <<<"$out")"; continue
    fi
    declare -A CO=(); w=""
    while IFS= read -r l; do   # branch -> worktree that has it checked out ("-" if that directory is gone)
      case $l in worktree\ *) w=${l#worktree } ;; branch\ refs/heads/*) b=${l#branch refs/heads/}; [[ -d $w ]] && CO[$b]=$w || CO[$b]=- ;; esac
    done < <(git -C "$wt" worktree list --porcelain)
    while IFS='|' read -r b u; do
      n=$(git -C "$wt" rev-list --count "refs/heads/$b" --not --remotes 2>/dev/null || echo 0)
      (( n > 0 )) && echo "LOCALONLY $repo:$b ($n commit(s) not on any remote)"
      [[ -n $u ]] && git -C "$wt" rev-parse -q --verify "$u^{commit}" >/dev/null || continue
      read -r behind ahead < <(git -C "$wt" rev-list --left-right --count "$u...refs/heads/$b") || continue
      (( behind == 0 )) && continue
      p=${CO[$b]:-}
      if (( ahead > 0 )); then echo "SKIPPED $repo:$b diverged from $u (+$ahead/-$behind), left alone"; continue; fi
      [[ $p == - ]] && { echo "SKIPPED $repo:$b worktree directory missing"; continue; }
      old=$(git -C "$wt" rev-parse "refs/heads/$b"); new=$(git -C "$wt" rev-parse "$u")
      if [[ -n $p ]]; then
        gd=$(git -C "$p" rev-parse --absolute-git-dir)
        [[ -z $(git -C "$p" status --porcelain) ]] || { echo "SKIPPED $repo:$b dirty worktree $(basename "$p"), $behind behind"; continue; }
        if [[ -e $gd/MERGE_HEAD || -d $gd/rebase-merge || -d $gd/rebase-apply ]]; then
          echo "SKIPPED $repo:$b merge/rebase in progress in $(basename "$p")"; continue
        fi
        if (( DRY )); then echo "UPDATED $repo:$b would fast-forward +$behind"; continue; fi
        if out=$(git -C "$p" merge --ff-only --quiet "$u" 2>&1 </dev/null); then echo "UPDATED $repo:$b +$behind ($(basename "$p"))"
        else echo "FAIL $repo:$b fast-forward failed: $(clean <<<"$out")"; fi
      else
        if (( DRY )); then echo "REF $repo:$b would move +$behind"; continue; fi
        # Compare-and-swap: only moves the ref if nobody changed it since it was read.
        git -C "$wt" update-ref "refs/heads/$b" "$new" "$old" && echo "REF $repo:$b +$behind" || echo "FAIL $repo:$b ref update failed"
      fi
    done < <(git -C "$wt" for-each-ref --format='%(refname:short)|%(upstream:short)' refs/heads)
    unset CO
  done < <(find "$root" -maxdepth "$DEPTH" -name .git -not -path '*/node_modules/*' -print0 2>/dev/null)
done
echo "INFO $scanned repositories scanned"
