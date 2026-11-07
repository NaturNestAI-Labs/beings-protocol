# Teams Kit — a Being on Microsoft Teams and Outlook

Gives a Being its own Microsoft 365 identity and a message pipeline that runs unattended on the Being's host:

```
being-teams (loop, every 30 s, no model)
 ├─ teams-presence.mjs      green while running, Offline within 15 min after it stops
 ├─ fast path              webhook kick → pre-connected teams-detect (--wait) → queue, 👀 (pre-connected teams-seen), triage
 ├─ fast-warm.mjs           warm fast-model process per lane (triage + voice), restarted on death / N turns / new day
 ├─ teams-detect.mjs        new messages addressed to the Being → state/queue.jsonl (30 s sweep: the catch-up)
 │    └─ being-handle triage   fast model, read-only, one call per chat: none / react / reply (a direct answer, or an ack
 │                             + needsWork) → teams-ack.mjs, signed in while the model decides
 │         └─ being-handle work   Claude Code daily session per lane (owner, each teammate chat), own send grant per run
 │              ├─ being-job agent|codex|run   long work, detached; wakes the session to verify and report
 │              └─ voice pass   fast model rewords queued replies; numbers and links must survive
 ├─ mail.mjs --detect       log + desktop notification, never auto-reply
 └─ being-watchdog          one alert when a job or run goes idle; marks vanished jobs as died
```

One fast-model session and one work session per day **per lane**: the owner's pair (named by date, opened by
`bin/<name> claude today` / `codex today`) and one pair per teammate chat, so the Being keeps each conversation's context
for the day without one person's run ever resuming another's. Teammate runs are fenced (`GUARDRAILS.md`, Lanes).

## Files
| File | Role |
|---|---|
| `being-teams` | runner: `up / down / status / logs / handler / inbox / autostart on` |
| `being-handle` | `triage / work / voice / warm` stages; all prompt text lives here |
| `fast-warm.mjs` | long-lived fast-model process per lane for triage and voice (being-teams runs it; cold call as fallback) |
| `fifo-wait.mjs` | trigger FIFO for the pre-connected fast-path standbys |
| `being-job` | `agent / codex / run` background jobs; `list / status / log / stop` |
| `being-blocker` | tell the owner at once that something is blocked |
| `send-batch.mjs` | many mails as the owner after one previewed `SEND Bn` (see Mail batches) |
| `being-watchdog`, `being-status` | stall alerts; live "what is running" view (also fed to triage) |
| `triage-jobs.py` | compact running + recently finished job list for the triage snapshot |
| `being-sessions`, `being-steer`, `being-board`, `mesh.py` | session mesh: named live sessions, steering (live or a durable note), today's board |
| `teams-*.mjs`, `mail.mjs` | Graph calls: detect, read, send, ack, presence, mailbox |
| `draft-for-owner.mjs`, `approve.mjs`, `approval.mjs` | write as the owner only via a draft the owner approves in Teams |
| `scope.mjs`, `secrets.mjs` | per-run send grants; outgoing-text secret filter |
| `team-fence.py` | PreToolUse hook for teammate runs: refuses private paths, other sessions, credentials, owner tools |
| `teams-fetch-attachment.mjs` | open an inline image or shared file from a message (exit 3 = not shared with the Being) |
| `owner-read`, `owner-mail` | read-only views of the owner's chats and mail (owner sign-in: opt-in, two-user hosts only) |
| `GUARDRAILS.md` | what is automatic, what is enforced, what is never allowed |

## Set up (about 15 minutes once the account exists)

**Host: Linux.** The runner and handler use `flock`, `setsid`, GNU `find`/`readlink` and systemd user units; on macOS they
fail partly and quietly. `install.sh --with teams-kit` checks for them. Needs Node.js 20+ and Python 3.10+.
Claude Code 2.1.295+ is needed for the teammate fence to block when it fails or times out (`onFailure: block`); older
clients ignore that key, so a fence error or timeout lets the call through.

