# Operations Kit v0.2 (Beings Protocol v0.4.0)

The full list of changes in Operations Kit v0.2, in five phases. Items marked **(optional)** install switched
off and are turned on per Being. Status reflects the v0.2.0 release.

## Phase 1: Teams kit

| # | What to add | What it is | Goes to (kit) | Status |
|---|---|---|---|---|
| 1 | Reviewed lane overlay | Per-chat sessions, fail-closed teammate fence, optional OS sandbox, group-chat handling | `skills/teams-kit/` | done |
| 2 | Codex fallback on a Claude usage limit | Replies and jobs continue on Codex when Claude hits its limit | `being-handle`, `being-job` | done |
| 3 | `being-job stop <id>` | Clean, intentional job cancel with no failure alarm | `being-job` | done |
| 4 | Reply-all for owner mail | A reply to mail the owner sent goes to the original recipients | `approve.mjs` | done |
| 5 | No canned acknowledgements | Drop the automatic "Got it, thanks." message | `teams-ack.mjs` | done |
| 6 | Wider fence | Teammate fence also blocks the session registry and kit logs | `team-fence.py` | done |
| 7 | Reliable start at boot | Linger on, wait for the data disk and a synced clock, retry presence | `being-teams`, its unit | done |
| 8 | Quieter watchdog | Ignores jobs that are waiting on purpose; shows the last action | `being-watchdog` | done |
| 9 | Better status | Shows sub-agent work; running jobs listed first | `being-status` | done |
| 10 | Job triage list | Running-jobs list for the triage step | `skills/teams-kit/` | done |
| 11 | Complete example config | Missing settings added to the example | `.env.example` | done |
| 12 | Test permissions | Restore the lanes test's run permission | `tests/teams-kit-lanes.test.sh` | done |
| 13 | Richer sending | Images, group chats, pinning, hidden codes | `teams-send-dm.mjs` | done |
| 14 | Readable history | Chat history with reaction names | `teams-read.mjs`, `fmt.mjs` | done |
| 15 | Large attachments | Mail attachments up to 150 MB (upload session) | `mail.mjs` | done |
| 16 | Channel posts | Post to Teams channels | `teams-channel.mjs` | done |
| 17 | Delete own messages | Remove a message the Being sent | `teams-delete-msg.mjs` | done |
| 18 | Profile photo | Set the Being's profile photo | `set-photo.mjs` | done |
| 19 | File sharing | Share files from the Being's OneDrive by name; sweep away "anyone" links | new files + sweep in `being-teams` | done |
| 20 | Docs index (optional) | Pin delivered documents and keep an index | new files | done |
| 21 | Excel rows (optional) | Append rows to a workbook | new file | done |
| 22 | Named sessions | Readable session names per day, lane and job | `being-handle`, `being-job` | done (Codex threads named; Claude names from the lane overlay) |
| 23 | Quiet mode (optional) | Quiet after standup; owner typing from another chat counts as the owner | `being-handle` | done |
| 24 | Group reminder (optional) | Template for a recurring reminder in a group chat | `templates/kit/` | done |

## Phase 2: Operations

| # | What to add | What it is | Goes to (kit) | Status |
|---|---|---|---|---|
| 25 | Memory backup | Nightly commit of memory to git, with catch-up at boot | `being-memory-sync` | done |
| 26 | Session list | Manifest of sessions with a missing-session alarm | `skills/memory/` | done |
| 27 | Auto-memory layer | Client auto-memory as an official layer, readable by Codex, with an index size check | `skills/memory/`, `AGENTS.md` template | done |
| 28 | Search index repair | Rebuild a damaged memory search index | `skills/memory/` | done |
| 29 | Index watcher service | Watcher runs as a service; noisy reminder hooks removed | `skills/memory/` | done |
| 30 | Guardrails for both clients | Global guardrails installed for Claude and Codex | `install.sh` | done |
| 31 | One startup order | Same session-start reading order in every instruction file | `templates/tool-configs/AGENTS.md` | done |
| 32 | Secrets folder | Keys in `~/.config/<org>/`, loaded by services through env files | docs + unit template | done |
| 33 | No hard-coded values | No fixed paths, branches, time zones or emails; `BEING_` setting names | everywhere | done |
| 34 | One launcher | `being` launcher for any Being, including `monitor` | `templates/kit/bin/being` | done |
| 35 | Hooks and status bar | Client hooks and status line installed on each box | `install.sh` | done |
| 36 | Shared skills | One skill set for Claude and Codex | `install.sh` | done |
| 37 | Pre-push secret scan | Scan before pushing to a public remote | `templates/kit/guards/` | done |
| 38 | Private folder in git (optional) | Option to track `.beings-local/` in a private repo | `install.sh` | done |
| 39 | Heartbeat timer | Periodic check-in timer | unit template | done |
| 40 | Cutover flag | Standby gate so two boxes never answer at once | unit template | done |
| 41 | Codex sandbox note | Fix for the Codex sandbox on newer Ubuntu releases | docs | done |
| 42 | Scheduled-job template | Template for a recurring job | `templates/kit/` | done |
| 43 | Multi-worker research (optional) | Several workers in parallel, merged into one result | `templates/kit/` | done |
| 44 | App runner | Runner template and generator: `up`/`down`/`status`/`logs`/`open`, never at boot | `templates/kit/bin/stack-runner`, `being stack new <app>` | done |
| 45 | Fleet of apps | `being stacks`: list, status, stop all, boot audit | `being stacks` | done |
| 46 | Runner rule | Every app a Being builds or runs gets a runner and is registered | `CONVENTIONS.md`, `JOB-CHECKLIST.md` | done |
| 47 | Desktop tool shims (optional) | Same `up`/`down` for desktop remote tools | `templates/kit/` | done |

