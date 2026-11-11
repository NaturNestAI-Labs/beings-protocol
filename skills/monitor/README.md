# Monitor

Python 3 standard library only. Read-only: reads job state, transcripts and `/proc`; never sends input, changes session
state or signals a worker.

```sh
being monitor                 # live list (terminal UI)
being monitor --list          # plain table
being monitor --json          # redacted structured snapshot
being monitor <job-or-session-id>
being monitor <job-or-session-id> --once
```

The list refreshes every two seconds: arrows select, Enter opens, `r` running only, `a` all/reset search, `/` search
(Enter finishes), `q`/Esc returns or quits. Detail: arrows/PageUp/PageDown scroll, `p` expands the prompt. The lower
pane follows the latest transcript events. Without a terminal it prints the plain table. `--once` prints detail and a
tail snapshot for an exact ID. `--json` emits redacted JSON; add an ID to restrict it to one record.

## Install

```sh
skills/monitor/kit-install.sh <being-home>     # copies monitor.py to <being-home>/ops/monitor/
```

Optional; nothing runs in the background. The launcher runs `python3 <home>/ops/monitor/monitor.py "$@"`.

## Settings (environment)

| Variable | Default | Used for |
|---|---|---|
| `BEING_WORKSPACE` | two levels above `monitor.py` | the Being's home |
| `BEING_STATE_DIR` | `<home>/ops/teams-kit/state` | `jobs/`, `fast-daily/`, `work-session.*` |
| `BEING_NAME` | home directory name | recognising the owner lane's daily session id |
| `TZ` | system zone | timestamps and the "day" of a daily session |

The launcher exports these from the kit's `.env`; the monitor reads no `.env` or credential file itself.

## Sources

- Teams kit jobs: `$BEING_STATE_DIR/jobs/*.{json,events.jsonl,log,result.md}` (written by `being-job`).
- Daily sessions: `fast-daily/*.id` (Codex fast session), `work-session.*` (running work session), the owner lane's daily
  Claude id (`being-daily/<name>/<day>`, as `being-handle` makes it), and transcripts whose prompts carry the kit's
  `[Teams …]` / `… Teams work · daily session` headers (teammate lanes).
- Client transcripts: `~/.claude/projects/*/*.jsonl` and `sessions/**/*.jsonl` under `~/.codex`, `CODEX_HOME`, and any
  `CODEX_HOME` of a running client. `~/.claude/sessions/*.json` registrations map live PIDs.
- Processes: `/proc` entries whose first arguments are `claude`, `codex`, `being-job` or `being-handle`.

Jobs link to their transcripts instead of repeating them as separate rows. Lanes run under OS isolation keep their
transcripts in the lane user's home and are only shown when readable.

## Status rules

Job status comes from state, exit code and matching live processes. A job marked running with no visible worker is shown
as stopped (inferred). Inside a Codex sandbox host PIDs are hidden, so running state is kept with an "unverified" label.
Interactive status is an inference (live PID plus an open tool or recent activity); otherwise idle, which does not mean
exited. A tool return means completed, not succeeded; explicit failures are marked. Result files are authoritative; the
last assistant message is only a candidate summary. Paths are mentions, not verified artifacts.

A `*` beside a status means inferred or PID check unavailable; open detail (or JSON `status_source`) for the evidence.

## Limits

List discovery reads the first eight records and last 128 KiB of large files; detail loads the selected transcript in
full. Reads are incremental and survive partial lines and rotation. History kept on screen: the latest 2,000 tool calls
and 500 live events. Durations include idle time; missing timestamps are shown as unknown.

## Redaction

Output removes common API keys, Bearer credentials, JWTs, password/secret/token assignments, Teams chat ids and terminal
control codes; `--json` applies the same filter recursively. Unlabelled secrets cannot be recognised reliably, so keep
snapshots private. Notify targets are shown as role labels, never chat ids.

## Tests

```sh
python3 -m unittest discover -s skills/monitor -v     # offline, temp fixtures
python3 skills/monitor/smoke_tui.py                    # drives the terminal UI in a pseudo-terminal
```