1. **Accounts.** A licensed M365 user for the Being, and an Entra app registration: public client, "Allow public client
   flows" on, delegated permissions `Chat.ReadWrite ChatMessage.Send Chat.Create User.Read Presence.ReadWrite Mail.ReadWrite
   Mail.Send Files.ReadWrite`, plus `Files.Read.All` to open files people attach. Some tenants require admin consent; ask
   your tenant admin.
2. **Install.** `npm install`, then copy `.env.example` to `.env` (`chmod 600`) and fill it. `install.sh --with teams-kit`
   does the copy and prefills the paths and names.
3. **Sign in as the Being** (device code; refuses any other account):
   `set -a; . ./.env; set +a; node teams-login-device.mjs --upn "$BEING_UPN" --cache "$BEING_CACHE"`
4. **Owner ids.** `OWNER_UPN` and `OWNER_OID` (the owner's object id; visible in the Entra portal).
5. **Owner delegate sign-in: off by default; two-user hosts only.** On a host where the model runs as the same OS user,
   a prompt-injected run can read this token and post as the owner; no check can stop that (`GUARDRAILS.md`, Threat model).
   Only on a two-user host: set `BEING_OWNER_DELEGATE=1` in `.env`, then sign in to a separate cache with narrowed scopes:
   `node teams-login-device.mjs --upn "$OWNER_UPN" --cache "$OWNER_CACHE" --scopes Chat.ReadWrite,ChatMessage.Send,Mail.ReadWrite,Mail.Send,User.Read`
   Without it, drafts still reach the owner with the text to send by hand.
6. **Check:** `node teams-send-dm.mjs --whoami`, then `echo hello | node teams-send-dm.mjs` (lands in the owner's 1:1),
   `npm test`, and `./being-teams doctor`. Doctor fails on a same-user host: there the kit stops mistakes, not injection.
   If no second user is possible, set `BEING_SINGLE_USER_ACK=1` (owner sign-in off) to accept that knowingly (GUARDRAILS.md).
7. **Run:** `./being-teams up` (or `autostart on` for a systemd user unit). `./being-teams inbox` shows traffic.

## OS isolation (two-user layout)
Model runs behind kernel boundaries instead of the regex fence: `being-launch` starts every model client in bubblewrap,
optionally as a separate OS user (`BEING_ISOLATION=off|bwrap|users`). The kit is reached only through a per-run
`kit-broker` socket, and teammate lanes see only their own lane dir (`team-sync`). Root half: `isolation/setup-users.sh`.
Kit half: `isolation/migrate.sh`. Checks: `isolation/verify.sh`. Undo: `isolation/rollback.sh`. Test without root:
`isolation/test-sandbox.sh`. Design, modes and credentials: `isolation/README.md`.

## Talking to it
- People message the Being in Teams. In groups it wakes when @mentioned or named, for any message from the owner
  (`BEING_GROUP_OWNER_WAKES=0` turns that off), and for a sender in a live thread with it (the Being posted there in the
  last 15 min and that sender spoke to it in the last 30). Triage still answers "none" to chatter that is not for it.
- Routing guards: a message that already has a real reply is never run
  again (retries and second sessions); a teammate/group run that ends without replying to a question is reported to the
  owner lane as a `[no reply]` task; a teammate lane's `being-board add handoff` becomes a task in the owner lane; the
  owner's own group messages reach the owner lane as context (no run, no reply from it). Teammate lanes see the open items
  of `.beings/ops/team-pipeline.md` (`BEING_TEAM_PIPELINE`) only if it says `share: team` (soul.py team-work; WORK.md).
- The owner approves drafts by typing `send D3`, `edit D3 <text>`, `skip D3`, `save D3` (email: leave in Outlook Drafts)
  in their 1:1 with the Being. The prompt names the real target chat and a fingerprint; approval is re-checked in Graph.
- Quick questions ("status?", "did X reply?", "is it done?") get the real answer in the first reply, from `being-status`
  and the chat's recent messages, in a few seconds, even while a long run is busy. Real work gets a short acknowledgement
  first and the result later. Triage marks a direct answer `answered: true` (ack-schema.json).

## Model routing
`BEING_FAST_*` drive triage and voice (low effort, seconds); `BEING_SESSION_MODEL` drives the work session;
`BEING_JOB_MODEL` / `BEING_JOB_MODEL_SMALL` drive background jobs (`being-job agent <name> --small ...`).
See `docs/MODEL_ROUTING.md`.

## Design rules
- One identity per cache file, so a message can never go out under the wrong name; senders are pinned and `/me`-checked.
- MSAL caches must be written back after every silent refresh, or the next run authenticates against a dead token.
- Poll by default: subscriptions expire and miss messages while the host sleeps; a 30 s poll costs ~1 s. Webhooks in
  front of the same queue are fine if they follow the rules in docs/ARCHITECTURE.md (Watching), with the poll as catch-up.
- Never answer about an attachment you have not opened (`teams-fetch-attachment.mjs`); if it is not shared, say so.
- Never 👍 a question: it can read as "yes" or as a brush-off.
- A handler run ends when it replies and kills anything it left in the background: long work goes to `being-job`.
- After two failures outside the Being's control, `being-blocker`, not a retry loop.
- Teams is a retained corporate record: nothing personal about anyone goes into it.

## Detection limits
Each tick reads up to `BEING_DETECT_CHATS` chats (default 50, most recently active first where Graph allows ordering) and
the newest `BEING_DETECT_MESSAGES` messages in each (default 8, max 50). A chat that falls outside the first N, or gets more
than M messages between two ticks, reads further back up to `BEING_DETECT_PAGES` pages (default 5) and logs a warning if
even that is all new. Raising the limits costs more Graph calls per tick, so size them to the Being's traffic.
In groups the Being wakes on an @mention or its name as a word; `BEING_NAME_ALIASES` adds names, and `BEING_NAME_STOPLIST`
lists phrases that contain the name but are not about the Being (a place, a product). Triage answers "named in passing"
with action none, but each such wake still costs a fast-model call, so keep the stop-list current.

## Script reference

```
teams-detect.mjs <ISO8601-watermark>
    exit 0 nothing new | 10 new (JSON on stdout) | 11 new, but a chat failed transiently (queue them, keep the watermark)
    exit 1 error (do NOT advance the watermark). Env: BEING_UPN, BEING_NAME, BEING_CACHE (owner values for the delegate
    lane), OWNER_OID (optional), BEING_DETECT_CHATS / _MESSAGES / _PAGES, BEING_NAME_ALIASES / _STOPLIST
    (see "Detection limits").
