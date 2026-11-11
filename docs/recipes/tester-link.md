# Recipe: Temporary Tester Link (optional)

Give a tester a link to an app running on a Being's box for a few hours or days, then remove it automatically.

## Rules

1. **Access policy first.** Create the access app and policy (the tester's email, or a one-off service token) **before**
   the hostname exists, so the link is never open even for a minute. Only then add the route and DNS name.
2. **Named tunnel route, not a quick tunnel.** Anonymous quick-tunnel URLs are public to anyone who sees them, change on
   every restart and have no access check. Add a temporary hostname to the box's existing named tunnel instead.
3. **Teardown is scheduled at creation.** The same command that creates the link schedules its removal.
4. **Read before write.** Fetch the tunnel's current route list right before adding or removing a route; writing a stale
   copy silently drops other routes (for example the box's SSH or desktop route).
5. **Test account, test data.** The tester logs into the app with an account made for them, never the owner's or the
   Being's. No production data behind a tester link unless the owner says so.

## Steps

```bash
# 1. Access app + policy for tester-<app>.<domain> (tester email, session length = link lifetime)
# 2. Route tester-<app>.<domain> -> http://127.0.0.1:<port> on the box's tunnel (fresh GET, then PUT)
# 3. DNS record for the hostname
# 4. Schedule the teardown (a transient user timer survives logout with linger on):
systemd-run --user --unit "tester-link-<app>" --on-active=48h \
  <home>/bin/tester-link-down <app>
# 5. Record: hostname, access app id, policy id, expiry (ids only, no tokens) in the project notes
```

`tester-link-down` is a small script you keep next to the creation steps; it removes, in order: the DNS record, the tunnel route (fresh read first), the access app and policy,
and any service token made for it; then it marks the record as removed. Check with `systemctl --user list-timers` that
the teardown is pending, and run it by hand to end early.

## Afterwards

Confirm the hostname no longer resolves and the access app is gone. If a token for the link was ever seen in a chat or
log, rotate it rather than just deleting the message.
