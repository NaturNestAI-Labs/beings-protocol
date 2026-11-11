# Model Routing — Right Model, Right Step

Route by the weight of the step, not by habit. Cheap, fast steps run often; strong models run where judgment pays.

| Step | Frequency | Model | Effort | Setting |
|---|---|---|---|---|
| Triage (ack decision, status answers) | every message | fast (e.g. a Haiku-class model, or Codex at low effort) | low | `BEING_FAST_CLIENT`, `BEING_FAST_MODEL`, `BEING_FAST_EFFORT` |
| Voice (reword outgoing messages) | every reply | same fast model | low | same |
| Work session (do the task, decide) | per message needing work | strong (Opus-class) | default | `BEING_SESSION_MODEL` |
| Big jobs (research, reviews, multi-step builds, audits) | a few per day | strong | default | `BEING_JOB_MODEL` |
| Small jobs (lookups, account chores, probes, file moves) | many | mid (Sonnet-class) | default | `being-job agent <n> --small`, `BEING_JOB_MODEL_SMALL` |
| Self-contained coding/build jobs | as needed | Codex | medium | `being-job codex` |

Guidelines:

- **Pin models explicitly** in every launcher (`--model`), so a client default change or a per-model usage limit does not
  silently move work to a model you did not choose. When one model hits a limit, switch the env var, not the code.
- **Fast models never act.** Triage and voice run read-only and return JSON; scripts apply their decisions.
- **Guard the fast model's output.** The voice pass may not drop a number or link; if it does, the original text is sent.
- **One session per day per client and lane** (the owner's, and one per teammate chat) keeps context warm without reloading the whole history for each message.
- Use model aliases (`opus`, `sonnet`, `haiku`) or full ids as your client accepts; check with a one-line run before relying
  on a new id.

## Model Limits

Model clients have usage ceilings: a rolling session limit for the whole account and, on some plans, a per-model limit.
When one is hit, every `claude -p` run on that model fails at once, usually with exit 1 and one line at the end of its
log. Nothing is half-applied (runs stop between steps), but the work is lost unless it is relaunched. Handle it as an
expected event, not an incident.

### Detect

| Signal | Where | Meaning |
|---|---|---|
| `hit your session limit` (often with `resets <time>`) | last lines of a job log or the handler log | account-wide session limit; every model of that client is affected until the reset |
| `usage limit`, `reached your <model> limit`, `Switch to another model` | same | per-model or plan limit; other models may still work |
| several jobs failing within the same minute with exit 1 | `being-job list` | a limit wave, even before the log is read |

Match on the log text, never on the exit code alone. At the start of every work run, `being-job list` and read the log
tail of anything that failed; report a wave of failures once, with its cause and the reset time if the log gives one.

### Fall back

| Situation | Action | Setting |
|---|---|---|
| Work session or reply hits a Claude limit | answer through Codex for the rest of the turn | `BEING_WORK_FALLBACK=codex` (default), `off` to disable |
| A Claude agent job dies on a limit (owner lane) | relaunch it once as a Codex job with the same task, linked to the old id | same |
| A teammate-lane job dies on a limit | no automatic fallback unless the teammate fence also covers the fallback client; raise a blocker instead | — |
| A per-model limit only | switch the model env var (`BEING_JOB_MODEL`, `BEING_SESSION_MODEL`) to another allowed model; do not change code | — |

A fallback is recorded in the job state (`fallback from <id>`) so the monitor and the result show both runs. Fallback
never widens scope: the new job carries the original job's signed scope and notify target.

### Pace heavy jobs

Many strong-model agents running for hours exhaust the session limit together. Keep at most 5 heavy jobs in parallel
(`BEING_JOB_MAX_HEAVY` where the launcher supports it; otherwise a rule in the job checklist) and chain the rest: a queued
job's prompt starts with "wait for job <id>". Small jobs on the mid model (`--small`) do not count toward the cap.

### Relaunch as RESUME

Relaunch after the reset, not before. A relaunched job gets a header so finished work is not redone:

```text
RESUME of job <old id>. Read <old log> and <old result, if any> first. Keep what is already done and verified; continue
from the first unfinished step. Do not repeat external actions (messages, pushes, uploads) that the log shows succeeded.
```

Write prompts to a file with a quoted heredoc rather than inline in double quotes, so backticks and `$` are not expanded
by the shell. When a job is relaunched by script, take the task from the job's stored payload (the last element is the
prompt), not from a re-typed copy.

### Test with the job's exact model

A plain `claude -p "ok"` passing does not prove jobs will run: jobs pin a model, and the limit may be per model. Before
saying jobs work again:

1. Run `claude -p --model <the exact BEING_JOB_MODEL value> "reply ok"`.
2. Relaunch one job, not the whole wave.
3. Confirm it is still alive after about 60 seconds (`being monitor` or `being-job status <id>`), then relaunch the rest
   within the parallel cap.

### Deny-list

Some models must never be used (cost, policy, or a limit that keeps tripping). List them in `BEING_MODEL_DENY`
(comma-separated ids or aliases) and in the Being's conventions. A launcher that reads it refuses a denied model with a
clear error instead of starting a run that will fail. Check that every launcher (daily session, triage, voice, jobs,
heartbeat) pins an explicit, allowed model, so a client default change cannot route work to a denied one.