teams-fetch-attachment.mjs <attachments[].url from the message> [--out <dir>]
    Inline images (Graph hostedContents) and OneDrive/SharePoint file cards; prints {"file","bytes","type"}.
    exit 3 NOT_SHARED (ask the sender to share it with the Being) | 2 not a Microsoft attachment URL, refused | 1 error.
teams-read.mjs --whoami | --list [--top N] | --find <text> | <upn> [--top N]
teams-read.mjs --chat <chatId> [--top N] | --since <messageId> (exit 2 if not found) | --members
    Text keeps the sender's line breaks and lists; reactions show who and when; [file] cards and [image] URLs are listed
    (fetch them with teams-fetch-attachment.mjs). --since prints how many messages came after the anchor (stderr).
    --as <upn>   read as another identity present in BEING_CACHE (used by owner-read)
teams-send-dm.mjs [<upn>] < msg            1:1 with that person (default OWNER_UPN), created if missing
    Every sender here posts only as the Being: the owner's UPN, cache or object id (kit .env on disk) exits 3.
teams-send-dm.mjs --chat <chatId> < msg
    --reply-to <messageId>  quote it (with --chat defaults to BEING_REPLY_TO) | --no-quote
    --attach-url <url> [--attach-name <n>]  file card for a OneDrive/SharePoint item
    --verbatim  skip the voice pass | --whoami  verify the sender token
    --image <png|jpg|gif>  inline image (hostedContents, up to 4 MB, secret-scanned)
    --group <upn,upn,...> --topic <t>  create a group chat (full scope only); posts stdin into it if not empty
    --pin  pin the sent message in its chat | --redact-code  one-time codes masked in the comms log
    --image, --pin, --group and --redact-code send directly (no voice-pass queue).
    BEING_DOCS_INDEX=1: a document link or file card sent to the owner's 1:1 is added to the pinned docs index.