## Phase 3: Owner access (`--with owner-access`)

| # | What to add | What it is | Goes to (kit) | Status |
|---|---|---|---|---|
| 48 | Owner sign-in with scopes | Owner chooses which of chats, mail, files, calendar to grant | installer step | done (`owner-access-login`; installer prints the steps) |
| 49 | Owner browser session | Search, list and download the owner's files; read web mail and chat pages | `owner-web` | done |
| 50 | Fixed callers only | Only named scripts may use the owner's login | `graph.mjs` | done |
| 51 | Read owner chats and mail | Existing read tools kept | `owner-read`, `owner-mail` | done |
| 52 | Shared mailbox read | Read a shared mailbox | `mail.mjs` | done |
| 53 | Shared inbox monitor | Template that watches a shared inbox for replies | `templates/` | done |
| 54 | Shared mailbox drafts | Unsent drafts; send a named, reviewed batch | `skills/owner-access/` | done |
| 55 | Channel posts as owner | Messages, pages and files in one named channel, as a reviewed batch | `skills/owner-access/` | done |
| 56 | Send as a delegate | Send as another person who granted it | `teams-send-dm.mjs` | done |
| 57 | Mail forwarding rules | Pre-approved rules for login mails and codes | `skills/owner-access/` | done |
| 58 | Per-area approvers | Someone other than the owner can approve a named area | config file | done |
| 59 | Safety rules | Off by default, owner lane only, logged and reported, pause file per ability, `doctor` warning | `skills/owner-access/README` | done |
| 60 | Separate headless sign-ins | Being and owner each signed in, in separate API and browser sessions; identity check before every action | `skills/owner-access/README`, `docs/PROVISIONING.md`, `GUARDRAILS.md`, protocol spec | done |
| 61 | Login commands | `being login being`, `being login owner`, session status in `being access`, `doctor` check | `templates/kit/bin/being` | done |

## Phase 4: Easy onboarding

| # | What to add | What it is | Goes to (kit) | Status |
|---|---|---|---|---|
| 62 | One config file | Everything about a Being in one file | `being.toml`, `install.sh --config` | done |
| 63 | No-admin setup | Install tools without root | `install.sh` | done |
| 64 | Runner without Teams | Job runner and blocker usable without the Teams kit | `skills/runner/` | done |
| 65 | Service units | Session, poller and heartbeat units | unit templates | done |
| 66 | Instant messages | Change notifications through a webhook instead of polling | `skills/teams-kit/webhook/` | done |
| 67 | Box hardening | Own password per box, SSH keys only, firewall | `harden-box.sh` | done |
| 68 | Setup checklist | Linux user, linger, licences, client seats, passing secrets, blocked hosts, rollback | `docs/PROVISIONING.md` | done |
| 69 | Verify and offboard | Test-message check; clean removal | `being-teams verify`, `offboard` | done (`skills/teams-kit/verify.sh`, `offboard.sh`) |
| 70 | Repair | Repair the setup after an OS switch | `install.sh --repair` | done |
| 71 | Desktop from the owner's laptop | `<being>-desktop`: LAN or tunnel, no password prompt, status, cleanup | `skills/desktop/being-desktop` | done |
| 72 | Box side of the desktop | Remote desktop server, firewall rule, tunnel hostname | `harden-box.sh`, `docs/PROVISIONING.md` | done |
| 73 | Session cleanup | End abandoned desktop sessions safely | `skills/desktop/` | done |
| 74 | SSH aliases | `<being>-box` / `<being>-lan` aliases and laptop config files | `being-desktop install` | done |
| 75 | Tunnel per box | `being-tunnel create`: `<being>-ssh` and `<being>-desktop`, access policy made before the hostname | `skills/tunnel/` | done |
| 76 | Connector service | Reads its token from a 0600 file, delivered over SSH | `skills/tunnel/` unit template | done |
| 77 | Token rules | API token stays on the admin box, never printed, never in git, logs or chat; rotate on leak | `skills/tunnel/README`, `doctor` check | done |
| 78 | Token shapes | Secret filter and pre-push scan recognise tunnel tokens | `secrets.mjs`, `publish-check.sh` | done |
| 79 | Machine token (optional) | Service token for the Being's headless SSH, handed over encrypted | `skills/tunnel/` | done; encrypted handover not yet tested end to end |
| 80 | Tunnel record | Ids and rollback steps, no secrets | `skills/tunnel/` | done |
| 81 | Setup menu | Owner ticks every tool and login; saved as `[access]` | `install.sh --config`, `being.toml` | done |
| 82 | `being access` | One page: every login and tool, whose account, what it can do | `templates/kit/bin/being` | done |
| 83 | Access doctor | Fails on a login not in the list; warns on admin or delete rights | `being-teams doctor` | partly: fails on logins outside the list; token-rights warning not yet |
| 84 | Own accounts by default | Being's own Git account or a repo-limited token; owner cloud logins opt-in only | `docs/PROVISIONING.md`, setup menu | done |
| 85 | Key folder per Being | `~/.config/<being>/`, never shared with another Being | `install.sh` | done |

