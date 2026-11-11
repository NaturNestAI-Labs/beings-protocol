# OS isolation: model runs behind kernel boundaries

The fence (`team-fence.py`), scopes and the secret filter stop **mistakes**. They don't stop a prompt-injected run that has a
shell, because on a one-user host the model can read everything the kit can (GUARDRAILS.md, "Threat model"). This directory
moves the model clients behind boundaries the kernel enforces:

| Who | OS user | Sees | Reaches the kit by |
|---|---|---|---|
| Kit: loop, handler, senders, `approve.mjs`, `.env`, token caches, `state/`, `handler.key`, grants, hive tokens | `<being>` (the kit user) | everything | — (runs no model) |
| Owner lane, owner jobs, routines, heartbeat | `<being>-ai` | the workspace (group `<being>-ws`), its own HOME | its run's broker socket |
| Teammate lanes and their jobs | `<being>-team`, always in bubblewrap | its lane dir only, mounted at the workspace path: public soul, CLAUDE.md, this chat's conversation, `share: team` files, `work/` | its run's broker socket (chat fixed by the kit) |

## Pieces

| File | Runs as | What it does |
|---|---|---|
| `../being-launch` | kit user | The one launch seam. `being-launch <owner\|job\|team:<chatId>> [--cwd D] -- claude ...`. Starts the run's broker, builds the bubblewrap sandbox, and runs it as the model user (`users`), as the kit user (`bwrap`), or runs the command unchanged (`off`, the default). Fails closed (exit 5). |
| `../kit-broker` | kit user | One per run, on a unix socket only that run can reach (bind-mounted; SO_PEERCRED must match). Fixed verb table, argv lists, no shell. The grant token lives in the broker's environment, never in the model's. Team brokers mint their own `chats:<chatId>` grant and refuse owner tools, mail and the hive. Paths never cross the boundary: attachments go in as bytes the caller read, saved files come back as bytes. |
| `../kit-client.mjs` + `make-shims` | model user | Shims named like the kit commands (`teams-send-dm.mjs`, `being-job`, `being-status`, `owner-read`, `hive-mcp-stdio` ...), mounted **at the kit path** inside the sandbox. Prompts, `{{KIT}}` and the teammate allowlist don't change; what's behind the path does. |
| `../team-sync` | kit user | Builds a teammate lane dir before each run. Allowlist by construction: only files copied here exist for the run. `share: private` always wins; the bond, hr, audits, inbox, daily logs, `.secrets` and the owner's files are never copied. |
| `model-run` | model user | Root-installed copy at `/usr/local/libexec/<being>/model-run`. Clears the environment, exports the run settings and the model's own credential (from a root-owned file only that user can read), sets umask 002, execs bubblewrap. Nothing secret is ever on an argv. |
| `setup-users.sh` | **root** | Users, groups, `/srv/<being>{,-team}`, `/etc/<being>/claude-<user>.env`, `model-run`, the sudoers snippet (kit user → model users; model users get none), checked with `visudo -cf`. Dry run by default. |
| `migrate.sh` | kit user | `--apply`: home `o-rwx`, traverse ACL to the workspace, workspace group + setgid, token cache out of the workspace, shared claude install, the model user's config, `.mcp.json` hive entry, shims. `--enable`: `BEING_ISOLATION=users` in `.env` (refuses until credentials and the wiring exist). `--check`: `verify.sh`. |
| `verify.sh` | kit user | Post-setup checks with `sudo -n -u <model user> test -r/-w ...` plus sandbox runs through being-launch. `--live` adds one model call per user. |
| `rollback.sh` | kit user (+ printed root part) | `BEING_ISOLATION=off` and the workspace changes back. Dry run by default. |
| `test-sandbox.sh` | kit user | No-root simulation (bwrap mode) on a fixture kit and workspace, plus existence checks against this host's real paths. |
| `wire-in.patch` | — | Historical. The wiring is now applied in `being-handle` / `being-job`: a launch of a sandboxed lane goes through `being-launch`; a no-op while `BEING_ISOLATION=off`. |
| `../model-proxy.mjs` | kit user | One per sandboxed teammate run in `bwrap` mode when no `BEING_SANDBOX_CLAUDE_ENV` is set. Listens on a per-run unix socket bound into the sandbox (or on 127.0.0.1 with `BEING_SANDBOX_NET=host`), accepts only the run's random key, swaps in the kit user's current Claude login and forwards to the API. The run can call the model; it never holds the login, and the key dies with the run. |
| `../model-relay.mjs` | inside the sandbox | Wraps the teammate run's command: serves `127.0.0.1:<BEING_SANDBOX_MODEL_PORT>` (default 8462) inside the run's own network namespace and pipes it to the proxy's socket. |
| `live-check.sh` | kit user | One real teammate run on this host against a synthetic chat id, broker in dry run (`BEING_BROKER_DRY=1`: it logs what it would send, sends nothing): sudo/su/file probes inside the sandbox, a model call, a reply through the broker. |

