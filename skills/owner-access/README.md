# Owner Access: the Being acting with the owner's account

Some work needs **the owner's own Microsoft 365 account**, not the Being's: reading the owner's files, drafting in a shared
mailbox the owner can open, posting in a channel as the owner, forwarding a kind of mail the owner gets. This optional
component adds that, on top of the Teams kit. **It installs with every ability off**; the owner switches on one ability at
a time, per Being, in `owner-access.toml`.

Install: `install.sh --with owner-access` (or `skills/owner-access/kit-install.sh <being-home> [being.toml]`). It copies
the scripts into `<being-home>/ops/teams-kit/`, writes `owner-access.toml.example` with everything off, and prints the two
separate sign-ins. Check any time with `node owner-access-doctor.mjs`.

## The four levels

| Level | What it means | Abilities |
|---|---|---|
| 1. Get in | The owner signs in once, in their **own** headless sessions, separate from the Being's | `owner-access-login owner ...` (no switch: nothing else works without it) |
| 2. Research, read only | Read what the owner can read. Never send, edit, move or delete | `owner_teams_read`, `owner_mail_read`, `owner_files`, `owner_web_pages`, `shared_mailbox_read` |
| 3. Act after approval | The Being prepares; an approver types a go for that exact item or batch; a fixed script does it once | `owner_teams_send_approved`, `owner_mail_send_approved`, `shared_mailbox_drafts`, `shared_mailbox_send`, `channel_posts` |
| 4. Act on a pre-approved rule | The owner writes a narrow rule once; the Being applies it and reports every time | `mail_forward_rules` |

Plus `area_approvers`: lets named people (not only the owner) give the go for one area.

## Abilities and their switches

All live under `[abilities]` in `owner-access.toml`, and `[owner_access] enabled = true` is needed as well.

