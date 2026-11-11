# Logins and Tools: Whose Account Does What

A Being reaches its tools through three kinds of login: **its own** account, **the owner's** account, or a **key** for one
app. A new Being gets only what the owner ticks at setup, and the owner can always see the full list. This page lists every
login, what it allows in plain words, the setup menu the owner ticks, and the `[access]` key in `being.toml` for each row.

## 1. The Being's own logins

| Tool | Login | What the Being can do with it | Microsoft permission (plain meaning) |
|---|---|---|---|
| Microsoft Teams | Being's own Microsoft 365 account (`<being>@<domain>`) | Read and send in chats it is part of, start new chats, show as Available | `Chat.ReadWrite` (read and write its chats), `ChatMessage.Send` (send), `Chat.Create` (start chats), `Presence.ReadWrite` (its status) |
| Teams channels | Being's own account | List teams and channels, post in a channel | `Team.ReadBasic.All` (see team names), `Channel.ReadBasic.All` (see channel names), `ChannelMessage.Send` (post) |
| Outlook mail | Being's own account | Read and send its own mail | `Mail.ReadWrite` (read and file its mail), `Mail.Send` (send as itself) |
| OneDrive | Being's own account | Upload, share and manage its own files | `Files.ReadWrite` (its own files only) |
| Profile | Being's own account | Read its profile, set its photo | `User.Read`, `User.ReadWrite` |
| Teams web / Outlook web | Being's own browser profile (`state/being-browser/`) | Web pages the Being opens as itself | The same account, signed in once in a headless browser |
| Claude Code | Claude login on this box | Main AI sessions and jobs | A Claude plan seat |
| Codex | Codex login on this box | Quick replies, voice pass, fallback jobs | A Codex plan |
| Memory search | None (local) | Search and write its notes | — |
| Cloudflare Access (machine token) | Being's own service token | Headless SSH to its own box only | One app, one policy |
| SSH key | Being's own key | Log in to boxes where its key is added | Per box `authorized_keys` |

## 2. The owner's logins the Being can use

All off by default; each needs its own tick and, for the Microsoft ones, the owner-access component
(`skills/owner-access/`).

| Tool | Login | What the Being can do with it |
|---|---|---|
| Owner's Teams | Owner's Microsoft 365 account, separate sign-in | Read the owner's chats (`Chat.Read`); send **as the owner only after "send Dn"** |
| Owner's mail | Owner's account, separate sign-in | Read mail (`Mail.Read`); send as the owner only after approval |
| Owner's files and web pages | Owner's browser profile (`state/owner-browser/`) | Read OneDrive/SharePoint, Outlook and Teams web pages as the owner. **The session itself can do anything the owner can in a browser**; the scripts limit it to reading |
| Shared mailbox | Owner's account (`Mail.ReadWrite.Shared`, `Mail.Send.Shared`) | Read replies, create drafts, send a named reviewed batch after a go |
| Teams channel as owner | Owner's account (`ChannelMessage.Send`, `Files.ReadWrite.All`) | Post reviewed messages and files in one named channel after a go |
| GitHub, Azure, Google Cloud CLIs | Owner's login (opt-in only) | Whatever that login allows, often admin rights. Prefer the Being's own account or a narrow token |
| Cloudflare API | A token the owner created | Tunnels, DNS and Access for the whole account |

## 3. Keys for single apps

| Kind | Where | Examples |
|---|---|---|
| App and site logins | `~/.config/<being>/<app>.env` (0600), one folder per Being, never shared with another Being | App stacks, test logins |
| AI model hubs | The tool's own config | Model hub tokens |
| Notion | MCP config | Notion integration token |
| Model proxy | `~/.config/<being>/` | Local model proxy keys |
| Cluster access | `~/.kube/config` | Named clusters only |

## 4. The setup menu: everything the owner can choose

**Everything is off unless ticked**, except the Being's own Teams chat with the owner, which it needs to work at all. The
choices are saved in `being.toml` under `[access]` (key in the last column), shown again at every `--update`, and listed by
`being access`. The installer only signs in to what is ticked; `doctor` fails if a login exists that is not on the list.

