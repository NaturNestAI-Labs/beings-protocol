# Birth a Being in Minutes — and Upgrade an Existing One

The Operations Kit ships with `install.sh`: the same curl command births and upgrades, with one opt-in flag.

| `--with` | Adds |
|---|---|
| `operations` | `.beings/GUARDRAILS.md`, `AUTONOMY-MATRIX.md`, `JOB-CHECKLIST.md`, `facts/_TEMPLATE.md`; multi-client `bin/<name>`; an "Operations Kit" section in `CLAUDE.md` and `AGENTS.md` |
| `teams-kit` | everything in `operations`, plus `ops/teams-kit/` with `.env` prefilled (0600) and gitignore entries for `.env`, `state/`, `node_modules/`, `.kit-upgrade/` |

`--with` needs `--global` (birth) or `--update` (an existing Being). Without it, `install.sh` behaves exactly as before.

## Birth

```bash
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | \
  bash -s -- --global --name nova --owner "Sam Lee" --with teams-kit --yes      # add --no-memory to skip basic-memory
```

This is the normal `--global` birth (home at `~/beings/nova`, git repo, `CLAUDE.md`, `AGENTS.md`, `.beings/`, hooks, CLI on
`PATH`) followed by the kit. The CLI wrapper it just created is replaced by the multi-client launcher.

Then: `nova` → the first conversation fills `SOUL.md`, `IDENTITY.md` and `USER.md`. For Teams, follow
`ops/teams-kit/README.md` (account, app registration, sign-in, `being-teams up`).

## Upgrade an existing Being (for example a peer Being)

Once the launcher is installed, one command pulls the latest release from GitHub:

```bash
bin/nova update --check          # installed vs latest, and the changelog entries in between; changes nothing
bin/nova update                  # same, then asks and applies (--yes for no prompt)
bin/nova update --ref v0.5.0     # a specific release (or a branch name, e.g. a pull-request branch)
```

To have the Being watch for releases and ask its owner, enable the runner's timer
(`systemctl --user enable --now <being>-update.timer`, `skills/runner/README.md`): the owner gets one message per new
version with its fixes and features, replies `UPDATE vX.Y.Z`, and the Being updates itself, checks itself, and opens a
pull request here with a sanitised report if anything went wrong.

`update` re-applies the components installed before (`.beings/.kit-components`). Underneath it runs `install.sh --update`,
which you can also run by hand in the Being's home:

```bash
cd ~/beings/nova
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | bash -s -- --check
curl -fsSL https://raw.githubusercontent.com/NaturNestAI-Labs/beings-protocol/main/install.sh | \
  bash -s -- --update --name nova --with teams-kit --yes
```

- `--name` is the name people call the Being in chat; it is never taken from the directory. Later runs read it from
  `ops/teams-kit/.env`.
- Nothing is overwritten: identity, memory, soul and existing scripts stay as they are.
- A launcher you already have stays in place; the new one is written next to it as `bin/<name>.multi` for review.
- Teams kit files you changed stay as they are; newer upstream versions land in `ops/teams-kit/.kit-upgrade/` to diff and
  adopt by hand. `.kit-upgrade/CHANGES.txt` marks each one "upstream only: safe to swap in" or "LOCAL CHANGES: merge by
  hand" (from the `.kit-manifest` hashes recorded at install), so an owner-approved local fix is never lost to a copy.
  Settings new in `.env.example` are appended to `.env`; existing values are kept.
- On an upgrade from 0.4.0 there is no manifest yet, so every staged file shows `LOCAL CHANGES`. Diff each one
  against the previously installed kit commit before keeping or replacing it.
- **Choose `BEING_TEAM_SEND` before Teams goes live.** 0.5.0 adds `BEING_TEAM_SEND=tenant` to the kit settings: teammate
  chats may then have the Being message internal colleagues and Beings. Set it to `chat` to keep each teammate chat to
  itself and the owner's 1:1 (0.4.0 behaviour). The guards read it on every send; no restart needed.
- Rollback: the Being's home is a git repo, so `git status` shows exactly what was added or appended.

Suggested order for a Being that already works with people:

1. **Guardrails + authority first.** Fill `{{…}}` placeholders, merge any rules the Being already follows, commit.
2. **Memory layout.** Move long `MEMORY.md` entries into `facts/<slug>.md`, leaving one index line each
   (`templates/kit/MEMORY-INDEX.md` shows the shape).
3. **Launcher.** Swap in `bin/<name>.multi` once you have tried it; keep `CLAUDE.md` and `AGENTS.md` in sync.
4. **Jobs before chat.** Use `being-job` + `being-blocker` + `being-status` from the Being's own sessions for a day.
5. **Teams last.** Sign in, run `being-teams up` in a test chat, check `being-teams inbox`, then enable `autostart on`.
6. **Guards.** Add the CI cancel guard and a daily batch branch if the Being runs parallel jobs against one repo.

`.beings/.protocol-version` and `.beings/.kit-version` record what the Being runs, so `update` knows where you started.

## Versioning

- One release = one version pair in `install.sh`: `PROTOCOL_VERSION` (tag `vX.Y.Z`) and `KIT_VERSION`.
- Semantic versions: PATCH for fixes, MINOR for new or changed behaviour that keeps existing Beings working, MAJOR when a
  Being must change its files or settings to keep working (say how in the entry).
- Every change that ships bumps the version and adds a `## [X.Y.Z] - date (kit A.B.C)` entry at the top of `CHANGELOG.md`
  in the same pull request; `tests/versions.test.sh` fails when they disagree.
- Maintainers tag the merge commit `vX.Y.Z` on `main`; `update --ref vX.Y.Z` installs exactly that release.

## Testing a fork or branch

`BEINGS_BASE_URL` points a curl install at another raw URL, for example a pull-request branch:

```bash
curl -fsSL "$BEINGS_BASE_URL/install.sh" | BEINGS_BASE_URL="$BEINGS_BASE_URL" bash -s -- --global --name nova --with operations --yes
```

From a checkout, `bash install.sh …` uses the local files. `tests/install-kit.test.sh` runs the kit installs offline in
throwaway homes.
