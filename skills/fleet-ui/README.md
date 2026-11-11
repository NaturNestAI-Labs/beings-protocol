# Fleet UI (design)

**Status: design and data contract only. No code ships in this version.** A single-Being prototype exists outside the
kit; it is not ported because it still reads Being-specific files, an owner-name default and an organisation-specific
link allowlist, and has no multi-Being layer. The TODO list at the end is what a port needs.

## What it is

One read-only web page that shows what every Being on a box (or a small fleet) is doing, as summary pointers rather than
chat transcripts. Teams stays the chat surface; the page answers "who asked what, what is running, what is waiting on a
human" at a glance. The terminal counterpart for one Being is [`being monitor`](../monitor/README.md).

| View | Shows |
|---|---|
| Fleet | One card per Being: running jobs, failed jobs today, pending approvals, open blockers, last activity, service health |
| Overview (per Being) | People today, running jobs, pending approvals, blockers, recently finished jobs |
| People | One card per person per day: headline, topics, asks, deliveries, open asks, linked jobs |
| Jobs | Status, requester, start/end/duration, task, outcome, artifacts, PR refs |
| Approvals | Owner drafts (`send Dn`) and their state |
| Docs | Pinned docs index plus document artifacts from finished jobs |
| Blockers | `being-blocker` entries |

Filters: Today / Yesterday / 7 / 30 days, a from-to range (max 92 days), Being, person, status. The page refreshes over
server-sent events when a source file changes, and once a minute.

## Shape

```
per Being (its own user)            fleet host (any one box)
  being-fleet-agent  --(json)-->    being-fleet-ui (loopback HTTP)  --> browser via tunnel + access policy
  reads only that Being's state      merges, applies viewer policy
```

- **Agent per Being.** Runs as the Being's own Linux user, reads only that Being's files (below), and writes one redacted
  snapshot (`<state>/fleet/snapshot.json`, 0600) or serves it on a loopback port. No Being reads another Being's home.
- **One UI.** Pulls each Being's snapshot (local file, or over SSH/tunnel for another box), merges and serves them.
- **Nothing starts at boot.** Follows the stack runner rules: `being-fleet-ui up|down|status|logs|open`.

## Data contract (snapshot, version 1)

All text is redacted before it is written (the monitor's credential rules plus IPs, internal hostnames, emails,
`user@host`, ssh targets and links outside an allowlist from config). Times are epoch seconds; `day` is `YYYY-MM-DD` in
the Being's `TZ`.

```json
{
  "schema": 1, "being": "<being>", "owner": "<owner>", "generated": 0, "tz": "<zone>",
  "health": {"teams": "active|inactive|unknown", "last_poll": 0, "blockers_open": 0},
  "people":    [{"person": "", "day": "", "inbound": 0, "outbound": 0, "first": 0, "last": 0,
                 "groups": [], "channels": [], "jobs": ["<job id>"], "summary": null}],
  "jobs":      [{"id": "", "name": "", "kind": "agent|codex|run", "status": "", "exit": null, "started": 0,
                 "finished": 0, "day": "", "requester": "", "lane": "owner|team", "task": "", "title": "",
                 "outcome": [], "artifacts": [], "links": [], "prs": [], "has_result": false}],
  "approvals": [{"id": "D1", "source": "owner-draft", "kind": "teams|mail", "what": "", "state": "pending|given|refused",
                 "asked_by": "", "decided_by": "", "at": 0, "day": ""}],
  "blockers":  [{"at": 0, "day": "", "task": "", "error": "", "need": ""}],
  "docs":      [{"at": 0, "day": "", "what": "", "links": [{"name": "", "url": ""}], "source": ""}]
}
```

| Field source | Kit file |
|---|---|
| people | `$BEING_STATE_DIR/comms.jsonl` (counts only; message text never leaves the agent unless summarised) |
| jobs | `$BEING_STATE_DIR/jobs/*.json`, `.result.md`; running state checked against live processes as the monitor does |
| approvals | `$BEING_STATE_DIR/drafts/D*.json` |
| blockers | `$BEING_STATE_DIR/blockers.jsonl` |
| docs | `$BEING_STATE_DIR/docs-index.json` (if the docs index is on) plus document artifacts of finished jobs |
| health | `being-teams status` / unit state |

`requester` comes from the job's signed scope (`chats:<id>` maps to the chat's person via the comms log; `full` is the
owner), never from the job's own record. Summaries are optional (see below); when absent the UI shows deterministic
pointers from the result file.

## Access

- Viewers in a 0600 config file; only SHA-256 hashes of their tokens are stored. Cookie HttpOnly, SameSite=Strict.
- **Owner** of a Being sees everything for that Being and can open the redacted result/log tail.
- **Teammate** sees only their own person-days, the jobs they requested and docs from those jobs; no approvals,
  blockers or drill-down. Enforced on the server, not in the page.
- An owner of several Beings sees each of them; nobody sees a Being they are not listed for.
- Binds to loopback only unless an explicit override is set. Remote access goes through the Being's tunnel with an
  access policy created before the hostname; an identity header from the access layer is trusted only behind it.

## Summaries (optional, off by default)

Person-day and job summaries from a model, through the Being's own model route (a local proxy with a scoped, budget-capped
virtual key, see [llm-proxy](../../docs/recipes/llm-proxy.md), or `claude -p` on the fast model). Cached by input hash so
a summary is regenerated only when its inputs change. Input is redacted first.

## TODO for the port

1. Build `being-fleet-agent` from the job/blocker/draft readers; reuse `skills/monitor/monitor.py` for live-process checks
   and `redact`.
2. Move the link allowlist, owner name and port into config; no defaults naming a person or organisation.
3. Add the fleet card view and the Being filter; merge snapshots by `being`.
4. Map requesters from signed job scopes (`state/job-scopes/`), not the job record.
5. Runner (`up|down|status|logs|open`), registered with `being stacks`; tests for the viewer policy and redaction.
6. Optional: PR list from the Being's own Git account (never the owner's), cached.