| ☐ | Tool | Login used | Level | Risk | Default | `[access]` key |
|---|---|---|---|---|---|---|
| ☐ | Teams chats with the owner | Being | Read + send | Low | **On (required)** | `owner_chat` |
| ☐ | Teams chats with teammates | Being | Read own chat; send to it and to internal colleagues/Beings (`BEING_TEAM_SEND=tenant`, default) | Low | Off | `teammate_chats` |
| ☐ | Teams group chats and channels | Being | Read + post | Medium | Off | `group_chats` |
| ☐ | Being's own mail | Being | Read + send | Medium | Off | `being_mail` |
| ☐ | Being's own OneDrive (share files) | Being | Upload + share by name | Medium | Off | `being_onedrive` |
| ☐ | Teams presence and photo | Being | Set status, photo | Low | Off | `presence` |
| ☐ | Claude Code | Being's Claude seat | Run sessions and jobs | — | On | `claude` |
| ☐ | Codex | Being's Codex login | Quick replies, fallback | — | Off | `codex` |
| ☐ | Memory search | Local | Read + write notes | Low | On | `memory` |
| ☐ | Owner's Teams: read | Owner | Read only | Medium | Off | `owner_teams_read` |
| ☐ | Owner's Teams: send as owner after approval | Owner | Draft → "send Dn" | High | Off | `owner_teams_send` |
| ☐ | Owner's mail: read | Owner | Read only | Medium | Off | `owner_mail_read` |
| ☐ | Owner's mail: send as owner after approval | Owner | Draft → "send Dn" | High | Off | `owner_mail_send` |
| ☐ | Owner's files (OneDrive, SharePoint) | Owner browser | Read only | Medium | Off | `owner_files` |
| ☐ | Owner's Outlook/Teams web pages | Owner browser | Read only | Medium | Off | `owner_web` |
| ☐ | Shared mailbox: read replies | Owner | Read only | Medium | Off | `shared_mailbox_read` |
| ☐ | Shared mailbox: drafts and reviewed batch send | Owner | Draft → go | High | Off | `shared_mailbox_send` |
| ☐ | Teams channel posts as owner (name the channel) | Owner | Draft → go | High | Off | `owner_channel_posts` |
| ☐ | Mail forwarding rules (name sender + subject) | Owner | Pre-approved rule | High | Off | `mail_rules` |
| ☐ | Per-area approvers (name person + area) | — | Changes who can say "go" | High | Off | `area_approvers` |
| ☐ | GitHub: Being's own account or repo-limited token | Being | Branches + PRs | Medium | Off | `github_being` |
| ☐ | GitHub: owner's login | Owner | Whatever the token allows | **Very high** | Off | `github_owner` |
| ☐ | Azure DevOps (pipelines, work items) | Being or owner | Read / run | High | Off | `azure_devops` |
| ☐ | Azure / Google Cloud CLI | Being or owner | Cloud resources | **Very high** | Off | `cloud_cli` |
| ☐ | Kubernetes clusters (name them) | Key | Deploy, read | **Very high** | Off | `kubernetes` |
| ☐ | Notion (name the workspace) | Being integration | Read + write pages | Medium | Off | `notion` |
| ☐ | Cloudflare tunnel for the Being's box | Admin key (setup only) | SSH + desktop links | Medium | On if the Being has a box | `tunnel` |
| ☐ | Cloudflare API on this box | Owner token | Whole account | **Very high** | Off | `cloudflare_api` |
| ☐ | App keys (pick from `~/.config/<being>/`) | Key | Per app | Varies | Off | `app_keys` |
| ☐ | Model hubs | Key | Download models | Low | Off | `model_hubs` |
| ☐ | Local model proxy | Key | Shared AI access | Low | Off | `model_proxy` |
| ☐ | VPN to company sites | Key | Private networks | High | Off | `vpn` |
| ☐ | Owner device sync (laptop) | Owner's laptop SSH | Sync repos and notes | Medium | Off | `device_sync` |
| ☐ | `<being>-desktop` on the owner's laptop | Owner's laptop | Open the Being's desktop | Low | On if the Being has a box | `desktop` |

