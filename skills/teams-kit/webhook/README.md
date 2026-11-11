# Graph webhook: instant messages (optional)

Without it the Teams kit polls every `BEING_TICK_SEC`. With it Microsoft calls the box when a chat message arrives and
the loop reads it within about a second. **Polling stays as the fallback**: if the subscription lapses, the hook is
down or the box was off, the next sweep still finds every message.

| File | What it does |
|---|---|
| `graph-webhook.mjs` | Receiver on `127.0.0.1:$HOOK_PORT` (8790). `POST /graph/notify` and `POST /graph/lifecycle` only, everything else 404. Answers the validation handshake, drops any notification whose `clientState` is not ours (timing-safe compare), appends `{resource, id, subscriptionId}` to `queue.jsonl` (never message text), touches `kick` |
| `graph-subscribe.mjs ensure\|renew\|status\|delete` | One delegated subscription on the Being's own chat messages (`created`), 71 h lifetime, lifecycle URL set. Renewed by a 6 h timer and on every lifecycle event. Uses the Being's kit sign-in (refuses the owner's). Writes `health` = ok\|down |
| `hook-wait <tick>` | For a Being with its own poller: drop-in for `sleep`. Returns at once on a kick; stretches the tick to `HOOK_SLOW_TICK` while health is ok |
| `units/` | `graph-webhook.service`, `graph-subscribe.service` + `.timer` (6 h), `graph-subscribe-renew.service`, `graph-lifecycle.path` |

`being-teams` already wakes on the kick file and reads only the named messages (fast path); `being-deadman` alerts when
health is down. State lives in `HOOK_STATE` (default `~/.local/state/graph-webhook`, 0700).

## Install

```bash
skills/teams-kit/webhook/kit-install.sh <being-home>      # after install.sh --with teams-kit
```

Copies the files to `ops/teams-kit/webhook/`, creates `HOOK_STATE/client-state` (64 random characters, 0600), writes
`~/.config/graph-webhook/env` (0600) and the units. Nothing is enabled.

## Publish the receiver

Microsoft must reach `https://<being>-hook.<domain>/graph/...` from the internet, and it cannot pass a Cloudflare Access
login. So the route gets an Access **bypass** policy limited to **Microsoft's published change-notification address
ranges**; every other caller gets 403 at the edge, and the receiver still checks `clientState` on each notification.

1. Get the ranges: Microsoft publishes the addresses change notifications come from in the Microsoft 365 endpoints web
   service (`https://endpoints.office.com/endpoints/worldwide?clientrequestid=<uuid>`); the Graph documentation on
   webhook change notifications names which entries apply. Save one CIDR per line in a file. Re-check monthly.
2. From the admin box: `being-tunnel hook <being> --ranges <file>` (skills/tunnel). It creates the Access app with the
   bypass policy **before** the DNS record, then adds the ingress rule `<being>-hook` → `http://127.0.0.1:$HOOK_PORT`.
   `being-tunnel hook <being> --ranges <file>` again updates the ranges.
3. Set `HOOK_PUBLIC=https://<being>-hook.<domain>` in `~/.config/graph-webhook/env`.

Never bypass Access for everyone, and never expose the receiver on a port of the box itself.

## Switch on

```bash
systemctl --user daemon-reload
systemctl --user enable --now graph-webhook graph-subscribe.timer graph-lifecycle.path
systemctl --user start graph-subscribe && cat ~/.local/state/graph-webhook/health    # expect: ok ... expires ...
systemctl --user is-active graph-webhook graph-subscribe.timer graph-lifecycle.path
```

Test: send the Being a message; `tail -1 ~/.local/state/graph-webhook/queue.jsonl` shows its id within seconds.

## Rollback

```bash
node ops/teams-kit/webhook/graph-subscribe.mjs delete
systemctl --user disable --now graph-webhook graph-subscribe.timer graph-lifecycle.path
being-tunnel hook <being> --remove          # on the admin box: DNS record, ingress rule, then the Access app
```

The loop falls back to polling at once.