teams-send-dm.mjs --as <upn> --draft <Dn>     (off unless BEING_ALLOW_SEND_AS=1; called by approve.mjs)
    Sends an owner-approved send-as draft from that account's own cache (state/send-as/<upn>.json, signed in with
    teams-login-device.mjs). The account must be in BEING_SEND_AS_UPNS and not the owner; the approval is used once,
    within 10 minutes. state/send-as.stop pauses it.
    Scope comes from the grant named by BEING_SEND_TOKEN (scope.mjs): full | owner-only | chats:<id>,<id>.
    A chats: (teammate) run may also post to internal colleagues and Beings (team-scope.mjs, BEING_TEAM_SEND=tenant|chat).
    No grant = owner-only; a bad or expired one = none (refused). Blocked target, a prompt fingerprint or secret-looking text: exit 3, nothing sent.
    With BEING_VOICE=fast the message is queued in $BEING_STATE_DIR/outbox and sent after the voice pass.
teams-ack.mjs [--preconnect] < {"messages":[detect hits],"actions":[{chatId,messageId,action,text,answered,needsWork,emoji}]}
    action none | react | reply. With no decision (triage failed) a 1:1 message gets a 👍. exit 1 if any failed.
    --preconnect signs in before reading stdin (being-handle starts it while the model is deciding).
teams-detect.mjs --notified <hook queue.jsonl> <offset-file> [--wait <fifo>]
    webhook fast path: only the messages the notifications named. --wait signs in first and reads the queue when "go"
    arrives on the FIFO; teams-seen.mjs --wait <fifo> likewise takes its JSON as one line (being-teams fastpath).
fast-warm.mjs serve | ask <lane> <timeoutMs> <system-prompt file> < turn | prewarm <lane> <system-prompt file>
    being-teams keeps `serve` running (state/fast-warm.sock, log state/fast-warm.log). One `claude -p --input-format
    stream-json` per lane (lean flags, BEING_FAST_MODEL / _EFFORT); a turn over its timeout kills the process and
    being-handle falls back to the cold call. BEING_FAST_WARM=0 off, BEING_FAST_WARM_TIMEOUT_MS (15000; voice 3x),
    BEING_FAST_WARM_TURNS (30 per process), BEING_FAST_WARM_IDLE_MIN (teammate lanes, 120; owner 6 h).
teams-presence.mjs available | offline | status
    available lasts 15 min; the runner refreshes it every ~5 min, so Teams drops to Offline when it stops.
teams-login-device.mjs --upn <user@your-tenant> --cache <file> [--scopes a,b,c] [--add-scopes a,b]
    --add-scopes adds optional ones to the default list: User.ReadWrite (set-photo.mjs), ChannelMessage.Send,
    Team.ReadBasic.All, Channel.ReadBasic.All, TeamMember.Read.All, ChannelMember.Read.All (teams-channel.mjs),
    Mail.Read.Shared (mail.mjs --mailbox).
    The owner's UPN or cache is refused unless BEING_OWNER_DELEGATE=1 in .env (then a warning is printed).
mail.mjs --list [--top N] [--unread] | --search <text> [--top N] | --read <id> | --attachments <id> [--save <dir>]
mail.mjs --detect <ISO8601-watermark>      exit 0 none, 10 new (JSON on stdout), 1 error
mail.mjs --send --to a[,b] --subject S [--cc c] [--attach f1,f2] [--inline f=cid] < body.html   (files < 150 MB, inline < 1 MB)
    Attachment bytes go through the same secret scan as the subject and body. Files of 3 MB and over are uploaded to a
    draft in chunks (upload session), then the draft is sent; a failed upload deletes the draft.
mail.mjs --mailbox <shared@your-tenant> --list | --search <t> | --read <id> | --attachments <id> [--save dir]
    Read-only view of a shared mailbox the sign-in has delegate access to (Mail.Read.Shared, via --add-scopes).
    Owner-lane grants only; the mailbox must be listed in BEING_SHARED_MAILBOXES (empty = off).
draft-for-owner.mjs --chat <owner chatId> [--re "<their message>"] < draft.md     target label resolved from Graph
    Refused: a draft for the owner's 1:1 with the Being, or text that is itself a "send Dn" command.
draft-for-owner.mjs --chat <chatId> --as <upn> < draft.md     a draft sent from another account that granted it
    (BEING_ALLOW_SEND_AS=1); the prompt names the account, and "send Dn" sends it through teams-send-dm.mjs --as.