**Before any owner row works:** both the Being and the owner must be signed in, each in their own separate session, for
that service (section 5). Owner rows are switched on twice on purpose: ticked in `being.toml` (the record) and set `true`
in `ops/teams-kit/owner-access.toml` (what the scripts obey).

```toml
# being.toml
[access]
owner_chat = true      # required
claude = true
memory = true
owner_files = true           # example of an owner row the owner ticked
# every key not listed, or not true, is off
```

Shared mailbox and channel rows have two routes: `graph` (the owner's API session; needs consent to the shared-mailbox
or channel scopes) and `browser` (the owner's own Outlook web or Teams web session, for tenants where an admin has not
consented to those scopes). Set `route` in `owner-access.toml`; the guards and approvals are the same on both.

Owner rows in `being.toml` map to these switches in `owner-access.toml`:

| `being.toml` `[access]` key | `owner-access.toml` switch(es) |
|---|---|
| `owner_teams_read` | `owner_teams_read` |
| `owner_teams_send` | `owner_teams_send_approved` |
| `owner_mail_read` | `owner_mail_read` |
| `owner_mail_send` | `owner_mail_send_approved` |
| `owner_files` | `owner_files` |
| `owner_web` | `owner_web_pages` |
| `shared_mailbox_read` | `shared_mailbox_read` |
| `shared_mailbox_send` | `shared_mailbox_drafts` (drafts) and `shared_mailbox_send` (reviewed batch send); drafts can be on with sending off |
| `owner_channel_posts` | `channel_posts` |
| `mail_rules` | `mail_forward_rules` |
| `area_approvers` | `area_approvers` |

## 5. Separate headless sessions (Teams and Outlook)

The Being works without a screen, so every login is saved once and reused: a Microsoft token cache for the API, and a
hidden browser profile for web pages. **The Being and the owner are each signed in, in their own separate sessions, for
Teams and for Outlook.** They never share a token cache or a browser profile, and nothing falls back from one to the other.

| Service | Being API session | Being browser session | Owner API session | Owner browser session | Sign in with | Who-am-I check |
|---|---|---|---|---|---|---|
| Teams | `BEING_CACHE` with chat scopes | `state/being-browser/` (Teams web) | `OWNER_CACHE` with the owner's chat scopes | `state/owner-browser/` (Teams web) | `being login being --teams` · `being login owner --teams` | Teams token `/me` = the session's account; browser: signed-in account = the same |
| Outlook | `BEING_CACHE` with mail scopes | `state/being-browser/` (Outlook web) | `OWNER_CACHE` with the owner's mail scopes | `state/owner-browser/` (Outlook web) | `being login being --outlook` · `being login owner --outlook` | Outlook token `/me` = the session's account; browser as above |

Add `--browser` to sign in the browser profile for that identity.

| Rule | Plain explanation |
|---|---|
| Separate folders | Being and owner sessions live in different, clearly named places (`being-...`, `owner-...`), caches 0600 and profiles 0700 |
| Check before every action | Each tool asks Microsoft "who am I?" for the service it is about to use (Teams or Outlook), for both identities, and refuses if an account is not the one that session is for. This stops "sent as the wrong person" |
| Never cross over | No script copies, merges or falls back from one session to the other, and no tool takes "the first account in the cache" |
| Owner signs in themselves | The owner types their own password and code. The Being never sees or stores it |
| Both needed for owner access | Owner access for Teams or Outlook stays off until **both** the Being's and the owner's sessions for that service are signed in and checked |
| Expiry is visible | `being access` (and `node sessions.mjs status`) shows each session, whose it is and when it was confirmed. A signed-out session raises one blocker to the owner, not a silent failure |
| Teammate lanes see neither owner session | The grant check refuses them and the fence blocks the files |
| Separate per box | Each box signs in on its own; a session copied from another box is refused (copied logins also log each other out) |

## 6. What the kit does by default

| Area | Default |
|---|---|
| Code hosting | The Being's own account, or a fine-grained token limited to named repos. Owner logins are an explicit tick, and `doctor` warns about admin or delete rights |
| Overview | `being access` prints every login and tool: whose account, what it can do, when it was added |
| Choices | Picked from the menu above, saved in `being.toml`, shown again at every `--update` |
| Keys | One folder per Being (`~/.config/<being>/`), never shared with another Being |
