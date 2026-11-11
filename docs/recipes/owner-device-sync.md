# Recipe: Owner Device Sync (optional)

Keep the owner's laptop in step with the work a Being does on its box: once a day, every repo the owner tracks is
fast-forwarded to what the Being (and everyone else) pushed, and the owner hears about it **only when something needs a
person**. Scripts: [`owner-device-sync/`](owner-device-sync/).

| File | Does |
|---|---|
| `daily-sync.sh` | Runs the steps once per day with catch-up, holds a lock, keeps a private report, sends a failure-only notice |
| `ff-pull.sh` | Fast-forwards local branches of every repo under the configured roots; never forces or stashes |
| `device-sync.conf.example` | Settings: roots, depth, remote filter, extra steps, notify command |

## Rules built into the scripts

| Rule | How |
|---|---|
| Once per day, with catch-up | A per-day success marker (`$DEVICE_SYNC_STATE/success` holds today's date). Call it hourly and at boot; it does nothing after the day's first successful run. A failed run leaves no marker, so the next call retries |
| One run at a time | `flock` on a state lock; a second run exits **75** (temporary failure) and says completion is unverified |
| Fast-forward only | A checked-out branch moves only with `git merge --ff-only`; a branch not checked out moves with a compare-and-swap `update-ref` |
| Never destroy work | No `--force`, no `reset`, no `stash`, no rebase. Dirty worktrees, diverged branches and in-progress merges/rebases are reported as `SKIPPED` and left alone |
| Report local-only work | Branches with commits on no remote are listed as `LOCALONLY` (information, not failure) |
| Failure-only notice | Success is silent. On `FAIL`, `CONFLICT` or `SKIPPED` lines, `DEVICE_SYNC_NOTIFY` receives one short message: a count and the path of the private report. It never contains the report lines, logs or file contents, and is sent at most once per day for the same problems |
| No credentials in output | Credentials embedded in remote URLs are stripped from git messages |
| Private reports | Reports live under `$DEVICE_SYNC_STATE/reports/` with `umask 077` |

Report line prefixes: `UPDATED`, `REF`, `SKIPPED`, `FAIL`, `CONFLICT`, `LOCALONLY`, `INFO`, `HOST`. Extra steps you add
should print the same prefixes.

## Install on the owner's device

```bash
dest=~/.local/share/being-device-sync
mkdir -p "$dest" ~/.config/being-device-sync
install -m 0755 docs/recipes/owner-device-sync/{daily-sync.sh,ff-pull.sh} "$dest/"
cp docs/recipes/owner-device-sync/device-sync.conf.example ~/.config/being-device-sync/device-sync.conf   # then edit
(set -a; . ~/.config/being-device-sync/device-sync.conf; "$dest/ff-pull.sh" --dry-run)   # see what would move
```

Timer (user units, owner's device):

```ini
# ~/.config/systemd/user/being-device-sync.service
[Service]
Type=oneshot
ExecStart=%h/.local/share/being-device-sync/daily-sync.sh
SuccessExitStatus=75

# ~/.config/systemd/user/being-device-sync.timer
[Timer]
OnCalendar=*-*-* 08:00
OnBootSec=10min
OnUnitActiveSec=1h
Persistent=true
[Install]
WantedBy=timers.target
```

`systemctl --user enable --now being-device-sync.timer`. The hourly trigger is the catch-up; the marker keeps it to one
real run a day. The timer uses the device's local time zone.

## Optional steps you can add

Keep each as its own script listed in `DEVICE_SYNC_STEPS`:

- **Restart moved stacks.** For apps the owner runs locally through a stack runner: if a fast-forward moved the
  checkout of a stack that is **currently running**, restart it with its runner; never start a stopped one.
- **Notes sync.** Two-way `rsync --update` of the Being's notes the owner reads. If a file changed on both sides since
  the last sync, keep both copies (the older one renamed) and report a `CONFLICT`; never overwrite silently.
- **Box side.** The Being's box can publish its own clean branches first, so the device pulls them in the same run.

## What it never does

Push from the device, delete branches or worktrees, touch a repo whose origin does not match `DEVICE_SYNC_REMOTE_MATCH`,
or copy secrets, env files or databases between machines.

Tests: `tests/device-sync.test.sh` (offline, local bare remotes).