draft-for-owner.mjs --mail --to a[,b] [--cc c] --subject S [--reply-to <owner messageId>] [--attach /abs/f] < draft.md
    A reply to the owner's own sent mail goes to that mail's recipients (unless --to is given), in its thread; --subject
    retitles the reply.
approve.mjs send|edit|skip|save <Dn> --chat <owner 1:1 chatId> --msg <owner's command messageId>
    Called by being-handle for commands the owner typed; re-reads the command and prompt from Graph (GUARDRAILS.md).
teams-channel.mjs list | post --team <id> --channel <id> [--subject S] [--attach-url U [--attach-name N]] [--dry-run] < body
    list: teams and channels the Being is in, with its role. post: off unless BEING_CHANNEL_POST=1, full-scope grant only;
    same secret and approval-prompt filters as chats. --dry-run renders offline.
teams-delete-msg.mjs <chatId> <messageId>...   soft-delete messages the Being sent (others' are refused, exit 1)
set-photo.mjs <image.png|jpg>                  the Being's own profile photo (User.ReadWrite); owner lane only
share-file.mjs <file> --to a,b [--topic T | --folder P] [--edit] [--folder-link]
    Uploads to the Being's OneDrive under $BEING_SHARE_ROOT/<topic> (default Shared/General), grants sign-in access (read,
    or edit with --edit; the owner always gets edit) and prints the webUrl for --attach-url. Scoped runs may share only
    with the owner and the members of their chats. Never an "anyone" link.
onedrive.mjs tree|perms|url|links <path> | get <path> <file> | mkdir <parent> <name> | move <path> <dest> [name]
onedrive.mjs upload <file> <remote> | delete <path> | invite <path> <emails> [read|write] | revoke <path> <email>
onedrive.mjs links <path> --strip-anonymous      owner lane only (full or owner-only grant)
link-guard.mjs sweep [--path <folder>] [--strip]
    Finds "anyone with the link" shares on the Being's OneDrive (exit 10 if found and not stripped). For a timer, the runner
    can import { sweep } from link-guard.mjs, or run `link-guard.mjs sweep --strip` (e.g. hourly).
docs-index-cli.mjs post <seed.json> | refresh | verify     (optional, BEING_DOCS_INDEX=1)
    One pinned "Docs index" message in the owner's 1:1; entries past BEING_DOCS_INDEX_MAX (60) or the size cap move to
    state/docs-index-archive.jsonl.
workbook-sync.mjs <remote.xlsx> <sheets.json>   write {"Sheet": [[...], ...]} into a workbook on the Being's OneDrive
    (Excel API, works while it is open; cells as text, stale rows cleared). Owner lane only.
scope.mjs mint <full|owner-only|chats:id,...> [ttlHours] | revoke < token | show | owner-read-ok | prune
    mint is the handler's: it needs state/handler.key (0600). Grants without its HMAC are refused (none). In the two-user
    layout only the kit user can read the key; on a same-user host any run can, so mint cannot be restricted (doctor fails).
being-job agent <name> [--small] --notify <chatId> "<self-contained task>"   headless Claude Code
being-job codex <name> [--network] --notify <chatId> "<task>"               Codex, workspace-write sandbox, no network unless --network
    BEING_JOB_ADD_DIRS=/a:/b   extra dirs Codex may write (e.g. a repo worktree)
being-job run <name> --notify <chatId> -- <command...>                     a plain command
being-job list | status <id> | log <id> [n]     from a teammate chat's run: only that chat's own jobs (others exit 3)
being-job stop <id> [reason]     intentional cancel: marked stopped first (no watchdog alert, no completion event), then its
    process group is killed and its grant revoked. Same visibility rule as status.
being-status [--actions N] [--triage] [--chat <chatId>] [--no-jobs]   live view incl. Sessions and Board; --triage: sessions
    as one line (owner triage); --chat: that chat's queue, jobs, sessions and board lines only (fed to its triage). Running
    jobs come first with their last output line; a run's latest actions include its sub-agents'.
