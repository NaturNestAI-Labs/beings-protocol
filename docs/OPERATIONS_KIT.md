# Operations Kit — Running a Being Day to Day

The core protocol gives a Being identity and memory. The Operations Kit adds what a Being needs once it works with a team:
guardrails, an authority matrix, a memory layout that scales, a way to hand off long work, honest status, and a
chat/mail pipeline. Each piece targets a failure mode that shows up once a Being runs unattended, in parallel, on
behalf of people.

| Piece | Where | Installed by |
|---|---|---|
| Guardrails template | `templates/kit/GUARDRAILS.md` → `.beings/GUARDRAILS.md` | `install.sh --with operations` |
| Authority matrix (lanes, scopes) | `templates/kit/AUTONOMY-MATRIX.md` → `.beings/` | `install.sh --with operations` |
| Job-prompt checklist | `templates/kit/JOB-CHECKLIST.md` → `.beings/` | `install.sh --with operations` |
| One-fact memory files + index | `templates/kit/facts/`, `templates/kit/MEMORY-INDEX.md` | `install.sh --with operations` (facts dir) |
| Multi-client launcher | `templates/kit/bin/being` → `bin/<name>` | `install.sh --with operations` |
| Teams/M365 pipeline | `skills/teams-kit/` → `ops/teams-kit/` | `install.sh --with teams-kit` |
| CI cancel guard | `templates/kit/guards/ci-cancel-guard.sh` | by hand (see below) |
| Secret scan before pushes | `templates/kit/guards/publish-check.sh` → `bin/publish-check` | `install.sh --with operations` |
| Memory backup to git | `skills/memory/bin/being-memory-sync`, `being-session-registry` → `bin/` | `--with operations` (armed by `--with memory-sync`) |
| Global guardrails | `.beings/GUARDRAILS.md` → marked block in `~/.claude/CLAUDE.md`, `~/.codex/instructions.md`, `~/.codex/AGENTS.md` | `--with operations` |
| App runners and fleet | `templates/kit/bin/stack-runner`, `desktop-shim` → `ops/kit-templates/` | `--with operations`, then `being stack new` |
| Unit and job templates | `templates/kit/systemd/`, `templates/kit/jobs/` → `ops/kit-templates/` | `--with operations` |
| Status line | `templates/kit/statusline.sh` → `~/.claude/beings-statusline.sh` | `--with statusline` |
| Settings file | `templates/being.toml.example` | `install.sh --config being.toml` |
| Model routing | [MODEL_ROUTING.md](MODEL_ROUTING.md) | `.env` |
| Birth / upgrade | [BIRTH_AND_UPGRADE.md](BIRTH_AND_UPGRADE.md) | — |

## 1. Guardrails

`.beings/GUARDRAILS.md` is a short list of rules that override everything else: attribution, privacy, secrets, comment
style, diagnose-before-fix, fix the pattern, validate every change, stay in scope, and report any guardrail you could not
follow. Keep it short enough to read every session. `install.sh --with operations` also writes it, in a marked block, into
`~/.claude/CLAUDE.md` and `~/.codex/instructions.md` / `~/.codex/AGENTS.md`, so it loads in every Claude Code and Codex
session of that user, even outside the Being's home; `install.sh --update` refreshes the block from `.beings/GUARDRAILS.md`.

## 2. Authority matrix

`AUTONOMY.md` says what the Being may decide. `AUTONOMY-MATRIX.md` adds *who can trigger what, through which path, and how
it is enforced*: the owner's 1:1 (full scope), teammates (reply in the same chat only), messages to the owner (drafts only),
and background jobs (the scope of the request that started them). The rule of thumb: anything that would be hard to undo,
speaks for a human, or commits money/dates/scope goes to the owner first.

## 3. Memory layout

```
.beings/
├── MEMORY.md              ← index: one line per fact, grouped by topic (loads every session, keep it short)
├── MEMORY-2.md            ← overflow index when MEMORY.md grows past a screen or two
├── facts/<slug>.md        ← ONE fact per file: frontmatter (name, description, type) + body with Why / How to apply
└── memory/YYYY-MM-DD.md   ← daily log: what happened, decisions, links to artifacts
memory-graph/              ← knowledge graph (basic-memory skill), searched on demand
```

- **Daily log**: append as you go; every background job and handled message adds a line.
- **Facts**: one file per fact makes them easy to update, link (`[[slug]]`) and delete when wrong. Update an existing fact
  instead of adding a near-duplicate. Store pointers, not secrets (credentials stay in a secret store or a 0600 file
  outside the repo).
- **Index**: the only part that always loads. One line, a hook, and a 🔴 for rules born from corrections.
- **Graph**: for the long tail. Search it at session start for the topic at hand.

## 4. Corrections become rules

When the owner corrects the Being, the correction is written down *in the same turn*: a `facts/<slug>.md` of type
`rule` with **Why** (what happened, dated) and **How to apply**, plus a 🔴 line in the index. Never wait for "later";
mental notes do not survive the session. If the same mistake could happen again mechanically, go one step further:

## 5. Fix the mechanism, not the instance

