#!/usr/bin/env bash
# being-update: offer a new release once, update only an offered version, report problems sanitised. Offline (file:// "GitHub").
set -euo pipefail
unset TMUX TMUX_PANE
REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
fails=0; ok() { echo "  ok  $1"; }; bad() { echo "  FAIL $1"; fails=$((fails + 1)); }
for v in $(env | grep -oE '^(BEING|OWNER)_[A-Z_]*'); do unset "$v"; done

H="$T/home"; W="$H/beings/nova"; SRV="$T/srv"; mkdir -p "$W/.beings" "$W/bin" "$SRV" "$T/bin"
cp "$REPO/templates/kit/bin/being" "$W/bin/nova"; chmod +x "$W/bin/nova"
echo 0.4.0 >"$W/.beings/.protocol-version"; echo 0.2.0 >"$W/.beings/.kit-version"
cp "$REPO/CHANGELOG.md" "$SRV/"
pv="$(sed -n 's/^PROTOCOL_VERSION="\(.*\)"/\1/p' "$REPO/install.sh")"; kv="$(sed -n 's/^KIT_VERSION="\(.*\)"/\1/p' "$REPO/install.sh")"
fake_install() {   # fake_install ok|fail: a stand-in install.sh with the real version lines
  { echo '#!/usr/bin/env bash'; echo "PROTOCOL_VERSION=\"$pv\""; echo "KIT_VERSION=\"$kv\""
    if [[ $1 == ok ]]; then echo "echo $pv > .beings/.protocol-version; echo $kv > .beings/.kit-version"
    else echo 'echo "fetch failed for admin@corp.example.org at 192.0.2.77 token=abc123secret" >&2; exit 1'; fi; } >"$SRV/install.sh"
}
printf '#!/bin/sh\ncat >>"%s/sent.html"; echo >>"%s/sent.html"\n' "$T" "$T" >"$T/bin/send"; chmod +x "$T/bin/send"
printf '#!/bin/sh\nexit 1\n' >"$T/bin/gh"; chmod +x "$T/bin/gh"   # gh not signed in
run() { HOME="$H" PATH="$T/bin:$PATH" BEING_WORKSPACE="$W" BEINGS_BASE_URL="file://$SRV" BEING_UPDATE_SEND="$T/bin/send" \
        BEING_RUNNER_ENV=/nonexistent "$REPO/skills/runner/being-update" "$@"; }
sent() { cat "$T/sent.html" 2>/dev/null || true; }

# 1. A newer release is offered once, with its fixes and features and the exact reply.
fake_install ok
run check >/dev/null
m="$(sent)"
grep -q "New Beings kit version v$pv" <<<"$m" && grep -q 'Bug fixes (' <<<"$m" && grep -q 'New features (' <<<"$m" \
  && grep -q "UPDATE v$pv" <<<"$m" && ok "owner asked once with fixes and features" || bad "offer: $m"
: >"$T/sent.html"; run check >/dev/null; [[ ! -s "$T/sent.html" ]] && ok "same version not offered twice" || bad "offered twice"

# 2. Only the offered version can be applied.
rc=0; run apply 9.9.9 >/dev/null 2>&1 || rc=$?; [[ $rc == 3 ]] && ok "unoffered version refused" || bad "unoffered version: rc $rc"

# 3. A clean update reports success and clears the offer.
: >"$T/sent.html"; rc=0; run apply "v$pv" >/dev/null 2>&1 || rc=$?
[[ $rc == 0 ]] && grep -q "Updated to v$pv" "$T/sent.html" && [[ "$(cat "$W/.beings/.protocol-version")" == "$pv" ]] \
  && ok "update applied and reported" || bad "apply ok: rc $rc $(sent)"
rc=0; run apply "$pv" >/dev/null 2>&1 || rc=$?; [[ $rc == 3 ]] && ok "offer used up after the update" || bad "re-apply: rc $rc"

# 4. A failing update: owner told the problem, report kept, nothing sensitive in it.
echo 0.4.0 >"$W/.beings/.protocol-version"; echo 0.2.0 >"$W/.beings/.kit-version"; fake_install fail
run check >/dev/null; : >"$T/sent.html"; rc=0; run apply "$pv" >/dev/null 2>&1 || rc=$?
rep="$(ls "$H"/.local/state/beings-update/nova/v"$pv"-*/report.md | tail -1)"
[[ $rc != 0 ]] && grep -q 'problem(s)' "$T/sent.html" && grep -q 'Could not open the pull request' "$T/sent.html" \
  && ok "failure reported to the owner (PR not possible without gh)" || bad "apply fail: rc $rc $(sent)"
grep -q 'install step exited 1' "$rep" && ! grep -qE 'corp\.example|192\.0\.2\.77|abc123secret' "$rep" && grep -q '<email>' "$rep" \
  && ok "report details the problem, sanitised" || bad "report: $(cat "$rep")"

# 5. skip: recorded, and that version is not offered again.
run check >/dev/null; run skip "v$pv" >/dev/null; : >"$T/sent.html"; run check >/dev/null
[[ ! -s "$T/sent.html" ]] && ok "skipped version stays quiet" || bad "skipped version offered again"

# 6. The owner's reply is routed without a model: uppercase UPDATE or skip with a v-version, owner 1:1 only.
grep -q 'u=re.match(r"^(UPDATE|skip)\\s+v' "$REPO/skills/teams-kit/being-handle" && ok "handler routes UPDATE/skip vX.Y.Z" || bad "handler route"

echo "being-update: $fails failure(s)"; (( fails == 0 ))
