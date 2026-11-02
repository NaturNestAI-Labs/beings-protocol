# Operations Kit v0.3 candidates (field notes, November)

Patterns proven on a Being in daily use after v0.2. This branch ships the small ones as code; the rest are described here
so they can be ported one at a time, each with its tests. Nothing below is specific to one company or Being.

## Shipped on this branch

| Part | What changed | Where |
|---|---|---|
| Owner mail batches | Many mails as the owner after ONE preview: owner types `SEND Bn` (or `SEND`), the kit sends each once, rate-limited, ledgered, nobody twice, summary back. Single mails keep `send Dn` | `skills/teams-kit/send-batch.mjs`, `batch-lib.mjs` (+ test), `being-handle`, GUARDRAILS, README "Mail batches" |
| Owner authority | The owner decides the Being's own rules, workflow and kit setup; the Being recommends first (1-3 lines), then does it without asking anyone else. Hard limits unchanged | `templates/beings/AUTONOMY.md`, `templates/kit/AUTONOMY-MATRIX.md`, owner-lane prompt in `being-handle` |
| Plain blockers | Card reads Stuck / Why / I need from you; optional 4th argument = exact error, logged to `blockers.jsonl` only | `being-blocker` (runner and Teams kit) |
| Heavy-task lock | `heavy-lock <name> -- <cmd>`: one heavy task box-wide, waits for free memory and low swap, exit 75 on timeout | `skills/runner/heavy-lock` |
| Field fixes and updates | Owner id required, persona fallback, per-chat attachments, install manifest, SSH/suspend/xrdp hardening, tunnel dry run, cron box time, `<being> update` + versioning | see `CHANGELOG.md` 0.5.0 |
| Message and work conventions | One language for all messages, short plain status, verify "sent/armed" live, >2 min work becomes a job, stacks in own scope | `templates/beings/CONVENTIONS.md` |

## Next (described, not yet ported)

### 1. Jobs you can enter
- Each background job runs in its own tmux session on a dedicated socket, not as a detached headless run, so the owner can
  attach, type into it, and leave (`Ctrl-] d`) without stopping it.
- Each job gets a **keyword**: the shortest prefix of its name not held by another running job (`report`, `report-v2`).
  `<being> claude <keyword>` follows a running job, `fork` opens a side copy, a finished job resumes.
- A job writes a RESULT file and ends its own turn; a hook marks it done and wakes the daily session to verify the result
  before anything is reported. Lost links re-attach by themselves; only an explicit detach ends the client.
- A turn that ends while the job's own shells still run work in the background (a render, a long generation) is busy,
  not waiting: the hook checks the session's live child processes and sends no "waiting"/"stuck" ping until they finish.
  A missing RESULT then still alerts once.
- Tests: job start/attach/detach, keyword uniqueness, reserved words, result hook.

### 2. One boss session and lead sessions
- One long-lived **boss** session on the Being's own box: sees live state, routes each task to one lead, starts, steers
  and stops jobs. It does no long work itself.
- **Leads** are one line each in `leads.tsv` (name, remit, limits), e.g. sales, research, engineering, infra, product,
  media, qa. A lead starts on first use, parks after hours idle, and resumes the same session next time. Adding a lead is a
  line, not code. Lead names are reserved so no job keyword can take one.
- No session holds the full picture in context: a **digest** command builds fresh state on demand (jobs, sessions, drafts,
  blockers, today's log, goals) and prints `UNAVAILABLE` for a dead source. Nothing is cached.
- Boss and leads run with owner-only send scope; teammate lanes are refused at every entry point.

### 3. Sessions that stay small
- Each lane's daily session rolls to a new part when its context passes a token limit (`BEING_SESSION_ROLL_TOKENS`),
  seeded with a short handoff: a pointer to today's log plus the chat's last messages. Large contexts make every reply slow.
- Graph reads and each detect pass have a hard timeout so one hung call cannot stall a lane.

### 4. Owner approvals in the owner's own words
- Besides `send Dn`, the owner may approve with ordinary phrases (`send it`, `go ahead`, `send the <topic> mail`, a reply
  to the draft card). Plain rules, no model: only a whole message of a known shape counts; anything with a question,
  condition or delay (`send later`, `wait`, `don't send`) sends nothing; more than one possible draft gets one short
  question. `approve.mjs` re-runs the same rules on the message read back from Graph.
- A new draft to the same recipient and thread **supersedes** older live drafts; a superseded draft can never be sent.
- Owner-alias chats never approve drafts.

### 5. Recurring channel publishing
- A daily plan of new shared documents and videos into one team channel: newest versions only, at most 7 links per post,
  drafts and restricted folders held back. The owner gets one message per new batch; posting needs their go message
  (checked in Graph: from them, in their 1:1, newer than the plan). A standing go exists only if the owner grants one.
- Builds on `owner-access` `channel_posts`; adds collect / plan / preview / send and a ledger.

### 6. Owner device sync, quieter
- Run on the device's first time online each day (short poll from morning), with late fallbacks and one evening check.
- Skip quietly while the device is asleep or offline; the evening check catches up before it alerts.
- One dated line per day to the owner, only when both ends finished; nothing for offline days.

### 7. Monitor and local session names
- Monitor shows a keyword column and searches by keyword; scope is this Being only, last 2 days by default.
- On an owner laptop, every new interactive session is named `<date>-<keyword>` from its first real prompt (a prompt
  hook), so `<being> claude <keyword>` resumes it. Jobs, boss, leads and teammate lanes are not renamed.

### 8. Being boxes owned by a person
- When a Being runs on a teammate's box, that teammate is its owner and holds the password; they sign in themselves.
- The owner's authority (above) covers the Being's setup there. Upgrades never overwrite owner-approved local kit
  changes: shipped in 0.5.0 as the install manifest (`.kit-upgrade/CHANGES.txt` flags LOCAL CHANGES). Next: re-apply a
  recorded local patch on top of the new version automatically when it still applies cleanly.

### 9. Model usage reminders
- A cron check reads the Being's weekly model usage and tells the owner once at each threshold (e.g. 80/85/90%),
  so long jobs can move to a smaller model or wait for the reset before a session limit kills them mid-run.

### 10. Watched-host health alerts
- A small cron watcher per remote host the Being looks after: root filesystem read-only, expected data stopped arriving
  for longer than its normal quiet period, host not checkable. One alert per incident; it clears only after a healthy run.
- Host details live in a config file outside the repo; the watcher is read-only and never clears locks.

### 11. Inline chat images
- Save the inline images of a chat message (screenshots the owner pastes) so a lane can read them, next to
  `teams-fetch-attachment.mjs`.

## Open questions for maintainers
- Batch size cap (100) and default gap (20 s): fine as defaults, or per-tenant settings in `being.toml`?
- Should natural-language approval (4) be opt-in per owner (`approval_words = "strict" | "natural"`)?
- Boss/leads (2) needs tmux on the box: make it an optional component like `owner-access`.