A rule in memory only helps if the model reads and follows it. When a failure is mechanical, put the guard in code where it
cannot be skipped. Patterns that paid off:

- **CI cancel guard.** Prevents parallel jobs from cancelling each other's CI runs while "tidying up duplicates".
  A wrapper placed first on the jobs' `PATH` in front of the CI CLI blocks every cancel (exit 3) and logs it; bypass is an
  explicit env var. Template: `templates/kit/guards/ci-cancel-guard.sh` (set `CI_GUARD_REAL` to the real binary).
- **Daily batch branch.** When several jobs change one repo in parallel, each merging to the shared branch triggers a CI
  run per merge. Instead: create `batch-YYYY-MM-DD` from the shared branch each day; every job branches from it and merges
  into it; when the day's tasks are green, the Being (not a job) merges the batch once, waits for the single deploy,
  verifies all tasks, then cuts a fresh batch. Put the batch branch name in every job prompt.
- **Send scopes in the sender, not the prompt.** The handler gives each run an opaque grant for its scope (teammates:
  `chats:<ids>`); the send scripts look the scope up and refuse other targets, and no grant means owner-only. That stops
  mistakes and an injection that edits its own environment. Senders also refuse the owner's identity, and the owner sign-in
  is off by default. On a host where kit and model share one OS user this stops mistakes only: an injected run can read the
  token files and the grant key. Injection resistance needs the two-user layout; see `skills/teams-kit/GUARDRAILS.md`.
- **Pinned identity.** Every sender resolves the account by UPN and checks `/me` before posting; never "first account in cache".
- **Watchdog over hope.** Jobs and runs that go idle produce one alert; jobs whose process vanished are marked died.
- **Blocker after two failures.** Auth, permission, lock, quota, network, missing input: two failures → `being-blocker`
  with the exact error and the ask. No sleep/retry loops longer than two minutes.

## 6. Background jobs

A chat-triggered run ends when it replies, and anything it left in the background is killed. Work longer than a few minutes
goes to `being-job`: a detached process with its own session, a result file, and a completion event that wakes the daily
session to **verify** the output (open the files, run the check) before reporting. A model job that exits 0 without a
result file is recorded as `no-result`, not `done`. Write job prompts with `.beings/JOB-CHECKLIST.md`.

## 7. Multi-client launcher

`bin/<name>` starts Claude Code or Codex in the Being's home so `CLAUDE.md` / `AGENTS.md` load: `<name> claude`,
`<name> codex`, `continue`, `resume`, `sessions`, and `today` (the daily session the Teams kit feeds). Keep `CLAUDE.md` and
`AGENTS.md` in sync: Codex reads `AGENTS.md`, not `CLAUDE.md`. The clients' permission prompts and sandbox stay on unless
you opt out with `BEING_SKIP_PERMISSIONS=1` (only on a trusted, single-user host).

## 8. Teams / M365 pipeline

See [skills/teams-kit/README.md](../skills/teams-kit/README.md) and its `GUARDRAILS.md`. For how the pieces fit together
end to end (with diagrams), see [ARCHITECTURE.md](ARCHITECTURE.md).

## 9. Launcher subcommands

| Command | What it does |
|---|---|
| `<name> monitor` | Live, read-only view of jobs and sessions (needs the `monitor` component) |
| `<name> access [--verify]` | The `[access]` list from `being.toml`, and the four sign-in sessions with who-am-I and last confirmed time |
| `<name> login being\|owner [--teams\|--outlook\|--web]` | Device-code sign-in into one session; no flag = Teams and Outlook |
| `<name> stacks list\|status\|down\|audit\|disarm` | Every registered app stack; `down` stops them all; `audit` finds anything armed to start at boot |
| `<name> stack new <app>` | Writes a runner to `~/.local/bin/<app>` and registers it (`--shim` for a desktop tool) |
| `<name> doctor` | Guardrails, memory index size, backup age, secrets folder, logins vs access list, stacks |

**Sign-in sessions.** Four separate MSAL caches: Being Teams (`BEING_CACHE`), Being Outlook (`BEING_MAIL_CACHE`,
default `being-outlook-cache.json` next to it), Owner Teams (`OWNER_CACHE`), Owner Outlook (`OWNER_MAIL_CACHE`, default
`owner-outlook-cache.json` next to it). `login` refuses when two of them point at the same file, and the owner side stays
off until `BEING_OWNER_DELEGATE=1`. The owner's browser session (`--web`) comes from the owner-access component. A
check result is kept in `~/.local/state/<name>/sessions/` (who-am-I and time only, never a token). Each box signs in on
its own; never copy a cache between boxes.

## 10. Memory backup and the auto-memory layer

Claude Code's auto-memory (`~/.claude/projects/<home path>/memory/`: one file per fact plus a `MEMORY.md` index) is an
official memory layer. The kit links it as `.beings/auto-memory-live` (gitignored) so Codex reads the same index, and
`bin/being-memory-sync` snapshots it into `.beings/auto-memory/` in git.