## Modes (`BEING_ISOLATION` in the kit `.env`)
- `off`: today's behaviour. **Teammate lanes have no hard boundary in this mode**: the fence stops mistakes, not a determined run (shell tricks get past it, and a run without a grant counts as the owner lane). Run teammate lanes under `bwrap`. In short: the fence catches mistakes; bwrap is the boundary.
- `bwrap`: **no root needed.** The same sandboxes, as the kit user. Teammate lanes see only their lane dir with their own
  `/proc`, and on the model proxy their own network namespace. Owner and job runs see the workspace without the kit dir, its state, the hive, `~/.ssh` or `.secrets`. The
  boundary is the mount namespace. A kernel escape lands as the kit user. Teammate lanes need their own model credential:
  `BEING_SANDBOX_CLAUDE_ENV=<file>` holding `CLAUDE_CODE_OAUTH_TOKEN=...` or a gateway key, or (default when that is unset)
  the per-run `model-proxy.mjs`. Either way they never get the kit user's login.
- `users`: the same, as `<being>-ai` / `<being>-team`. The kernel's uid check stands behind the mount namespace.

`BEING_ISOLATION_LANES` picks which runs go behind the boundary: `all` (default) or `team`: only teammate lanes and their
jobs; the owner lane, owner jobs, routines and the warm lanes run exactly as with `off` (live steer relays stay on for
them; messages for a sandboxed lane take the queue instead of a live inject).

**Recommended production setting: `BEING_ISOLATION=bwrap` + `BEING_ISOLATION_LANES=team`.** Inside a teammate run
`no_new_privs` is set (bwrap), so setuid `sudo`/`su`/`pkexec` cannot raise privileges even once the kit user has a sudo
rule. Rollback, one line (takes effect on the next run, no restart):
`sed -i 's/^BEING_ISOLATION=.*/BEING_ISOLATION=off/' <kit>/.env`

## Model credentials (needs the owner)
Each model user has its own credential, so the kit user's `~/.claude/.credentials.json` is never shared or copied. Copying
it would also break both copies the first time one of them refreshes the token.
- `<being>-ai`: the owner runs `claude setup-token` once (browser sign-in, long-lived token) and an admin writes
  `CLAUDE_CODE_OAUTH_TOKEN=<token>` into `/etc/<being>/claude-<being>-ai.env` (root:`<being>-ai`, 0440). Alternative: an
  interactive `sudo -u <being>-ai -i claude` login by the owner, stored in that user's own HOME.
- `<being>-team`: preferably a spend-capped, revocable gateway key (`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`), because
  a teammate run can always read its own credential. Or a second `setup-token`.

## What still runs as the kit user
- The fast lanes (`fast-warm.mjs`, triage and voice). They have no tools and an empty cwd, so a model there has no shell.
  Phase 2: spawn them through `being-launch` too.
- `being-steer`'s live relay. Under the broker, notes always take the durable path (`BEING_STEER_CMD=/bin/false`).
- Anything the owner starts by hand as the kit user. On an isolated box, start interactive sessions with
  `being-launch owner -- claude` (or as `<being>-ai`), never as the kit user inside the workspace: the workspace is
  model-writable, so its `.mcp.json`, hooks and `CLAUDE.md` are untrusted input for the kit user.
- The kit user running `git` in the workspace: use `git -c core.hooksPath=/dev/null`, because `.git/hooks` is model-writable.

## Design notes

