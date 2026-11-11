#!/usr/bin/env bash
# publish-check: fail-closed secret gate for pushes to a PUBLIC repo (gitleaks + trufflehog + a pattern sweep).
#   publish-check.sh <git-range|rev>  |  publish-check.sh --pre-push <remote> [<url>] (git pre-push hook: refs on stdin)
# Config dir $PUBLISH_CHECK_CONFIG (default ~/.config/<being>/publish-check, else ~/.config/publish-check): deny.txt, allow.txt, secret-sources.txt (one per line).
set -euo pipefail

CFG="${PUBLISH_CHECK_CONFIG:-${BEING_CONFIG_DIR:-$HOME/.config/${BEING_NAME:-being}}/publish-check}"
[[ -n "${PUBLISH_CHECK_CONFIG:-}" || -d "$CFG" ]] || CFG="${XDG_CONFIG_HOME:-$HOME/.config}/publish-check"
GITLEAKS="${GITLEAKS:-$(command -v gitleaks || echo "$HOME/.local/bin/gitleaks")}"
TRUFFLEHOG="${TRUFFLEHOG:-$(command -v trufflehog || echo "$HOME/.local/bin/trufflehog")}"
ZERO=0000000000000000000000000000000000000000

die() { echo "publish-check: $*" >&2; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"
[[ -x "$GITLEAKS" ]] || die "gitleaks not found (fail closed)"
[[ -x "$TRUFFLEHOG" ]] || die "trufflehog not found (fail closed)"
command -v python3 >/dev/null || die "python3 not found (fail closed)"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
ranges=()
if [[ "${1:-}" == --pre-push ]]; then
  remote="${2:-origin}"
  while read -r _lref lsha _rref rsha; do
    [[ -z "${lsha:-}" || "$lsha" == "$ZERO" ]] && continue   # branch deletion: nothing to scan
    if [[ "$rsha" == "$ZERO" ]] || ! git cat-file -e "$rsha^{commit}" 2>/dev/null; then
      ranges+=("$lsha --not --remotes=$remote")
    else
      ranges+=("$rsha..$lsha")
    fi
  done
else
  [[ $# -ge 1 ]] || die "usage: publish-check.sh <git-range|rev> | --pre-push <remote> [<url>]"
  ranges+=("$*")
fi
[[ ${#ranges[@]} -gt 0 ]] || { echo "publish-check: nothing to push"; exit 0; }

fail=0
for r in "${ranges[@]}"; do
  # shellcheck disable=SC2086  # a range may be several words (rev --not --remotes=x)
  revs=$(git rev-list $r) || die "bad range: $r (fail closed)"
  n=$(printf '%s\n' "$revs" | grep -c . || true)
  [[ "$n" -gt 0 ]] || { echo "publish-check: no new commits in $r"; continue; }
  echo "publish-check: scanning $n commit(s): $r"
  # shellcheck disable=SC2086
  git log -p --no-color --format='commit %H%nAuthor: %an <%ae>%nCommitter: %cn <%ce>%n%n%B' $r >"$TMP/out.patch"

  if ! "$GITLEAKS" git --log-opts="$r" --redact -v --no-color --no-banner -l warn --exit-code 1 . >"$TMP/gl.txt" 2>&1; then
    grep -qE 'leaks found: [1-9]' "$TMP/gl.txt" || { cat "$TMP/gl.txt" >&2; die "gitleaks failed to run"; }
    echo "  FAIL gitleaks:"; grep -E '^(RuleID|File|Line|Commit):' "$TMP/gl.txt" | paste - - - - | sed 's/^/    /' || true; fail=1
  fi

  "$TRUFFLEHOG" filesystem "$TMP/out.patch" --no-update --json --results=verified,unknown,unverified \
    >"$TMP/th.jsonl" 2>"$TMP/th.err" || { cat "$TMP/th.err" >&2; die "trufflehog failed to run"; }
  if [[ -s "$TMP/th.jsonl" ]]; then
    echo "  FAIL trufflehog:"
    python3 -I -c 'import json,sys
for l in open(sys.argv[1]):
  d=json.loads(l); print("    %s verified=%s"%(d.get("DetectorName"),d.get("Verified")))' "$TMP/th.jsonl"
    fail=1
  fi

  python3 -I - "$TMP/out.patch" "$CFG" "$(git rev-parse --git-common-dir)/publish-check-allow" <<'PY' || fail=1
import re,sys,os,glob,json
patch,cfg,allowf=sys.argv[1:4]
# Generic shapes; org-specific words, names and hosts go in deny.txt (case-insensitive regexes).
GEN={
 'private-ip':r'\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b',
 'teams-chat-id':r'19:[\w-]{10,}@(?:thread\.v2|thread\.tacv2|unq\.gbl\.spaces)',
 'jwt':r'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}',
 'cloudflare-tunnel-token':r'eyJhIjoi[A-Za-z0-9+/=_-]{40,}',
 'cloudflare-api-token':r'(?i)\b(?:cf|cloudflare)[\w-]*(?:token|key)\w*["\']?\s*[:=]\s*["\']?[A-Za-z0-9_-]{40}\b',
 'github-token':r'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}',
 'msal-cache':r'"(?:secret|refresh_token|access_token)"\s*:\s*"[^"]{40,}"|"credential_type"\s*:\s*"RefreshToken"',
 'private-key':r'-----BEGIN [A-Z ]*PRIVATE KEY-----',
 'cookie':r'(?i)\b(?:set-)?cookie\s*:\s*\S+=\S{16,}',
 'env-secret':r'\b[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PASSWD)[A-Z0-9_]*\s*=\s*["\']?(?!(?i:your|<|\$|xxx|changeme|example|dummy|test|process\.|os\.environ))[A-Za-z0-9_\-/+=.]{12,}',
}
def lines(p):
    try: return [l.rstrip('\n') for l in open(p,errors='ignore') if l.strip() and not l.startswith('#')]
    except FileNotFoundError: return []
deny=lines(os.path.join(cfg,'deny.txt'))
rules=lines(allowf)+lines(os.path.join(cfg,'allow.txt'))
allow=[re.compile(a) for a in rules if not a.startswith('file:')]
allowfile=[re.compile(a[5:]) for a in rules if a.startswith('file:')]
pats={k:re.compile(v) for k,v in GEN.items()}
for i,d in enumerate(deny): pats[f'deny:{i+1}']=re.compile(d,re.I)
# Exact values of local secrets (secret-sources.txt globs); only key names and lengths are ever printed.
vals={}
def add(v,label):
    v=v.strip().strip('"\'')
    if len(v)>=10 and not re.fullmatch(r'[a-z_ .-]+|https?://\S+',v,re.I): vals.setdefault(v,label)
KEYS=re.compile(r'PASS|TOKEN|SECRET|KEY|PWD|CRED|AUTH|TENANT|CLIENT|OID|CHAT|COOKIE',re.I)
def walk(o,src):
    if isinstance(o,dict):
        for k,v in o.items():
            if isinstance(v,str) and re.search(r'secret|token|home_account_id|client_id|realm|password',k,re.I): add(v,src+':'+k)
            else: walk(v,src)
    elif isinstance(o,list):
        for v in o: walk(v,src)
for spec in lines(os.path.join(cfg,'secret-sources.txt')):
    for f in glob.glob(os.path.expanduser(spec),recursive=True):
        if not os.path.isfile(f) or os.path.getsize(f)>5_000_000: continue
        t=open(f,errors='ignore').read(); src=os.path.basename(f)
        if f.endswith('.json'):
            try: walk(json.loads(t),src); continue
            except ValueError: pass
        kv=list(re.finditer(r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(\S.*)$',t,re.M))
        for m in kv:
            if KEYS.search(m.group(1)): add(m.group(2),src+':'+m.group(1))
        if not kv and len(t.strip())<4096 and not re.search(r'\s',t.strip()): add(t,src)
hits=[];commit='?';fname='<message>'
for raw in open(patch,errors='ignore'):
    l=raw.rstrip('\n')
    if l.startswith('commit ') and len(l)==47: commit=l[7:15]; fname='<message>'; continue
    if l.startswith('+++ '): fname=l[6:] if l.startswith('+++ b/') else l[4:]; continue
    if l.startswith('diff --git'): fname='?'; continue
    if l.startswith('--- ') or l.startswith('@@'): continue
    if fname!='<message>' and not l.startswith('+'): continue
    if fname=='<message>' and re.match(r'(Author|Committer): ',l): continue
    if any(a.search(l) for a in allow) or any(a.search(fname) for a in allowfile): continue
    for k,c in pats.items():
        m=c.search(l)
        if m: hits.append((k,commit,fname,len(m.group(0))))
    for v,label in vals.items():
        if v in l: hits.append(('local-secret '+label,commit,fname,len(v)))
if hits:
    print('  FAIL sensitive-pattern sweep (values withheld):')
    for k,c,f,n in sorted(set(hits)): print(f'    {k}  commit {c}  {f}  (len {n})')
    sys.exit(1)
print(f'  ok sweep ({len(pats)} patterns, {len(vals)} local secret fingerprints)')
PY
done

if [[ "$fail" -ne 0 ]]; then
  echo "publish-check: BLOCKED - remove the data (or add a reviewed line regex, or file:<path regex>, to <git-common-dir>/publish-check-allow) and retry." >&2
  exit 1
fi
echo "publish-check: clean"