`being-memory-sync run` refreshes the session registry (`.beings/sessions/`, which never forgets a session and exits 2
when one disappears), copies auto-memory, commits, runs `bin/publish-check` when gitleaks is installed, and pushes.
Every scheduled day missed since the last success is logged in `.beings/operations/sync-history.jsonl`; files over
`BEING_SYNC_MAX_MB` (50) stay local and are listed in `large-files-kept-local.tsv`. `being-memory-sync install` arms a
daily user timer at `BEING_SYNC_AT` (22:00, `BEING_TZ` if set) with `Persistent=true`, so a run missed while the box was
off happens at the next boot; `install --cron` uses cron instead. Run `loginctl enable-linger <user>` so user timers run
while nobody is logged in. Only one box of a Being should run the backup.

Claude loads roughly the first 24 KB of an index and silently drops the rest. Keep index lines short and move detail
into topic files; `doctor` and `install.sh --check` warn near the limit (`BEING_MEMORY_INDEX_MAX`).

## 11. App stacks

Every app the Being builds or runs locally gets one runner and is registered (`~/.config/<name>/stacks.tsv`, one line:
name, runner, compose project). Runners: `up` (then `docker update --restart=no`, so nothing starts at boot), `down`
(stop, data kept, works without a valid config), `status`, `restart`, `logs`, `open`, `destroy`, `reset` (typed
confirmation). `<APP>_HOME` points a runner at another checkout. `stacks audit` lists armed containers, `@reboot` cron
lines, enabled user units and login autostart files, except names matching `BEING_BOOT_ALLOW` (default: the Being's
own `<name>`/`being-` services). Desktop tools get a pass-through shim with `up`/`down`/`status`/`autostart on|off`.

## 12. Secrets

One folder per Being: `~/.config/<name>/` (0700), one `<app>.env` per app (0600). Never inside the Being's repo, never on
an NTFS/FAT mount (modes are not enforced there), never shared with another Being. Services load them with a drop-in
(`ops/kit-templates/systemd/secrets-env.conf.example`). `doctor` checks modes, location and filesystem.

## 13. Unit and job templates

`ops/kit-templates/systemd/`: heartbeat service and timer (runs `ops/heartbeat`), the standby/cutover gate (a box holding
`ops/teams-kit/state/STANDBY` never starts the unit, so two boxes never answer at once), wait-for-mount (`ExecStartPre`
that waits for the home on a slow drive), and the secrets drop-in.

`ops/kit-templates/jobs/scheduled-job/`: an off-switch file (`state/off`), `flock` so runs never overlap, the agent only
writes a JSON result file, the script diffs it against what was already reported and sends a digest only when something
is new (state advances only after a successful send). `jobs/research-job/` runs several workers in parallel from
`workers.conf`, then one merge run; once per day, resumable. Schedule with a systemd timer (`OnCalendar=... <Area/City>`)
or cron in box time (Debian/Ubuntu cron ignores `CRON_TZ`; see `cron.example`).
Settings: `BEING_TZ`, `JOB_MODEL`, `JOB_TIMEOUT` (2h), `JOB_ALLOWED_TOOLS`, `JOB_PARALLEL` (research workers at once, 4),
`JOB_SEND_CMD` (gets the digest on stdin; default: the Teams kit DM to the owner) and `BEING_SKIP_PERMISSIONS`.

## 14. Codex on Ubuntu 24.04 and later

Ubuntu restricts unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`), so Codex's `bwrap`
sandbox fails (`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`) and Codex jobs look stuck. Codex always
uses `/usr/bin/bwrap` when present, so a PATH wrapper does not help. On 24.04/25.x add an AppArmor profile for bwrap
(`flags=(unconfined)` plus `userns,`) and load it with `apparmor_parser -r`. Newer releases ship their own
`bwrap-userns-restrict` profile: do not add a second profile for the same binary there, it breaks bwrap for every app.
Check with `bwrap --ro-bind /usr /usr --symlink usr/lib /lib --symlink usr/lib64 /lib64 --unshare-all true` (exit 0).

## 15. Components and being.toml

`--with <name>` takes the built-ins (`operations`, `teams-kit`, `statusline`, `memory-sync`) or any `skills/<name>/`
directory of the kit: its files are copied to `ops/<name>/` (changed upstream files go to `ops/<name>/.kit-upgrade/`), then
`ops/<name>/kit-install.sh <home>` runs with `BEING_NAME`, `OWNER_NAME`, `BEING_CONFIG_FILE`, `BEING_ACCESS` (comma list),
`BEING_KIT_UPDATE` (1 on `--update`) and `BEING_KIT_SOURCE`. Hooks must be idempotent. A component that should install
over `curl | bash` ships `kit-files.txt` (one path per line, `path +x` for executables).

`install.sh --config being.toml` reads `[being] name, owner, tz, track_private`, `[kit] with` and the `[access]` list
(keys set to `true` plus an `allow = [...]` array). The format is a TOML subset: one-level tables, strings, integers,
booleans, arrays, comments; `bin/being-config` reads it. The file is copied into the home; keep secrets out of it.
`--track-private` (or `track_private = true`) commits `.beings-local/`; by default it is never committed.