**being-launch.** `--expose FILE` makes a kit file the run must read (the soul file) appear read-only at the same path;
`--collect FILE` makes a file the run must write (a job's RESULT file) writable at the same path and copies it back after
the run. Both go through a per-run spool, so the model never needs the kit's own directories. Modes:
- `off` (default): the command runs as is, same OS user; the fence and scopes stop mistakes only.
- `bwrap`: a bubblewrap sandbox as the kit user. The kit dir, its state, token caches, the hive and `~/.ssh` are not
  mounted; the kit path holds the model-side shims. Teammate lanes see only their lane dir, with their own `/proc`.
- `users`: the same sandbox run as `BEING_MODEL_USER` (owner, jobs) or `BEING_TEAM_USER` (teammates) through
  `sudo -n -u <user>`, so the kernel's uid check stands behind the mount namespace.

It fails closed: if the sandbox, the model user, the broker or the model's credential is missing, nothing runs (exit 5).
`BEING_SEND_TOKEN` (the run's grant) goes to the broker, never into the model's environment.

**kit-broker.** One per model run, started by being-launch and stopped after it. The socket is bound into the run (bwrap)
or reachable by the model user only (ACL), and `SO_PEERCRED` must match `--peer-uid`. What runs is decided by the broker:
a fixed verb table, argv lists (never a shell), the kit's own `.env`, and the scope of this run. A team-class broker
mints its own `chats:<chatId>` grant and refuses owner tools, mail and the hive whatever the caller sends.
Protocol: frames of 1 type byte + 4-byte big-endian length + payload.
- client → broker: `H` header JSON `{verb, args, files_in: {argIndex: [{name, b64}]}}`, `I` stdin bytes, `E` end of stdin
- broker → client: `O` stdout, `R` stderr, `F` file JSON `{name, b64}` (for `--out`/`--save` dirs), `X` exit `{rc, tmp}`

Paths never cross the boundary as paths. Every path-in flag (`--attach`, and `--inline path=cid` on mail) travels as
bytes the caller read, in `--flag PATH` or `--flag=PATH` form, and the broker substitutes its own temp file; a file flag
the verb does not declare is refused. mail and the draft verb run the secret scan over those bytes as well as over the
subject and body. Files a command saves come back as bytes. The broker closes the child's stdin before draining the socket: the caller closes only
after the child's answer, and the child answers only after stdin EOF.

**model-proxy.mjs.** One per sandboxed teammate run in `bwrap` mode, next to its broker. Such a run gets
`--unshare-net`: no host network, no host loopback services and no abstract sockets, only its own `lo`. The proxy listens
on a 0600 unix socket bound in at `/run/kit/model.sock`, and `model-relay.mjs` serves it on the run's own loopback, so
`ANTHROPIC_BASE_URL` points at the relay and `ANTHROPIC_AUTH_TOKEN=<PROXY_KEY>`. `BEING_SANDBOX_NET=host` keeps the old
shared network (proxy on host 127.0.0.1); client-side web fetches need it, at the cost of host loopback exposure. The proxy accepts only that key,
swaps in the kit user's current Claude login (read per request, so refreshes are picked up) and forwards to the API. If
the login is about to expire and nothing refreshed it, one tool-less `claude -p` in an empty dir refreshes it.

**node in the sandbox.** The sandbox sees `/usr` only. A `node` installed elsewhere (nvm, `~/.local`, `/opt`) is bound in
read-only at `/run/bin/node`, on the run's PATH, for the client, the shims and the relay; `BEING_NODE_BIN` overrides it.

**team-sync.** Lane layout under `<root>/<tag>/` (`<tag>` = sha1(chatId)[:10], as being-handle): `CLAUDE.md` (teammate
boot file), `SOUL.md` (the public soul; absent → the run is refused), `conversation.jsonl` (this chat's last 400 lines),
`WORK.md` (open team items this chat may see), `shared/` (workspace files with `share: team`), `work/` and `home/`
(kept between runs). `share: private` always wins; `.secrets`, `.git`, `node_modules`, the bond, hr, audits, inbox and
the daily logs are never copied, whatever their frontmatter says.

**team-fence.py.** A PreToolUse hook for teammate runs, the only control while isolation is off. Paths in a tool call are
resolved against the run's cwd (`realpath`, so `./`, `//`, `..` and symlinks resolve) and matched case-insensitively
before the deny rules apply; any error while checking blocks the call. Memory-graph notes are shared work knowledge
except notes about the owner as a person; a note's `share:` frontmatter decides first. Message bodies fed to the sender or
the board by heredoc are text, not file access, and are not scanned for paths (the sender's secret filter still runs).

**setup-users.sh.** Users: the kit user (`.env`, token caches, `state/`, `handler.key`, grants, hive tokens; runs no
model), `<being>-ai` (owner lane, owner jobs, routines; the workspace via group `<being>-ws`, no kit secret) and
`<being>-team` (teammate lanes; only `/srv/<being>-team/<lane>/`, always inside bubblewrap, no shell login). The model
users get no sudo rule; the kit user may start processes as them.

**migrate.sh / rollback.sh.** `--apply` is safe while `BEING_ISOLATION` is off and idempotent. `--enable` backs up and
flips the kit `.env` to `users`, refusing until the credentials and the wiring exist; it does not restart the loop.
`rollback.sh --apply` sets `BEING_ISOLATION=off`, moves the token cache back and restores `.mcp.json`; `--full` also
removes the traverse ACL and the workspace group.

**test-sandbox.sh / live-check.sh.** test-sandbox checks that a teammate run cannot read the owner's memory, the bond,
other lanes, the kit `.env`, token caches or `handler.key`, sees only its own `/proc` and reaches the kit only through its
broker; that an owner/job run reads and writes the workspace but not kit secrets; and that no grant or credential is on
an argv. live-check runs privilege and file probes inside the sandbox (exact errors, never contents), a model call, and
a reply through a dry-run broker. Never run sudo/su outside: every probe runs inside being-launch.
