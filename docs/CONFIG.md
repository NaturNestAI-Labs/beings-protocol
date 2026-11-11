# being.toml: one config file per Being

Everything that differs between two Beings lives in one file in the Being's home: `being.toml`. Start from
[`templates/being.toml.example`](../templates/being.toml.example). It holds **no secrets** and is committed with the
Being's home; secrets live in the Being's key folder (`[being].config_dir`, 0700) or in each tool's own 0600 file.

Scripts read it with `scripts/being-config`:

```
scripts/being-config --file being.toml get tunnel.domain          # one value; lists print one item per line
scripts/being-config --file being.toml get box.ssh_port 22        # with a default
scripts/being-config --file being.toml access                     # the setup menu: every [access] key, on|off
scripts/being-config --file being.toml check                      # validate; exit 1 on errors
```

`{name}`, `{linux_user}`, `{config_dir}` and `{workspace}` in any string are filled from `[being]`. A leading `~/` is
expanded on the machine that reads the file (`--raw` keeps it, for paths meant for another machine).

## Sections

| Section | Key | Default | Meaning |
|---|---|---|---|
| (top) | `schema` | `1` | File format version |
| `[being]` | `name` | — | Lowercase letters, digits, dashes. Used in unit names, hostnames, commands (`<name>-desktop`) |
| | `display_name` | — | The name people use in chat |
| | `owner` | — | The owner's name |
| | `timezone` | `UTC` | IANA name; daily logs and session names |
| | `branch` | `main` | Default branch of the Being's home repo |
| | `branch_prefix` | `{name}/` | Prefix for branches the Being creates elsewhere |
| | `workspace` | `~/beings/{name}` | The Being's home on its box |
| | `config_dir` | `~/.config/{name}` | One key folder per Being (0700). Secrets go here, never in git |
| | `linux_user` | `{name}` | The Being's own Linux user |
| `[m365]` | `being_upn`, `owner_upn` | — | Microsoft 365 accounts (`user@example.com`). App and tenant ids go in `ops/teams-kit/.env` |
| | `owner_oid` | `""` | Owner's Entra object id; filled on the box |
| `[models]` | `session`, `job`, `job_small` | `opus`, `opus`, `sonnet` | Main session, background jobs, `--small` jobs |
| | `fast_client`, `fast_model` | `claude`, `haiku` | Quick replies |
| | `codex_fallback` | `false` | Use Codex when Claude hits its usage limit (needs `[access].codex`) |
| `[access]` | see below | all `false` except three | The setup menu |
| `[access.detail]` | `channels`, `mail_rules`, `approvers`, `clusters`, `notion_workspace`, `app_keys` | empty | What the matching `[access]` rows are limited to |
| `[sessions]` | see below | Being only | Headless sign-ins, Being and owner in separate sessions |
| `[box]` | `host`, `lan_host` | `{name}-box`, `{name}-lan` | SSH aliases (tunnel, office network) |
| | `lan_address` | — | Box address on the office network |
| | `office_subnet` | — | CIDR; SSH and RDP are allowed from here only (`harden-box.sh`) |
| | `ssh_port`, `rdp_port` | `22`, `3389` | |
| `[tunnel]` | `domain` | — | Cloudflare zone |
| | `ssh_host`, `desktop_host`, `hook_host` | `{name}-ssh`, `{name}-desktop`, `""` | Route names (`hook_host` only with the Graph webhook) |
| | `allow_emails` | — | Who passes Cloudflare Access (one-time email code) |
| | `session_duration` | `24h` | Access session length |
| | `token_dir` | `~/.config/cloudflared-{name}` | On the Being's box, Linux disk, 0700 |
| | `service_token` | `false` | Machine token for headless SSH |
| | `org_env` | `~/.config/<org>/cloudflare.env` | Admin box only: `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID` |
| `[desktop]` | `rdp_user` | `{name}` | RDP and Ubuntu login user |
| | `local_port` | `13389` | Laptop port for the tunnel forwarder |
| | `end_on_close` | `true` | End the remote session when the viewer closes; `false` leaves it to the reaper (fast reopen) |
| | `reap_grace_sec` | `600` | Reaper ends a session after this long with no viewer |

## `[access]`: the setup menu

Every row is off unless switched on, except `owner_chat`, `claude` and `memory` (the Being cannot work without
them). `check` refuses unknown keys, non-boolean values, and `owner_chat = false`.