| Switch | Tool | What it does | Needs signed in (Being + owner) |
|---|---|---|---|
| `owner_teams_read` | `owner-read` (Teams kit) | Read the owner's Teams chats | Teams |
| `owner_mail_read` | `owner-mail` (Teams kit) | Read the owner's mailbox, save attachments | Outlook |
| `owner_files` | `owner-web search / shared / ls / get` | Search, list and download the owner's OneDrive and SharePoint files. GET only | browser |
| `owner_web_pages` | `owner-web open` | Read an Outlook or Teams web page as text, no clicks | browser |
| `shared_mailbox_read` | `shared-inbox-monitor.mjs`, `shared-inbox-monitor.sh` | List new mail in a shared mailbox; a job classifies it and tells the team | Outlook |
| `owner_teams_send_approved` | `draft-for-owner.mjs` + `approve.mjs` (Teams kit) | Teams reply as the owner after the owner types `send Dn` | Teams |
| `owner_mail_send_approved` | same | Mail as the owner after `send Dn` | Outlook |
| `shared_mailbox_drafts` | `shared-mailbox-drafts.mjs create / update / plan / preflight` | Create unsent drafts; edit only drafts the Being created | Outlook (browser with `route = "browser"`) |
| `shared_mailbox_send` | `shared-mailbox-drafts.mjs send` | Send a named, reviewed batch of those drafts after a go | Outlook or browser (+ Being's Teams to read the go) |
| `channel_posts` | `channel-posts.mjs preview / apply` | Upload files and post a reviewed batch in one allowed channel after a go | Teams (browser with `route = "browser"`) |
| `mail_forward_rules` | `mail-forward-rules.mjs` | Forward mail a rule covers to the one allowed person who asked | Outlook (+ Being's Teams to read asks) |
| `area_approvers` | `[approvers]` | Named people may give the go for their area | — |

`owner-read`, `owner-mail` and `approve.mjs` also keep the Teams kit's own switch (`BEING_OWNER_DELEGATE=1` and `OWNER_CACHE`
in `.env`); set both.

## Safety rules (enforced in code)

| Rule | How |
|---|---|
| Off by default | Missing config, a missing switch or anything but `true` = off (exit 4). The config is never read from env |
| Owner lane only | A valid handler grant of `full`, `owner-only` or `routine:` scope is required (`scope.mjs`). Teammate grants, forged grants and no grant are refused (exit 3) |
| No model holds the keys | Only the fixed scripts listed in `owner-session.mjs` open the owner's cache or profile, and only after every check. Claude and Codex call those scripts; they never get a token |
| Read is read | Each tool sends every request through a route allowlist (`guards.mjs`): read tools allow GET of named lists only; the browser aborts PUT/PATCH/DELETE and send, mark-read, move and delete actions; refused routes never reach the network |
| One approval, one action | A go must be typed by an approver, in their 1:1 with the Being, with the exact text (`go <batch> <fingerprint>`), newer than the batch, under 24 h old; each go message works once. The fingerprint covers the whole batch, file bytes included, so any change needs a new go |
| Logged and reported | Every as-owner action is a comms-log line `kind: as-owner` with its ability, and the owner gets a short report from the Being's account |
| Pause file per ability | `state/owner-access/<ability>.pause` stops it at once (empty = until removed, an ISO time = until then); forward rules also have `forward-<rule>.pause` |
| Same-box limit | On a one-user host anything running as the Being can read the owner's sessions: the checks stop mistakes, not a determined prompt injection. `owner-access-doctor.mjs` warns until the two-user layout (Teams kit `isolation/`) is in place |

Exit codes: 2 usage or a refused route/caller, 3 lane or approval refused, 4 ability off, 5 paused, 6 sign-in missing or
sessions not separate.

## Separate headless sessions (Teams and Outlook)

**The Being and the owner each sign in, in their own headless sessions, for Teams and for Outlook.** The Being has its own
API token cache (chat and mail scopes) and its own browser profile for Teams web and Outlook web. The owner has their own,
separate token cache and browser profile. Nothing is ever shared, merged, copied or used as a fallback between them.

| Service | Being API session | Being browser session | Owner API session | Owner browser session | Sign in with | Who-am-I check |
|---|---|---|---|---|---|---|
| Teams | `BEING_CACHE` (Chat.ReadWrite, ChatMessage.Send) | `state/being-browser/` (Teams web) | `OWNER_CACHE` (Chat.Read; + channel scopes for `channel_posts`) | `state/owner-browser/` (Teams web) | `being login being --teams`, `being login owner --teams` | Graph `/me` with that cache's Teams token must equal `BEING_UPN` / `OWNER_UPN`; browser: SharePoint `currentuser` must equal the same UPN |
| Outlook | `BEING_CACHE` (Mail.ReadWrite, Mail.Send) | `state/being-browser/` (Outlook web) | `OWNER_CACHE` (Mail.Read; + `.Shared` scopes for shared mailboxes) | `state/owner-browser/` (Outlook web) | `being login being --outlook`, `being login owner --outlook` | Graph `/me` with that cache's Outlook token must equal the UPN; browser as for Teams |

(`being login ...` is the launcher's front end for `owner-access-login being|owner [--teams] [--outlook] [--browser]`.)

- **Check before every action.** Each tool runs the who-am-I check for the service it is about to use, for the Being and the
  owner, and refuses if either account is not the one that session is for.
- **Both needed.** Owner access for Teams (or Outlook, or the browser) stays off until **both** the Being's and the owner's
  sessions for that service are signed in on this box.
- **Separate folders.** Profiles are named `being-...` and `owner-...`, mode 0700; caches are separate 0600 files. Same file,
  overlapping folders or a group/world-readable one: refused.
- **Owner signs in themselves.** The owner types their own password and code (device code for the API, a browser window for
  the web session). The Being never sees or stores the owner's password.
- **Never copied between boxes.** Each sign-in is stamped with this box's id (`state/sessions/`); a session copied from
  another box is refused. Copied logins also log each other out. Sign in again on each box.
- **Teammate lanes see neither owner session.** The grant check refuses them; the Teams kit fence blocks the files.

`node sessions.mjs status` (with the kit `.env` loaded) lists every session, whose it is and when it was signed in.

## owner-web

```
owner-web check | search <text> [--top N] | shared | ls <folder url> | get <url> [--save dir] | open <m365 url> [--wait S] [--shot f.png] [--max N]
```

Read only, through the owner's browser profile (default `state/owner-browser/`, set `owner_browser_profile`). Only https
Microsoft 365 hosts (SharePoint, OneDrive, Office, Outlook, Teams); downloads that redirect elsewhere are refused. API calls
are GET; `open` returns page text and never clicks. Set `[owner_web] my_host` and `root_host`. Needs `playwright-core`
(`npm install --prefix <kit> playwright-core`) and Chrome (`[owner_web] chrome` or `OWNER_WEB_CHROME`).

## Shared mailbox drafts

```
shared-mailbox-drafts.mjs create --input drafts.json [--attach f] [--limit N] [--create]   dry run without --create
shared-mailbox-drafts.mjs update --input drafts.json [--body] [--update]                    add CC (and with --body, replace the body)
shared-mailbox-drafts.mjs plan --batch <name> --input drafts.json [--attach f] --out m.json  manifest + the go command
shared-mailbox-drafts.mjs preflight --manifest m.json                                       checks each draft, sends nothing
shared-mailbox-drafts.mjs send --manifest m.json --go-chat <chat id> --go-msg <message id>
shared-mailbox-drafts.mjs sent-check --manifest m.json
```

Input: a JSON array of `{ to, cc?, subject, body_html | body_text }`. The mailbox comes from `[shared_mailbox] address`; the
owner needs access to it and consent to `Mail.ReadWrite.Shared` (and `Mail.Send.Shared` plus Send As for sending). Drafts
with the same subject and To are skipped; only drafts this Being created (`state/owner-access/shared-mailbox/`) can be
edited or sent. `send`: the go is checked first and spent on that attempt; then every pending draft is preflighted (still a
draft, in Drafts, from the mailbox, same subject/To, CC present, attachment), and they go one by one, `send_gap_seconds`
apart, with a ledger line after each, stopping at the first error. A rerun skips sent ids; an unconfirmed send is checked
against Sent Items, never repeated. At the end every row is looked up in Sent Items.

### Graph or browser route

`[shared_mailbox] route` and `[channel_posts] route` pick how the owner's account is reached; `[routes] <ability>`
overrides it per ability (`shared_mailbox_drafts`, `shared_mailbox_send`, `channel_posts`). Default `"graph"`.

| Route | Uses | When |
|---|---|---|
| `graph` | The owner's API session (`OWNER_CACHE`) | The tenant lets the owner consent to `Mail.ReadWrite.Shared` / `Mail.Send.Shared` / `ChannelMessage.Send` / `Files.ReadWrite.All` |
| `browser` | The owner's browser profile (`state/owner-browser/`, or `OWNER_BROWSER_PROFILE`) | An admin has not consented to those scopes for the app, but the owner can do the same thing in Outlook web or Teams web |

Everything else is the same on both routes: owner lane only, the switch and pause file, the same go, fingerprint and
ledger, and a request allowlist. The browser route needs **both** browser sessions signed in (`being login being
--browser`, `being login owner --browser`) instead of the API ones.

- **Shared mailbox, browser:** opens Outlook web on the mailbox's Drafts view (so nothing is marked read), takes the web
  app's own token for `Mail.ReadWrite.Shared`, closes the page, checks `/me` is the owner, then makes the same calls
  against the Outlook REST API through the same allowlist (no delete, move, reply or other mailbox; send only for the
  approved ids). The owner must have opened the shared mailbox in Outlook web at least once.
- **Channel posts, browser:** files go to the channel's SharePoint folder with the owner's cookies (upload without
  overwrite, read back and verify, never delete; only the folder listed in `[channel_posts] browser_folders` and named in
  the manifest as `browser_folder`). Each post is typed into the Teams web composer (subject + text + one link per file)
  and posted; the page may post only into that channel and never deletes or edits. Posts carry links, not attachment
  cards. The browser who-am-I (SharePoint `currentuser`) runs before anything else.

## Shared inbox monitor

`shared-inbox-monitor.mjs scan --since <iso> --out f.json` lists `[shared_mailbox] folders` (default Inbox and Junk) read
only. `shared-inbox-monitor.sh` is the template job hook: scan, diff against `seen.txt`, and on new mail start one
`being-job agent shared-inbox --notify <chat>` with `shared-inbox-job.md` (copy the `.example`; `@NEW@` and `@DATE@` are
filled in). Two failed scans in a row raise one `being-blocker`. Schedule it with cron through
`owner-access-run shared-inbox-monitor.sh` (a one-hour owner-only grant for that run). Env: `SHARED_INBOX_SINCE`,
`SHARED_INBOX_NOTIFY`, `SHARED_INBOX_PROMPT`.

## Channel posts as owner

```
channel-posts.mjs preview --manifest m.json [--out dir]        local HTML preview + the go command; nothing sent
channel-posts.mjs apply --manifest m.json --go-chat <id> --go-msg <id>
```

Manifest: `{ batch, team, channel, folder?, created, browser_folder?, posts: [{ title, body_html | body_text, files: [/abs/path] }] }`. The
`team/channel` pair must be in `[channel_posts] allowed`. `apply` uploads each file into the channel's files folder under
`<folder>/` (never overwriting), downloads it back and compares bytes; for Office files that SharePoint changes on upload,
`verify-upload.py` checks the package is the same apart from metadata. Then each post goes out with its files attached, one
by one, with a ledger: a rerun continues where it stopped, and anything started but unconfirmed is reconciled against the
channel before going on. Owner scopes: `ChannelMessage.Send`, `Channel.ReadBasic.All`, `Files.ReadWrite.All`.

## Owner mail forwarding rules

One `[[forward_rules]]` block per rule (see the example): which senders and subjects, who may ask (`requesters_domain` or
`requesters`; never the owner or the Being), the words that make a chat or mail an ask, the window (strict asks within
`window_hours` of the mail; loose asks only `loose_before_min`/`loose_after_min` around it), a `block` list, and optional
`code_dm`. Run by cron through `owner-access-run mail-forward-rules.mjs`:

- Asks are read from the owner's inbox and from the Being's own 1:1 chats.
- **Exactly one** person asked within the window: the mail is forwarded server-side (the body never enters logs). Zero or
  several: held, the owner is told, and it is rechecked until the window ends.
- Each mail is forwarded at most once (`state/owner-access/forward/<rule>.json`, marked before sending; a crash is checked
  against Sent Items, never resent). A forward already in Sent Items is skipped.
- Blocked people are refused even when they ask; the owner is told.
- `code_dm = true`: a single one-time code in a fresh mail also goes to the requester's 1:1 with the Being, under a grant for
  that chat only; it is never printed, stored or logged.
- Manual: `--rule <name> --to <addr>` after the owner types `forward <rule> <addr>` (add ` once` and `--owner-once` to pass
  the block list one time).

## Per-area approvers

```toml
[approvers]
shared_mailbox = ["lead@example.com"]
```

With `area_approvers = true`, these people's go counts for that area (`[shared_mailbox] area`, `[channel_posts] area`,
`mail_forward_rules`). The owner can always approve. Hard limits still apply: an approver never unlocks an ability that is
off, another mailbox or channel, or a sign-in.

## Files

| File | Role |
|---|---|
| `owner-session.mjs` | The gate: approved scripts, owner lane, ability, pause, sessions, who-am-I, go check, log and report |
| `oa-config.mjs`, `sessions.mjs` | Config and switches; session stamps and separation rules |
| `guards.mjs` | Route allowlists for every tool |
| `ledger.mjs`, `go-approval.mjs` | Batch fingerprints and ledgers; go checks |
| `mailbox-lib.mjs`, `channel-lib.mjs`, `forward-rules.mjs` | Pure helpers (unit-tested) |
| `browser-route.mjs`, `owner-browser.mjs` | Route choice and the browser route (Outlook web token, SharePoint, Teams web) |
| `owner-web(.mjs)`, `shared-mailbox-drafts.mjs`, `shared-inbox-monitor.mjs/.sh`, `channel-posts.mjs`, `mail-forward-rules.mjs` | The tools |
| `owner-access-login`, `owner-access-run`, `owner-access-doctor.mjs` | Sign-ins, scheduled runs, checks |
| `verify-upload.py` | Office upload integrity check |

Two-user layout: these tools run as the kit user. Model users reach them only if the broker exposes them (add the names to
`isolation/make-shims` for the owner lane only).

Tests: `node --test` in `skills/owner-access` (needs the sibling `skills/teams-kit`).

## One SEND for shared-mailbox manifests

Install both teams-kit and owner-access. Create and review the usual manifests, then
run from the installed kit under an existing owner-lane grant:

```sh
node send-batch.mjs plan --manifest first.json --manifest second.json --approver-id "$APPROVER_ID"
```

The selected directory object ID must belong to an approver already allowed by
`approversFor` for the configured shared-mailbox area. No person is built into the
code. The Being posts one preview in that approver's verified 1:1: every batch,
mail count, To and CC recipients, subjects, total and full SHA-256 set digest.
`--dry-run` prints the preview without storing or posting it.

The approver types exactly uppercase `SEND`, unedited. The existing handler's
`send-batch.mjs send --chat ... --msg ...` path delegates to the shared-mailbox
sender; an authorized owner-lane worker can also call
`shared-mailbox-drafts.mjs send --preview <saved-preview> --go-chat ... --go-msg ...`.
The latter supports a configured area approver's message without granting that
person an owner-session lane. Both paths require exactly one active batch preview;
resolve other open batches before asking for SEND.

The seal covers canonical absolute file names, set membership and the complete
bytes of every manifest. Reordering arguments is harmless. Adding, removing,
replacing, relocating or editing a selected manifest requires a fresh preview and
new SEND. Optional repeated `--manifest` arguments on the direct send path must
match the whole sealed set. Unselected files are never discovered or sent: creating
an unrelated file beside a manifest does not add it to the approved set.

The sender fetches the approval and original preview again, verifies the configured
approver, exact 1:1, Being-authored unchanged preview, exact SEND, chronology and
age, then claims the message atomically. A failed or interrupted run consumes its
approval: reconcile existing ledgers and retire the old preview before creating a
new one. Do not delete consumption records or uncertain ledger entries to retry.
A stopped preview also refuses before the next send. Existing ownership checks,
ability gates, session separation, live draft preflight and per-batch ledgers remain.

**Scheduled sends:** expiry is measured at actual send time, not scheduling time.
Approval is checked again before every mail, after pacing delays; a synchronous
clock check immediately precedes the transport call. At 24 hours or later it stops
with `go is older than 24h at actual send time; create a fresh preview and approval`.
Earlier completed mails remain ledgered. Scheduling a job never extends approval
or reserves a future sending right. Invalid or future timestamps also refuse.
The legacy `go <batch> <fingerprint>` command remains supported and receives the
same actual-send-time check. No scheduler is added by this feature.

The seal covers manifest contents, not fields absent from legacy manifests: those
manifests describe draft identifiers, recipients, subject and attachment name, not
a snapshot of live body or attachment bytes. Existing live draft checks still apply;
this feature does not promise an immutable remote draft body.
