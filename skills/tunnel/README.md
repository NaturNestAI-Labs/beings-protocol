# Tunnel: reach a Being's box from anywhere (optional)

A private link from the Being's box out to Cloudflare. SSH and the remote desktop work from anywhere, no port opens on
the office network, and Cloudflare Access checks who you are (one-time email code) before anything reaches the box.
Off by default; switch on per Being with `[access].tunnel = true` and the `[tunnel]` section of `being.toml`.

| What | Where |
|---|---|
| One remotely managed tunnel per Being box, `<being>-box` | Cloudflare |
| `<being>-ssh.<domain>` → `ssh://localhost:22`, `<being>-desktop.<domain>` → `rdp://localhost:3389`, everything else 404 | Tunnel ingress |
| One Access app + allow policy per hostname (people from `[tunnel].allow_emails`), created **before** the DNS record | Cloudflare Access |
| Connector user unit `cloudflared-<being>.service`, `--token-file`, linger on | The Being's box |
| Optional machine token for headless SSH, in a **separate** `non_identity` policy | Cloudflare Access + receiving box |
| Optional `<being>-hook` route for the Graph webhook, Access bypass for the published notification ranges only | skills/teams-kit/webhook |
| Record file `tunnel-<being>.json`: ids, log and rollback steps, never secrets | The Being's home (commit it) |

## Before you start

- Admin box: `python3` 3.11+, `ssh` to the Being's box (`[box].host`), `age` only for service tokens.
- `~/.config/<org>/cloudflare.env` (0600) on the **admin box only**, with `CF_API_TOKEN` (Tunnel edit, Access apps and
  policies edit, Access service tokens edit, DNS edit on the zone), `CF_ACCOUNT_ID`, `CF_ZONE_ID`. Point
  `[tunnel].org_env` at it.
- The Being's box: `cloudflared` installed, linger on (`sudo loginctl enable-linger <user>`, once).

## Commands (admin box)

```
being-tunnel create <being> [--config being.toml] [--record f] [--box alias] [--no-desktop] [--dry-run] [--keep-partial]
being-tunnel status <being>               tunnel health, each route: Access app, ingress, DNS, unauthenticated probe
being-tunnel rotate <being>               new connector secret, pushed straight to the box; the old one stops working
being-tunnel delete <being> [--yes]       DNS → ingress → connector + token on the box → tunnel → tokens → Access apps
being-tunnel service-token <being> --to <alias of receiving box>  [--identity ~/.ssh/id_ed25519]
being-tunnel service-token <being> --out handover.age --recipient <their ssh .pub>    (hand the file over yourself)
being-tunnel service-token <being> --revoke
being-tunnel hook <being> --ranges <file> [--port 8790]     |  being-tunnel hook <being> --remove
```

`create` refuses if a tunnel or DNS record with those names exists, checks the box first (reachable, Linux disk for the
token, `cloudflared`, linger), and rolls back everything it made if a later step fails (`--keep-partial` keeps it).
Every change to the ingress list re-reads it right before the write. Each created id is written to the record at once.

## Token rules (built in, not just written down)

| Rule | How the tool enforces it |
|---|---|
| The API token stays on the admin box | Read only from `org_env` (refused unless 0600); never sent to a Being's box, never printed |
| The connector token goes straight into a file | Fetched from the API and piped over SSH stdin into `<token_dir>/token` on the box; never printed, never on argv, never saved on the admin box, never in chat |
| File, not command line | The connector unit runs `cloudflared tunnel run --token-file`; a token on argv is visible in `ps` |
| Right disk, right permissions | Token file 0600 in a 0700 dir, checked after writing; a Windows/network filesystem (where chmod does not hold) is refused |
| Never in git, logs, chat, docs or job output | The record holds ids only; token dirs live outside the repo; the Teams kit's secret filter refuses connector and service-token shapes |
| Never print, even masked | No `cat`, no "first 4 characters". Check a token exists with `test -s` (`status` does) |
| Login output goes to `/dev/null` | `cloudflared access login` prints a session token: always `>/dev/null 2>&1` |
| Machine tokens are handed over encrypted | `age`-encrypted to the receiver's SSH key, decrypted there, read back by hash, plaintext kept only in memory |
| Temporary test tokens are deleted | An end-to-end check uses its own token in its own policy, both deleted right after |
| Leak = rotate | A seen connector token: `rotate`. A seen service token: `service-token --revoke`, then a new one. Record it; deleting the message is not enough |
| Fresh read before every change | The ingress list is read right before every write |
| Teammate runs cannot touch it | Keep token dirs and `org_env` in `BEING_FENCE_DENY` for team-fence.py |

## After create

- SSH from a laptop: `cloudflared access ssh` in `~/.ssh/config` (skills/desktop `being-desktop install` writes it).
- Desktop: `<being>-desktop` on the owner's laptop (skills/desktop). The RDP route works only with an RDP client
  through `cloudflared access rdp`; opening it in a browser shows a blank page.
- Check that the connector is enabled, not just running: `systemctl --user is-enabled cloudflared-<being>` on the box.
  A connector that is not enabled leaves the link dead after a reboot.

## Rollback

`being-tunnel delete <being> --record tunnel-<being>.json`. The record's `rollback` field lists the manual order if the
tool is unavailable.