| Key | Tool | Login used | Risk |
|---|---|---|---|
| `owner_chat` | Teams chat with the owner (**required**) | Being | Low |
| `claude` | Claude Code sessions and jobs | Being's own seat | — |
| `memory` | Memory search (basic-memory) | Local | Low |
| `teammate_chats` | Teams chats with teammates (own chat + internal colleagues/Beings; `BEING_TEAM_SEND`) | Being | Low |
| `group_chats` | Group chats and channels | Being | Medium |
| `being_mail` | The Being's own mail | Being | Medium |
| `being_onedrive` | The Being's own OneDrive (share by name) | Being | Medium |
| `presence` | Teams status and photo | Being | Low |
| `codex` | Codex (quick replies, fallback) | Being's own login | — |
| `owner_teams_read` | Owner's Teams, read only | Owner | Medium |
| `owner_teams_send` | Send as the owner after "send Dn" | Owner | High |
| `owner_mail_read` | Owner's mail, read only | Owner | Medium |
| `owner_mail_send` | Mail as the owner after "send Dn" | Owner | High |
| `owner_files` | Owner's OneDrive/SharePoint, read only | Owner browser | Medium |
| `owner_web` | Owner's Outlook/Teams web pages, read only | Owner browser | Medium |
| `shared_mailbox_read` | A shared mailbox, read replies | Owner | Medium |
| `shared_mailbox_send` | Shared mailbox drafts and reviewed batch send | Owner | High |
| `owner_channel_posts` | Channel posts as the owner (`detail.channels`) | Owner browser | High |
| `mail_rules` | Pre-approved forwarding rules (`detail.mail_rules`) | Owner | High |
| `area_approvers` | Per-area approvers (`detail.approvers`) | — | High |
| `github_being` | The Being's own GitHub account or a repo-limited token | Being | Medium |
| `github_owner` | The owner's GitHub login | Owner | Very high |
| `azure_devops` | Pipelines, work items | Being or owner | High |
| `cloud_cli` | Azure / Google Cloud CLI | Being or owner | Very high |
| `kubernetes` | Named clusters (`detail.clusters`) | Key | Very high |
| `notion` | One workspace (`detail.notion_workspace`) | Being integration | Medium |
| `tunnel` | Cloudflare tunnel for the Being's box | Admin key, setup only | Medium |
| `cloudflare_api` | Cloudflare API token on the Being's own box | Owner token | Very high |
| `app_keys` | Single-app keys (`detail.app_keys`, files in `config_dir`) | Key | Varies |
| `model_hubs` | Model hub keys | Key | Low |
| `model_proxy` | Local model proxy | Key | Low |
| `vpn` | VPN to private networks | Key | High |
| `device_sync` | Owner device sync | Owner's laptop | Medium |
| `desktop` | `<name>-desktop` on the owner's laptop | Owner's laptop | Low |

Owner rows (`owner_*`, `shared_mailbox_*`, `mail_rules`) need both the Being's and the owner's sessions in
`[sessions]`; `check` fails when one is on without an owner session.

## `[sessions]`: headless sign-ins

The Being works without a screen, so each login is made once and reused. **The Being and the owner each sign in
themselves, in separate sessions**, for Teams and for Outlook. Nothing is copied, merged or shared between them, or
between boxes.

| Key | Session | Who signs in | Default |
|---|---|---|---|
| `being_teams` | Being API session, Teams scopes | Owner or admin, once, device code, as the Being | `ops/teams-kit/state/token-cache.json` |
| `being_outlook` | Being API session, mail scopes | Same, as the Being (a separate sign-in with mail scopes, its own file) | `ops/teams-kit/state/being-outlook-cache.json` |
| `being_browser` | Being browser profile | The Being, once | `{config_dir}/being-browser` |
| `owner_teams` | Owner API session, Teams scopes | **The owner**, once, device code | `""` (off) |
| `owner_outlook` | Owner API session, mail scopes | **The owner**, once | `""` (off) |
| `owner_browser` | Owner browser profile | **The owner**, once | `""` (off) |

Rules: Being and owner paths never coincide (`check` fails); folders are 0700 and files 0600; every script asks
"who am I?" before acting and refuses a session that resolves to the wrong account; the owner's sessions stay empty
until an owner row in `[access]` is on. `skills/teams-kit/verify.sh` signs in silently to each of the four API
sessions and reports whose it is.

Teams kit `.env` keys for the same sessions: `BEING_CACHE` (Being Teams), `BEING_MAIL_CACHE` (Being Outlook, defaults
to `BEING_CACHE`), `OWNER_CACHE` (owner Teams), `OWNER_MAIL_CACHE` (owner Outlook, defaults to `OWNER_CACHE`),
`BEING_BROWSER_PROFILE`, `OWNER_BROWSER_PROFILE`.

## Who reads what

| Reader | Sections |
|---|---|
| `scripts/harden-box.sh` | `[being]`, `[box]` |
| `skills/tunnel/being-tunnel` (admin box) | `[tunnel]`, `[box]` |
| `skills/desktop/being-desktop install` (owner's laptop) | `[tunnel]`, `[box]`, `[desktop]` |
| `skills/desktop/kit-install.sh`, `skills/*/kit-install.sh` | `[being]`, `[desktop]`, `[box]` |
| `scripts/repair.sh` | `[being]` |