triage-jobs.py [--chat <chatId>] [--hours H] [--max N]   running jobs, then jobs finished in the last H hours with their
    first result line; being-handle adds it to every triage snapshot (--chat: that lane's jobs only, by the signed scope)
being-sessions [--all] [--json]     live sessions: name, kind (work/warm/job/heartbeat/other), lane, pid, state alive|idle|ended
    Names: nova-owner, nova-team-<first name>, nova-delegate, nova-warm-<lane>, nova-job-<name>, nova-heartbeat (prefix =
    BEING_NAME). Registry state/sessions.json, written at launch/exit by being-handle, being-job and fast-warm.mjs, checked by pid.
being-steer <name> "<message>"      running → live through Claude Code session messaging (a relay with only SendMessage, in the
    target's permission mode); otherwise, or if that fails → a note in that lane's queue (addressedBy "note"), which triage hands
    straight to the lane's work run (no ack). A live note the run never read goes the durable way when it ends. Jobs: live only,
    else recorded in the job file for its result handler. Teammate lanes: own lane only. exit 0 ok | 2 unknown | 3 refused | 4 unreachable
being-board add promise|done|handoff "<one line>" [--lane <name>] | list [N]   today's board (state/board.jsonl), lane-scoped
being-blocker "<task>" "<why it is stuck, plain words>" "<what you need from the owner>" ["<exact error, logged only>"]
being-teams doctor     file modes; FAIL (exit 1) on a same-user host, louder if an owner token is readable, or if the
                       model user can reach .env, caches, grants or the handler key. WARN instead with
                       BEING_SINGLE_USER_ACK=1 and no owner sign-in
being-handle quiet on|off|status | owner-alias add <chatId> <hours> | remove <chatId> | list
    optional features (Script notes); setting them needs an interactive shell or the owner lane's full grant
being-handle warm | triage | work | work-lane <lane> | voice
    triage: queue.jsonl → owner decisions to approve.mjs → one fast-model call per chat, in its lane's session → acks → work.jsonl
            (fast client: no file tools, empty working directory; everything it needs is in the prompt: LIVE STATE from
            being-status, RECENT CHAT from the comms log for that chat only, the messages). Warm lane process first
            (fast-warm.mjs), cold `claude -p` if it is missing, slow or fails. Code guards: no reaction on a question.
    work:   work.jsonl → per-lane inboxes (state/lanes/) → one `work-lane` runner per lane, in parallel, each under its own lock;
            one call per batch in that lane's session (owner, delegate, each teammate chat; job results and notes go to their
            lane), each with a fresh grant revoked at the end; teammate runs are fenced
    voice:  queued messages → fast model rewords, per lane → sent (after every work run)
```

## Mail batches

Many mails as the owner with one approval (GUARDRAILS.md "Sending as the owner"):

```bash
send-batch.mjs plan --drafts D45-D79 [--label "follow-up"]                     # from staged mail drafts
send-batch.mjs plan --recipients list.csv --subject "Quote {{company}}" [--attach /abs/file] < template.md
send-batch.mjs plan ... --dry-run    # print the preview and simulate the send; nothing stored, posted or sent
send-batch.mjs status [Bn]           # open / sending / done / partial / skipped, with counts
send-batch.mjs stop Bn               # halts before the next mail
```

The owner types `SEND Bn` (or `SEND` with one open batch) or `skip Bn`; the handler runs it with no model. Results:
`state/batches/Bn.results.jsonl` (one line per recipient) and a summary in the owner's 1:1. `SEND Bn` again retries only
the failed rows. CSV needs an `email` column; `{{column}}` placeholders must all have values.

## Script notes

Details moved out of the script headers, so comments stay short.

- **Codex fallback.** When Claude stops with its session or usage-limit message (`BEING_LIMIT_PATTERN`), an owner-lane work
  run is repeated as `codex exec` (workspace-write, network on) with the same prompt and the same grant, and an owner-lane
  agent job is restarted as a Codex job with the same task, name and notify chat (`<id>-fb`; the original is marked
  `limit-fallback` and sends no completion event). Teammate lanes never fall back: their fence is a Claude hook Codex does
  not run; the run fails and goes to retry. `BEING_WORK_FALLBACK=off` turns it off. `BEING_CLAUDE_BIN` / `BEING_CODEX_BIN`
  pick the clients.
- **Session names.** Claude sessions carry readable names (being-sessions). Codex threads the kit starts (the fast codex
  thread, codex jobs, fallback runs) are labelled `<date> <session name>` in Codex's thread index
  (`BEING_CODEX_THREAD_NAMES=0` turns that off).
- **being-watchdog.** A job whose process tree only waits (sleep or flock in a shell loop, e.g. queued behind other jobs) is
  not alerted on. Alerts name the last tool action from the transcript; a run job that resumes a Claude session
  (`--resume <id>` in its command) is followed through that session's transcript.
  A job whose process is gone is marked `died` (exit -1) with a `reason` and goes through being-blocker (the owner's 1:1); an alert that could not be sent is retried for a day.
- **being-job and systemd.** A job started inside a unit (a routine's oneshot) runs in a transient scope of its own, so
  the unit ending does not kill it; the record notes `started_in` and `own_scope`. `BEING_JOB_OWN_SCOPE=off` opts out.
  A signal from outside ends the job as `killed` (exit, `reason`, a line in its exec log); the owner lane is still woken.
- **being-teams at boot.** `autostart on` also enables linger (`loginctl enable-linger`; a warning if that is not allowed),
  so the unit starts without a login; `autostart status` shows it. The unit waits up to `BEING_START_WAIT_SEC` (120) for the
  kit path, for a kit on a disk that mounts late. The loop waits up to `BEING_NTP_WAIT_SEC` (300) for NTP when the clock is
  behind the last sweep (`BEING_NTP_WAIT=auto`; `always` / `off`). A failed presence refresh is retried on the next tick.
- **Quiet mode (optional, `BEING_QUIET_MODE=1`).** `being-handle quiet on` (for example after the daily standup) marks
  today quiet (`state/quiet/<date>`): messages from anyone but the owner get no ack and no run; they are held in
  `state/carryover/<next day>.jsonl` and run in their own lane on the next day (marked `carriedOver`). The owner's messages,
  job results and notes run as usual; delegate drafts wait. `quiet off` ends it for today.
- **Owner alias (optional, `BEING_OWNER_ALIAS=1`).** For a time-boxed window the owner can type from another person's 1:1
  with the Being: `being-handle owner-alias add <chatId> <hours>` (capped at `BEING_OWNER_ALIAS_MAX_H`, default 12) puts
  that chat's messages in the owner lane, marked `ownerAlias`, and the reply goes to that chat. Draft approvals
  (`send Dn`) still need the owner's own account. Anyone in that chat counts as the owner until it expires, so keep the
  window short and `remove` it when done.

- **being-handle locks.** Shared files keep their own flock: `work-queue.lock` (work.jsonl and the lane inboxes),
  `enqueue.lock` (queue.jsonl), `voice.lock` (the outbox flush), the sessions/notes/board locks (mesh.py) and
  `comms.jsonl.lock`. Every claude launch carries a readable session name (mesh.py, being-sessions).
- **being-board.** The owner side sees every line. A teammate chat's run writes and sees only lines tagged with its own
  lane; an owner-side line tagged with a teammate lane is visible to that teammate, so keep it to their task.
- **being-deadman.** Run by its own timer (`<being>-deadman.timer`), never by the loop. Checks: the unit is active, the
  sweep watermark is fresh, loop.log is not silent too long, the webhook subscription is healthy, and failed work/sends
  waiting. Writes `state/deadman.json` and alerts on a change (found, still there every `BEING_DEADMAN_REMIND_MIN`,
  cleared). `--dry-run` writes and sends nothing; `--test-alert` sends one test line. Channels: Teams (the owner's 1:1)
  plus ONE external channel in `~/.config/being-alert/alert.env` (mode 600, outside the kit and git):
  `BEING_ALERT_CHANNEL=none|ntfy|telegram|command` (default none), `NTFY_URL`, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`,
  `BEING_ALERT_COMMAND` (message on stdin), and optional `BEING_ALERT_PING_URL`, pinged on every healthy run so an
  outside service notices when the whole host is down.
- **being-retry.** Each item is keyed (messageId, else jobId, else a hash of the line) and gets at most `BEING_RETRY_MAX`
  (3) attempts, with backoff `BEING_RETRY_BACKOFF_SEC` (120,600,1800). After the last failure it goes to
  `state/failed-handled.jsonl` (or `outbox/dead/`), a blocker is recorded and the owner gets one short line. A key already
  in `failed-handled.jsonl` is never replayed, nor is a message another session already answered.
- **being-routine.** The grant is scope `routine:<chat,...>`: the owner lane, sending only to those chats and the owner's
  1:1, never full. being-job copies the caller's scope into its signed record, so the grant is minted before the job
  starts. `BEING_ROUTINES_FILE` (default `<kit>/routines.conf`, gitignored) holds one `<name> <chat[,chat...]>` per line;
  `owner` as a chat is `OWNER_DM_CHAT`. Each routine's mode is described in `BEING_ROUTINE_SPEC`, a workspace file.
- **being-sessions.** `name lane|warm <lane> [--msgs <jsonl>] | name job <name>` prints the name a launch should use;
  `register --name N --lane L --kind work|warm|job|heartbeat --pid P [--sid S] [--perm M] [--job ID]`;
  `end --name N --pid P [--transcript F]` marks a session ended (live notes it never read go the durable way);
  `lanes` lists known lanes. A teammate chat's run sees only that chat's own sessions.
- **being-teams fast path.** A detect and a 👀 sender wait pre-connected, each on its own FIFO that it holds open
  itself, so the trigger is a short write that never blocks and no descriptor leaks to children. Each standby is
  replaced after use, after 10 min (token age) or when it died (at most one try per 20 s).
- **cache-write.mjs.** Up to ~7 processes share one MSAL cache file. A write goes to a 0600 temp file, is merged under
  flock on `<cache>.lock` with what is on disk (ours wins per entry, nothing else is dropped) and renamed into place.
- **comms-log.mjs.** Without flock it falls back to a plain append (one write call). Hive mail goes to `hive-<mind>`
  conversation files, the Being's own mailbox to `mail`; comms.jsonl stays the global log.
- **fast-warm.mjs.** Each lane is one `claude -p --input-format stream-json` process, started on first use and restarted
  when it dies, after `BEING_FAST_WARM_TURNS` turns, at the day rollover or when the system prompt changes. A turn
  that overruns its timeout kills the process (exit 3; exit 2 = no daemon); being-handle then takes the cold path.
- **mesh.py.** Every session the kit starts has a readable name, sits in a live registry, can be steered and writes to
  the today board. A caller with no grant is the owner side (an interactive session or a shell); a bad, expired or
  unreadable grant, or a `scope.mjs show` that fails or times out, is the `denied` lane, which may address nothing. Nothing here calls a model except `relay()` (a short `claude -p` with only SendMessage). A teammate
  lane may steer or tag only its own lane and sees only its own board lines.
- **soul.py.** `file owner|team|<lane>`: the owner lane gets SOUL.md (+ the bond), a teammate lane the public soul
  (`state/soul-public.md`). `public` regenerates it (exit 1 if a private marker survives). `digest <lane>` and `key <lane>`
  give the warm lane's digest and its key (SOUL, DECISIONS.md, GOALS.md, the lane's board lines, the day). The public soul
  is a section allowlist (`BEING_SOUL_PUBLIC_SECTIONS`): lines about the owner personally are dropped inside kept
  sections, and `PRIVATE_MARKERS` are checked after generation (fail closed). The digest is frozen between key changes, so
  the warm lane's process stays the same from message to message.
- **Team work digest.** Open items come from ONE file the owner keeps for the team (`BEING_TEAM_PIPELINE`), only if its
  frontmatter says `share: team`; only unchecked `- [ ] ` lines go, and `@lanes: a,b` limits an item to those chats.

### Shared-mailbox batches with one SEND

With owner-access installed, `send-batch.mjs plan --manifest first.json --manifest
second.json --approver-id "$APPROVER_ID"` posts one combined preview to the configured
area approver's 1:1. The approver types exactly `SEND`. The manifest set and all file
bytes are sealed; edits or added members need a fresh preview. Exactly one preview
may be active, and every send must still fall within 24 hours of approval.
See owner-access's **One SEND for shared-mailbox manifests** section for grants,
recovery, scheduling, direct invocation and the legacy per-batch go path.
