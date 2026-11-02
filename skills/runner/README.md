# Runner: background jobs and blockers without the Teams kit

For a Being that has its own messaging scripts (or none yet). With the Teams kit installed, use the kit's own
`being-job` and `being-blocker` instead: they add send scopes, lanes and the Teams notifier.

| File | What it does |
|---|---|
| `being-job` | Runs long work that must outlive a reply: headless Claude, Codex or any command; writes a result file |
| `being-blocker` | Tells the owner at once that a step is blocked, instead of retrying |
| `heavy-lock` | `heavy-lock <name> -- <cmd>`: one heavy task (render, big build, browser fleet) at a time box-wide; waits for free memory (`HEAVY_MIN_GB`, `HEAVY_MAX_SWAP_PCT`), exit 75 after `HEAVY_TIMEOUT_MIN` |
| `being-heartbeat` | Nudges the main tmux session every 30 min, or when a job finishes |
| `env.example` | Settings (`~/.config/being-runner/env`, 0600) |
| `templates/kit/units/` | `<being>-session.service` (tmux), `<being>-poller.service`, `<being>-heartbeat.service/.timer` |

## Install

```bash
skills/runner/kit-install.sh <being-home> [--name <being>]
```

Copies the scripts to `<being-home>/ops/runner/`, writes `~/.config/being-runner/env` if missing, writes the units to
`~/.config/systemd/user/` and links `being-job` / `being-blocker` into `~/.local/bin` unless those names are taken.
Re-running adds what is missing; a changed upstream file goes to `.kit-upgrade/` next to yours. Nothing is enabled.

## Use

```
being-job agent <name> [--small] [--notify <target>] "<self-contained task>"   headless Claude to completion
being-job codex <name> "<task>"
being-job run <name> -- <cmd...>
being-job list | status <id> | log <id> [n] | stop <id> [reason]
being-blocker "<task>" "<why it is stuck, plain words>" "<what you need>" ["<exact error, logged only>"]
```

- Each finished job appends one line to `$BEING_STATE_DIR/work.jsonl` and calls `BEING_ON_JOB_DONE <job.json>`.
  The default nudges the main tmux session with the job id and result path.
- A model job that exits 0 without writing its result file is marked `no-result`, not `done`.
- `being-blocker` logs to `blockers.jsonl` and pipes an HTML message to `BEING_BLOCKER_SEND` (your sender; exit 0 = sent).
  Tasks matching a line in `blocker-quiet.txt` are logged only.
- `stop` ends the job's whole process group.

## Switch on

```bash
systemctl --user daemon-reload
systemctl --user enable --now <being>-session <being>-heartbeat.timer
systemctl --user enable --now <being>-poller           # only if you have ops/poller
systemctl --user is-active <being>-session <being>-heartbeat.timer   # installed is not running: check
```

User units need linger to start without a login: an admin runs `sudo loginctl enable-linger <user>` once.
