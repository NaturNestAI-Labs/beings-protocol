# Recipe: Project Service as a User Unit

Some project apps a Being builds need to run continuously (an API, an MCP server, a small bridge). Run each one as a
**systemd user unit** under the Being's own user, with **its own env file**. Not as a root service, not from a shell
in tmux, and not by reading the Teams kit's `.env`.

Most apps should not be services at all: use a stack runner (`up`/`down`, never at boot). Make a service only for
something that must survive a reboot, and list it as a named exception in the Being's conventions.

## Layout

| Item | Path | Mode |
|---|---|---|
| Unit | `~/.config/systemd/user/<app>.service` | 0644 |
| Settings and secrets | `~/.config/<being>/<app>.env` (key folder of this Being only) | 0600, folder 0700 |
| State, audit, logs | `~/.local/state/<app>/` | 0700 |
| Code | the project checkout or a release directory; never the Being's home repo root | — |

## Unit

```ini
[Unit]
Description=<app> (project service)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=%h/.config/<being>/<app>.env
WorkingDirectory=%h/<path-to-app>
ExecStart=/usr/bin/env node dist/server.js
Restart=on-failure
RestartSec=5
# Hardening that works in user units
NoNewPrivileges=yes
PrivateTmp=yes
UMask=0077

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now <app>.service
loginctl enable-linger "$USER"     # once per user, so user units run without a login session
journalctl --user -u <app> -f
```

## Rules

- **One env file per app.** The unit loads it with `EnvironmentFile=`; the app never parses other files. Rotate a key by
  editing that file and restarting the unit.
- **Bind to loopback.** Expose it only through the Being's tunnel with an access policy created first.
- **Rebuild, then restart.** If the unit runs built output, a code change needs the build and `systemctl --user restart`.
- **Stop means stop.** When asked to stop a project's stacks, also `systemctl --user disable --now` its services, and
  record that it was stopped on request so it is not "repaired" later.
- **Fence it.** Add the env file path to the teammate fence's blocked paths so teammate lanes cannot read it.
- **Never print the env file**, not even masked; check presence with `test -s`.
