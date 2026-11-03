# Changelog

Protocol and Operations Kit versions move together: every release bumps `PROTOCOL_VERSION` and `KIT_VERSION` in
`install.sh`, adds an entry here, and is tagged `vX.Y.Z` (the protocol version). Rules: `docs/BIRTH_AND_UPGRADE.md`,
"Versioning". Update a Being with `<being> update` (shows the entries newer than what it runs, then applies them).

## [0.5.0] - 2026-11-03 (kit 0.3.0)

Field fixes from Beings running on teammates' boxes, and patterns proven on a Being in daily use.

### Added
- **Owner mail batches:** one preview for many mails; the owner types `SEND Bn` once; each mail is sent once,
  rate-limited and ledgered, with a summary back (`send-batch.mjs`, `batch-lib.mjs`). Single mails keep `send Dn`.
- **Owner authority:** the owner decides the Being's own rules, workflow and setup; the Being recommends first, then
  does it without asking anyone else (AUTONOMY template, matrix, owner-lane prompt). Hard limits unchanged.
- **Heavy-task lock** (`skills/runner/heavy-lock`): one heavy task per box, waits for free memory and low swap.
- **`<being> update`** and `install.sh --ref <tag|branch>`: pull a release or branch from GitHub, show the changelog
  entries first, re-apply the installed components (`.beings/.kit-components`).
- **Update watcher** (`skills/runner/being-update`, daily `<being>-update.timer`, off until enabled): a new release
  on GitHub becomes one message to the owner listing its bug fixes and new features. The owner replies
  `UPDATE vX.Y.Z` (or `skip vX.Y.Z`) in the 1:1, routed without a model. The Being then updates itself (rollback tag
  `pre-update-vX.Y.Z`), keeps locally changed files, runs `doctor` and `verify.sh`, and reports. When something fails
  it can open a pull request on the protocol repo with a sanitised problem report (opt-in `BEING_UPDATE_REPORT=pr`; needs `gh`
  signed in, and `publish-check` must pass), and tells the owner the link.
- **Install manifest** (`.kit-manifest`): staged upgrades are labelled in `.kit-upgrade/CHANGES.txt` as "upstream only"
  or "LOCAL CHANGES", so owner-approved local edits are never swapped out blindly.
- `harden-box.sh --rdp gnome|xrdp`: xrdp on Ubuntu 24.04, where GNOME's system-mode RDP cannot hand over to the login screen.
- `docs/ROADMAP-v0.3.md`: the next ports (jobs you can enter, boss and lead sessions, small sessions, approvals in the
  owner's words, docs channel publishing, device sync, monitor keywords, owner-held boxes, usage and host alerts).

### Changed
- **Blockers** read Stuck / Why / I need from you; the exact error goes to the log only.
- **Conventions:** one language for all messages, short plain status, verify "sent"/"armed" live, long work becomes a job.
- **Teammate persona:** SOUL headings match without numbering, symbols or case; if none match, teammate lanes get a
  minimal "own name, not an assistant" persona and `verify.sh` warns.
- **Owner asks** are never answered with a bare refusal at triage; setup and login asks go to work.
- `being-memory-sync install --cron` converts the time to box time (Debian/Ubuntu cron ignores `CRON_TZ`);
  `cron.example` no longer relies on `CRON_TZ`.

### Fixed
- **Owner treated as a teammate:** with `OWNER_OID` empty the owner's own messages ran in a teammate lane. The handler
  and `being-teams up` now refuse to start; `verify.sh` fails on empty `OWNER_OID` or `OWNER_DM_CHAT`.
- **Attachments shared across chats:** each chat lane saves to its own folder; the teammate fence allows only that one.
- **Password SSH stayed on** behind cloud-init's `50-cloud-init.conf`: the hardening file is now `01-being-harden.conf`
  (sshd keeps the first value) and the run fails if password SSH is still on.
- **Idle desktop boxes suspended themselves:** `harden-box.sh` masks sleep and suspend.
- **`being-tunnel --dry-run`** wrote a record with fake ids that blocked the real create; a dry run writes nothing.
- Onboarding test unsets `TMUX`, so its tmux calls never reach a live server.
- Batch `SEND` arguments quoted in `being-handle`.
- `being-update` no longer opens a public pull request by default: `BEING_UPDATE_REPORT` defaults to `off`; set `pr` to opt in.

## [0.4.0] - 2026-10-23 (kit 0.2.0)

Operations Kit, Teams kit, owner access, onboarding from `being.toml`, fleet tools. Full list: `docs/PROTOCOL_SPEC.md`,
"Changelog".
