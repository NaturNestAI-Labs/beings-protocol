#!/usr/bin/env bash
# tunnel.test.sh: being-tunnel against a fake Cloudflare API and a stub ssh running the box side in a temp HOME:
# Access before DNS, fresh read before PUT, token never printed or on argv, rollback.

# shellcheck disable=SC2015  # ok/bad reporting chains
set -euo pipefail
# Never the live Being: kit tools let BEING_* from the environment win over the fixture (job list, hooks, kit home).
while read -r v; do unset "$v"; done < <(compgen -e | grep -E '^(BEING_|OWNER_|M365_|HOOK_)' || true)
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
TMP=$(mktemp -d); trap 'kill "${SRV:-0}" 2>/dev/null || true; rm -rf "$TMP"' EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
CONNECTOR=FAKECONNECTORTOKEN

python3 "$REPO/tests/fake-cloudflare.py" "$TMP/port" "$TMP/calls" & SRV=$!
for _ in $(seq 50); do [[ -s "$TMP/port" ]] && break; sleep 0.1; done
export BEING_TUNNEL_NO_PROBE=1 CF_API_BASE="http://127.0.0.1:$(cat "$TMP/port")"

ADMIN="$TMP/admin"; BOX="$TMP/box"; mkdir -p "$ADMIN/.config/org" "$BOX" "$TMP/bin" "$TMP/boxbin" "$TMP/work"
printf 'CF_API_TOKEN=test-api-token\nCF_ACCOUNT_ID=acct1\nCF_ZONE_ID=zone1\n' >"$ADMIN/.config/org/cloudflare.env"
chmod 600 "$ADMIN/.config/org/cloudflare.env"
cat >"$TMP/work/being.toml" <<'TOML'
[being]
name = "nova"
[box]
host = "nova-box"
[tunnel]
domain = "example.com"
allow_emails = ["owner@example.com"]
org_env = "~/.config/org/cloudflare.env"
TOML
# Stub ssh: log argv, run the remote command locally as the "box" user. Stubs for the box's tools.
cat >"$TMP/bin/ssh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$TMP/ssh-argv"
[[ -e "$TMP/box-down" ]] && { echo "ssh: connect to host: Connection refused" >&2; exit 255; }
while [[ "\$1" == -o ]]; do shift 2; done
shift; HOME="$BOX" XDG_CONFIG_HOME="$BOX/.config" PATH="$TMP/boxbin:/usr/bin:/bin" bash -c "\$*"
STUB
printf '#!/bin/sh\necho active\n' >"$TMP/boxbin/systemctl"
printf '#!/bin/sh\necho Linger=yes\n' >"$TMP/boxbin/loginctl"
printf '#!/bin/sh\nexit 0\n' >"$TMP/boxbin/cloudflared"
chmod +x "$TMP/bin/"* "$TMP/boxbin/"*
run() { (cd "$TMP/work" && HOME="$ADMIN" PATH="$TMP/bin:$PATH" python3 "$REPO/skills/tunnel/being-tunnel" "$@") >"$TMP/out" 2>&1; }
state() { curl -s "$CF_API_BASE/__state"; }

# 0. a dry run writes no record (its fake ids would block the real create)
run create nova --dry-run; [[ ! -e "$TMP/work/tunnel-nova.json" ]] && ok "dry run writes no record" || bad "dry run wrote a record"

# 1. create
run create nova && ok "create succeeded" || bad "create: $(tail -5 "$TMP/out")"
calls="$TMP/calls"
first_dns=$(grep -n '^POST /zones/zone1/dns_records$' "$calls" | head -1 | cut -d: -f1)
last_app=$(grep -n '^POST /accounts/acct1/access/apps$' "$calls" | tail -1 | cut -d: -f1)
[[ -n "$first_dns" && -n "$last_app" && "$last_app" -lt "$first_dns" ]] && ok "Access apps created before any DNS record" || bad "order: app $last_app dns $first_dns"
put=$(grep -n '^PUT .*/configurations$' "$calls" | head -1 | cut -d: -f1)
[[ "$(sed -n "$((put - 1))p" "$calls")" == GET*/configurations ]] && ok "config read right before PUT" || bad "no fresh GET before PUT"
state | python3 -c 'import json,sys; s=json.load(sys.stdin)["result"]; ing=list(s["config"].values())[0]["ingress"]
assert [r.get("hostname") for r in ing]==["nova-ssh.example.com","nova-desktop.example.com",None], ing
assert ing[-1]["service"]=="http_status:404" and ing[0]["service"]=="ssh://localhost:22" and ing[1]["service"].startswith("rdp://")' \
  && ok "ingress: ssh + rdp routes, catch-all 404" || bad "ingress wrong"
