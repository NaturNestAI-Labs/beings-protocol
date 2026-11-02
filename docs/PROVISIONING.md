# Provisioning a Being: the admin checklist

What a person with admin rights does, once, so a new Being can run on its own box, and how to take it off again.
Each step names who does it. Settings come from the Being's [`being.toml`](CONFIG.md).

| # | Step | Who | Tool |
|---|---|---|---|
| 1 | Config file | Owner | `templates/being.toml.example` → `<home>/being.toml`, `scripts/being-config check` |
| 2 | Linux user, linger, harden the box | Box admin (sudo once) | below, `scripts/harden-box.sh` |
| 3 | Tools without admin rights | The Being's user | `install.sh` (user-local toolchain) |
| 4 | Install the kit | The Being's user | `install.sh --with operations,teams-kit`, `skills/*/kit-install.sh` |
| 5 | Accounts and sign-ins | Owner, tenant admin, the owner for owner sessions | below |
| 6 | Services | The Being's user | unit templates, `systemctl --user enable --now ...` |
| 7 | Tunnel and desktop | Cloudflare admin, owner | `skills/tunnel`, `skills/desktop` |
| 8 | Verify | The Being's user | `ops/teams-kit/verify.sh` |

## 1. Linux user and the box (admin)

- [ ] **Own Linux user** for the Being: `sudo adduser <being>`. Only someone with sudo can do this; the Being cannot.
- [ ] **No sudo for the Being** by default. Grant it only for a named task, and take it back after.
- [ ] **Second user for isolation** (recommended): a separate user that runs the model, so a prompt-injected run cannot
      read the kit's tokens. `skills/teams-kit/isolation/setup-users.sh` (root half) and `isolation/README.md`.
      Without it, `being-teams doctor` fails until `BEING_SINGLE_USER_ACK=1` is set knowingly.
- [ ] **Linger on**: `sudo loginctl enable-linger <being>`. Without it the Being's services stop at logout and stay
      down after a reboot.
- [ ] **System tools** present: `node` 20+, `npm`, `git`, `tmux`, `curl`, `python3` 3.11+. Everything else installs
      into the Being's home without admin rights.