## Phase 5: Fleet and recipes

| # | What to add | What it is | Goes to (kit) | Status |
|---|---|---|---|---|
| 86 | Live monitor | Read-only live view of jobs and client sessions | `skills/monitor/`, `being monitor` | done |
| 87 | Fleet web page | One page for all Beings (design and data contract first) | `skills/fleet-ui/` | design and data contract only |
| 88 | Model limit handling | Detect limits, fall back, cap parallel heavy jobs, resume, deny-list | `docs/MODEL_ROUTING.md` | documented; cap and deny-list not enforced yet |
| 89 | One Being on two boxes | Shared home and memory, single writer, separate logins, cutover flag | `docs/recipes/two-boxes-one-being.md` | done |
| 90 | Local model proxy (optional) | Loopback proxy with backup keys and per-app virtual keys | `docs/recipes/llm-proxy.md` | done |
| 91 | Owner device sync (optional) | Daily fast-forward of the owner's repos, failure-only report | `docs/recipes/owner-device-sync.md` + scripts | done |
| 92 | Boot guard (optional) | Keep the OS first in UEFI boot order; flag CMOS resets | `docs/recipes/boot-guard.md` | done |
| 93 | Tester link (optional) | Temporary link with access policy first and scheduled teardown | `docs/recipes/tester-link.md` | done |
| 94 | Project service unit | Project app as a user unit with its own env file | `docs/recipes/project-service-unit.md` | done |

## Setup menu

At setup the owner ticks what the Being may use, and **everything is off unless ticked**. The one exception is the
Being's own Teams chat with the owner, which it needs to work at all. The menu covers the Being's own logins (Teams
chats, groups and channels, its own mail and OneDrive, presence, Claude Code, Codex, memory search), the owner's logins
(read chats and mail; send as the owner only after approval; owner files and web pages; shared mailbox reads, drafts and
reviewed batches; channel posts as the owner; forwarding rules; per-area approvers), developer and cloud access (the
Being's own Git account or a repo-limited token, owner Git login, CI/work-item tools, cloud CLIs, clusters, a notes
workspace), and infrastructure (tunnel for the Being's box, tunnel API on the box, app keys, model hubs, local model
proxy, VPN, owner device sync, `<being>-desktop`). Each row shows whose login it uses, its level and its risk. The choices
are saved as `[access]` in `being.toml`; `install.sh` signs in only to what is ticked, `being access` shows the list, and
`doctor` fails if a login exists that is not on it.

## Separate headless sign-ins

A Being works without a screen, so every login it uses is saved once and reused: a token cache for the API and a
headless browser profile for web pages. The Being and the owner must each be signed in, **each in their own separate
session**, and never share a token cache or browser profile. Sessions live in clearly named folders (`being-…`,
`owner-…`, mode 0700); every script asks the service "who am I?" before acting and refuses if the account is not the
one that session is for; no script copies, merges or falls back from one session to the other. The owner signs in
themselves, and the Being never sees the owner's password. Owner-access abilities stay off until both sessions are
signed in and checked. `being access` shows each session, whose it is and when it was last confirmed; a signed-out
session raises one blocker to the owner. Teammate lanes can reach neither owner session, and each box signs in on its
own, because copied logins log each other out.
