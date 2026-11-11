# Recipe: One Being on Two Boxes

Run one Being on a second machine (more CPU, a standby, a box at another site) **without forking it**: one identity,
one memory, one place that writes history. The second box is another set of hands, not a second Being.

## Shape

| Part | Primary box | Second box |
|---|---|---|
| Being home (`.beings/`, memory graph, kit) | local disk, the only copy | mounted from the primary (sshfs or NFS over a private link), same path |
| Client auto-memory (`~/.claude/projects/<key>/memory/`) | local | mounted from the primary; the project's memory directory is a symlink to the mount |
| Git sync, memory backup, cron jobs, timers that write | **runs here only** | **never** |
| Teams watcher (`being-teams`) | runs (active) | installed but gated by the cutover flag (standby) |
| Claude / Codex logins | its own | **its own**, signed in separately on this box |
| Microsoft token caches, owner sessions | its own | its own sign-in, never copied |
| App stacks, jobs | as usual | as usual (jobs write results into the shared home) |

## Why each rule

- **Same path on both boxes.** Claude keys sessions and memory by the real path of the workspace; a different mount
  point makes a second, empty memory.
- **Single writer for sync and cron.** Two boxes committing or backing up the same repo race and produce conflicting
  commits. Pick one box (the one with the disk) and leave the timers disabled on the other.
- **Separate CLI logins.** Copied OAuth tokens are the same session: when one box refreshes, the other gets logged out
  mid-job. Sign in on each box; the same account is fine, the same token file is not.
- **Never two watchers at once.** Two active Teams watchers answer every message twice and fight over state. Exactly one
  box is active.

## Cutover flag

The standby box's watcher refuses to start until a flag file exists:

```ini
# ~/.config/systemd/user/being-teams.service.d/standby-gate.conf  (second box only)
[Unit]
ConditionPathExists=%h/.config/<being>/cutover-go
```

To switch boxes: stop and disable the watcher on the old box, then `touch ~/.config/<being>/cutover-go` and start it on
the new one. Remove the flag on the box that becomes standby. Move the sync/cron timers in the same step, so "active
watcher" and "single writer" stay on one box, or keep them deliberately on the disk box and say so in the notes.

## Mounts

- Use a private link or the LAN, never a public route, for the mount. A restricted SFTP-only key on the primary is
  enough for sshfs.
- Automount with reconnect (`x-systemd.automount,reconnect,ServerAliveInterval=15`) so a primary reboot does not wedge the
  second box.
- Keep build caches, `node_modules`, containers and large data local to each box; only the home and memory are shared.
- If the mount is down the second box must fail loudly (a missing `.beings/` stops the launcher), not start a fresh,
  empty Being.

## Checklist

1. Same Linux user name, tool versions and kit version on both boxes.
2. Home and auto-memory mounted at the same paths; `being monitor` on the second box shows the primary's jobs.
3. Separate `claude login`, `codex login`, Microsoft sign-ins and tunnel on the second box.
4. Sync and backup timers enabled on one box only (`systemctl --user list-timers` on both).
5. Standby gate installed on the second box; exactly one `being-teams` active.
6. Its own key folder (`~/.config/<being>/`) with only the keys that box needs.
