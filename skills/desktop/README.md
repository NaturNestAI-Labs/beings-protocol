# Desktop: open a Being's desktop from the owner's laptop (optional)

`<being>-desktop` on the owner's laptop opens the Being's full Ubuntu desktop in a window. It goes direct on the office
network and through the Being's Cloudflare tunnel from anywhere else, and never asks for the RDP password.
Off by default; switch on per Being with `[access].desktop = true` and the `[desktop]` section of `being.toml`.

| Part | Where | What it does |
|---|---|---|
| `being-desktop` → `~/.local/bin/<being>-desktop` | Owner's laptop | Picks LAN or tunnel, starts the tunnel forwarder if needed, opens the RDP window, cleans up when it closes |
| `~/.config/<being>-box/box.env` | Owner's laptop | Box LAN address, office subnet, tunnel hostnames, user, ports (no secrets) |
| `~/.config/<being>-box/rdp.env` (0600) | Owner's laptop | `RDP_PASS=`; read by the script and passed to the client on stdin, never on argv, never in chat |
| `Host <being>-box` / `<being>-lan` | Owner's `~/.ssh/config` | SSH through the tunnel (`cloudflared access ssh`) or on the LAN |
| `rdp-session-end.sh` → `~/.local/bin/rdp-session-end` | Being's box | `now`: end the remote session unless a viewer is still connected; `reap`: end it after `REAP_GRACE` s with no viewer |
| `rdp-session-reap.service` / `.timer` (every 2 min) | Being's box | Covers crashed viewers and a laptop that went to sleep |
| GNOME Remote Desktop (system mode; xrdp on 24.04) + firewall rule | Being's box | `scripts/harden-box.sh --desktop` (needs sudo once) |
| `<being>-desktop.<domain>` route | Cloudflare | `being-tunnel create` (skills/tunnel) |

## Install

Box (as the Being's user):

```bash
skills/desktop/kit-install.sh <being-home>
sudo scripts/harden-box.sh --config <being-home>/being.toml --desktop      # RDP server, RDP from the office subnet only
systemctl --user enable --now rdp-session-reap.timer    # GNOME system mode only; with xrdp the session is the user's own
```

Owner's laptop (needs FreeRDP 2 or 3 and `cloudflared`):

```bash
skills/desktop/being-desktop install <being> --config <being.toml>    # asks for the RDP password once (not shown)
<being>-desktop status
<being>-desktop                 # open; `<being>-desktop --tunnel` forces the tunnel; `<being>-desktop stop` ends the forwarder
```

`install` writes `box.env` and `rdp.env` only when missing, and adds the SSH block once (between `# >>> <being>-box`
markers). The SSH key of the laptop must be in the box's `authorized_keys` (SSH is key-only after hardening).

## How a session runs

1. Off the office network (`BOX_LAN_SUBNET` does not match a local address) the LAN probe is skipped at once.
   On it, a 2 s probe of the box's RDP port decides LAN or tunnel.
2. Tunnel: `cloudflared access login` (output to `/dev/null`: it prints a session token), then
   `cloudflared access rdp --hostname <being>-desktop.<domain> --url localhost:13389`. An existing forwarder is reused.
3. The RDP client gets the password on stdin (`/from-stdin`), and the box's certificate is trusted on first use.
4. On close: the forwarder stops if no other viewer uses it, then (with `END_ON_CLOSE=1`) the box runs
   `rdp-session-end now`, which skips a session that another viewer is still using. Off-LAN cleanup goes through the
   tunnel alias only.

## Lessons

- Each open is a fresh Ubuntu login: 35-60 s to the first frame, slower when the box is busy. For fast reopens set
  `END_ON_CLOSE=0` in `box.env`: the session then stays until the reaper ends it (`[desktop].reap_grace_sec`, 10 min).
- If the laptop sleeps, the window freezes and the box reaps the session. Close the window and reopen.
- Cleanup must never end a session another viewer is using: `now` checks for a connected client first; the reaper
  only acts after the grace period with nobody connected.
- The desktop route only works through an RDP client. Opening `<being>-desktop.<domain>` in a browser shows a blank page.
- Two passwords may follow: the RDP password (automatic), then the Ubuntu login on the GNOME screen (typed by you).