- [ ] **Harden** (from the Being's home, as the admin):
      `sudo scripts/harden-box.sh --config <home>/being.toml --rotate-password [--desktop]`
      - asks for a **new password for this box only** (never reuse one across boxes; never send it in chat)
      - SSH key-only and no root login (refuses to start if the Being or the admin has no `authorized_keys` yet)
      - firewall: SSH (and RDP with `--desktop`) from `[box].office_subnet` only, everything else inbound denied
      - linger, sleep and suspend masked (a desktop login screen would suspend an idle box), and with `--desktop` an RDP server:
        GNOME Remote Desktop in system mode on 25.04 and later, xrdp on 24.04 (where the GNOME login handover fails); `--rdp` overrides
      - SSH key-only in `01-being-harden.conf`, which sorts before cloud-init's file; the run fails if password SSH is still on
      - `--dry-run` prints every command first. Test a new key login before closing your session.

## 2. Microsoft 365 account (tenant admin + owner)

- [ ] **Licence** with Teams and an Exchange mailbox for the Being's account (`[m365].being_upn`).
- [ ] **Teams enabled** for that account, and external/guest chat policies match what the Being should reach.
- [ ] **Display name and photo** people will recognise (the Being's name, not a person's).
- [ ] **App registration**: public client, "Allow public client flows" on, delegated permissions as listed in
      `skills/teams-kit/README.md` ("Set up"). If the tenant needs **admin consent**, the tenant admin grants it once.
- [ ] **Owner ids**: `OWNER_UPN`, and `OWNER_OID` (the owner's object id, from the Entra portal) in the kit `.env`.

## 3. Sign-ins: Being and owner, each in separate sessions

The Being works without a screen, so each login is made once and reused. **The Being and the owner each sign in
themselves, in separate sessions, for Teams and for Outlook.** No session is copied, merged or shared, and no
session is copied between boxes: each box signs in on its own (copied logins log each other out).

| Session | Account | Who signs in | Stored in | `being.toml` |
|---|---|---|---|---|
| Being Teams | the Being | owner or admin, device code, as the Being | `BEING_CACHE` (0600) | `[sessions].being_teams` |
| Being Outlook | the Being | same, as the Being | `BEING_MAIL_CACHE` (default `being-outlook-cache.json` next to `BEING_CACHE`; older installs fall back to `BEING_CACHE`) | `being_outlook` |
| Being browser | the Being | the Being, once | `BEING_BROWSER_PROFILE` (0700) | `being_browser` |
| Owner Teams | the owner | **the owner, themselves** | `OWNER_CACHE` (0600), never the Being's file | `owner_teams` (off) |
| Owner Outlook | the owner | **the owner, themselves** | `OWNER_MAIL_CACHE` (default `owner-outlook-cache.json` next to `OWNER_CACHE`) | `owner_outlook` (off) |
| Owner browser | the owner | **the owner, themselves** | `OWNER_BROWSER_PROFILE` (0700) | `owner_browser` (off) |

Steps (in `ops/teams-kit`, after `set -a; . ./.env; set +a`):

1. [ ] **Sign in the Being for Teams**:
       `node teams-login-device.mjs --upn "$BEING_UPN" --cache "$BEING_CACHE"`
       Open the code in a private window, choose "Use another account", sign in **as the Being**. A sign-in as anyone
       else is refused and the existing session is left untouched.
2. [ ] **Sign in the Being for Outlook.** The default scope list above already asks for mail; confirm it with
       `node whoami.mjs --upn "$BEING_UPN" --cache "$BEING_CACHE" --scopes Mail.ReadWrite,Mail.Send,User.Read`.
       If it fails (mail consent missing), sign in again with the **full** list, Teams and mail together (a new
       sign-in replaces the file): `--scopes Chat.ReadWrite,ChatMessage.Send,Chat.Create,User.Read,Presence.ReadWrite,Mail.ReadWrite,Mail.Send`.
       With a separate `BEING_MAIL_CACHE`, sign in to that file with the mail scopes instead.
3. [ ] **Being browser profile** (only if the Being opens web pages as itself): create `BEING_BROWSER_PROFILE`
       with mode 0700 and sign in once as the Being.
4. [ ] **Only if an owner row is on in `[access]`** (and on a two-user host): set `BEING_OWNER_DELEGATE=1`, then
       **the owner signs in for Teams themselves**, to their own cache, with narrowed scopes:
       `node teams-login-device.mjs --upn "$OWNER_UPN" --cache "$OWNER_CACHE" --scopes Chat.Read,User.Read`
       (read only; with `owner_teams_send` on: `Chat.ReadWrite,ChatMessage.Send,User.Read`)
5. [ ] **The owner signs in for Outlook themselves**: to a separate `OWNER_MAIL_CACHE` with `Mail.Read,User.Read`
       (`Mail.ReadWrite,Mail.Send` only if `owner_mail_send` is on), or to `OWNER_CACHE` again with the Teams and mail
       scopes in one list (a new sign-in replaces that file). The owner types their
       own password and code; the Being never sees or stores it. The owner browser profile is signed in the same way.
6. [ ] **Verify**: `./verify.sh --no-send` asks Microsoft "who am I?" for each of the four API sessions (Being Teams,
       Being Outlook, owner Teams, owner Outlook) and fails if one resolves to the wrong account, if owner and Being
       share a file or profile, or if an owner cache exists while owner access is off.

## 4. Claude and Codex (owner)

- [ ] A **Claude seat** for the Being (`[access].claude`) and, if ticked, a **Codex login** (`[access].codex`).
- [ ] **Separate logins per box**: sign in on each box with `claude` and `codex` once. **Never copy token or
      credential files between boxes or from a person's machine**: two boxes on one login keep logging each other out.
- [ ] The Being's own accounts by default. GitHub: the Being's own account or a repo-limited token
      (`github_being`); the owner's GitHub, Azure or Google logins only when ticked (`github_owner`, `cloud_cli`).

## 5. Passing secrets

- [ ] **Never in chat, mail, tickets or docs**, not even masked. Check a secret exists with `test -s`, never `cat`.
- [ ] Encrypt to the receiver's SSH key with `age`: `age -R <their ~/.ssh/id_ed25519.pub> -o secret.age secret.env`,
      send `secret.age`, they run `age -d -i ~/.ssh/id_ed25519 -o secret.env secret.age && chmod 600 secret.env`.
      Read back (they confirm a hash, not the value), then shred the plain copy: `shred -u secret.env`.
- [ ] Secrets live in the Being's key folder `[being].config_dir` (0700) or the tool's own 0600 file, on a Linux disk
      (on NTFS/FAT, `chmod` does nothing). Never in the Being's git repo.
- [ ] A secret that was seen anywhere it should not be is **rotated**, not just deleted.

## 6. Networks that block raw GitHub downloads

Some office networks block `raw.githubusercontent.com`, so `curl … install.sh | bash` fails. Use `git clone` of the
kit repo and run `./install.sh` from the checkout; every `skills/*/kit-install.sh` runs from the checkout too.

## 7. Services (the Being's user)

- [ ] Teams kit: `ops/teams-kit/being-teams autostart on`; dead-man timer per `skills/teams-kit/README.md`.
- [ ] Without the Teams kit: `skills/runner/kit-install.sh <home>`, then enable `<being>-session`,
      `<being>-heartbeat.timer` (and `<being>-poller` for your own poller).
- [ ] Optional: Graph webhook (`skills/teams-kit/webhook/`), desktop reaper (`skills/desktop/`).
- [ ] **Installed is not running**: `systemctl --user is-active <unit>` for each; `verify.sh` fails an enabled unit
      that is not active and warns about an installed one that is not enabled.

## 8. Tunnel and desktop (Cloudflare admin, owner)

- [ ] Admin box only: `~/.config/<org>/cloudflare.env` (0600). The API token never goes to a Being's box.
- [ ] `being-tunnel create <being> --config <home>/being.toml` (skills/tunnel): Access apps before DNS, connector
      token piped straight to the box, connector unit with `--token-file`. Commit the record file (ids only).
- [ ] Owner's laptop: `being-desktop install <being> --config <being.toml>` (skills/desktop).

## 9. Repair after an OS switch or reinstall

`scripts/repair.sh <home> [--shared-sessions <dir>]` re-installs the per-machine pieces (basic-memory and the memory
project, the Teams kit packages, the session-transcript link), reloads the user units and reports any enabled unit
that is not active. `--dry-run` shows the plan. Sign-ins are **not** restored by copying: sign in again (section 3).

## 10. Rollback and offboarding

1. On the Being's box, in `ops/teams-kit`: `./offboard.sh` (dry run), then `./offboard.sh --yes`: stops and disables
   the Being's units, deletes the Graph subscription, revokes send grants and the handler key, removes the local
   sign-ins (both Being and owner sessions and browser profiles), marks the host standby.
2. Admin box: `being-tunnel delete <being>` (DNS, routes, connector and its token, tunnel, service tokens, Access apps).
3. Tenant admin: revoke the Being's sign-in sessions and app consent; the owner revokes their own sessions if they
   signed in on the box; remove the licence if the Being is retired.
4. Free the Claude and Codex seats (`claude /logout`, `codex logout` on the box first).
5. Owner's laptop: remove `~/.local/bin/<being>-desktop`, `~/.config/<being>-box/`, the `<being>-box` SSH block.
6. Box admin: remove the Being's keys from `authorized_keys`, `sudo loginctl disable-linger <being>`, then lock or
   delete the user. Undo hardening: remove `/etc/ssh/sshd_config.d/01-being-harden.conf` and the `being ssh/rdp`
   firewall rules.
7. Keep the Being's home repo: its memory and the tunnel record are the history of what it did.