tf="$BOX/.config/cloudflared-nova/token"
[[ "$(cat "$tf" 2>/dev/null)" == *"$CONNECTOR"* && "$(stat -c %a "$tf")" == 600 && "$(stat -c %a "$(dirname "$tf")")" == 700 ]] \
  && ok "connector token on the box, 0600 in a 0700 dir" || bad "token file on box"
grep -q -- "--token-file %h/.config/cloudflared-nova/token" "$BOX/.config/systemd/user/cloudflared-nova.service" && ok "unit uses --token-file" || bad "unit"
! grep -rq "$CONNECTOR" "$TMP/out" "$TMP/ssh-argv" "$TMP/work" "$ADMIN" && ok "token never printed, on ssh argv or saved on the admin box" || bad "token leaked"
python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); assert d["status"]=="active" and d["tunnel"]["id"] and len(d["apps"])==2 and len(d["dns"])==2 and d["rollback"]' \
  "$TMP/work/tunnel-nova.json" && ok "record has ids + rollback" || bad "record"

# 2. A second create refuses; a pre-existing hostname is never touched.
run create nova && bad "second create accepted" || ok "second create refused (record exists)"

# 3. hook route: bypass only for the listed ranges, Access before DNS; 0.0.0.0/0 refused.
printf '192.0.2.0/24\n# comment\n198.51.100.0/24\n' >"$TMP/work/ranges"
: >"$calls"; run hook nova --ranges ranges && ok "hook created" || bad "hook: $(tail -3 "$TMP/out")"
a=$(grep -n 'POST .*/access/apps$' "$calls" | cut -d: -f1); d=$(grep -n 'POST .*/dns_records$' "$calls" | cut -d: -f1)
[[ -n "$a" && -n "$d" && "$a" -lt "$d" ]] && ok "hook Access app before DNS" || bad "hook order"
printf '0.0.0.0/0\n' >"$TMP/work/open"; run hook nova --ranges open && bad "0.0.0.0/0 accepted" || ok "0.0.0.0/0 refused"

# 4. rotate pushes a new token without printing it.
run rotate nova && ! grep -q "$CONNECTOR" "$TMP/out" && ok "rotate" || bad "rotate: $(tail -3 "$TMP/out")"

# 5. delete removes everything; DNS before tunnel, Access apps last; connector stopped and token removed.
: >"$calls"; run delete nova --yes && ok "delete" || bad "delete: $(tail -5 "$TMP/out")"
d1=$(grep -n 'DELETE .*/dns_records/' "$calls" | tail -1 | cut -d: -f1); t1=$(grep -n 'DELETE .*/cfd_tunnel/[^/]*$' "$calls" | cut -d: -f1)
a1=$(grep -n 'DELETE .*/access/apps/' "$calls" | head -1 | cut -d: -f1)
[[ "$d1" -lt "$t1" && "$t1" -lt "$a1" ]] && ok "delete order: DNS, tunnel, Access" || bad "delete order $d1 $t1 $a1"
[[ ! -e "$tf" ]] && ok "box token removed" || bad "box token left"
state | python3 -c 'import json,sys; s=json.load(sys.stdin)["result"]; assert not s["tunnels"] and not s["apps"] and not s["dns"], s' \
  && ok "account clean" || bad "leftovers"

# 6. An unreachable box stops create before anything is made in the account.
touch "$TMP/box-down"; rm -f "$TMP/work/tunnel-nova.json"; : >"$calls"
run create nova && bad "create with the box unreachable" || { ! grep -q '^POST' "$calls" && ok "preflight failure creates nothing" || bad "created before preflight"; }

# 7. A failure after the API objects exist (token write on the box fails) rolls everything back.
rm -f "$TMP/box-down"
chmod 000 "$BOX/.config"; : >"$calls"
run create nova && bad "create with unwritable box dir" || { state | python3 -c 'import json,sys; s=json.load(sys.stdin)["result"]; assert not s["tunnels"] and not s["apps"] and not s["dns"], s' \
  && ok "mid-way failure rolled back" || bad "rollback left objects: $(tail -4 "$TMP/out")"; }
chmod 755 "$BOX/.config"

# 8. An API env readable by others is refused.
chmod 644 "$ADMIN/.config/org/cloudflare.env"; run status nova && bad "world-readable API env accepted" || ok "world-readable API env refused"

(( fails == 0 )) && echo "tunnel: all checks passed" || { echo "tunnel: $fails failed"; exit 1; }
