#!/usr/bin/env python3
"""team-fence.py: PreToolUse hook for teammate-lane runs; refuses tool calls that touch the owner's private paths.
   team-fence.py --settings   print the claude --settings JSON (this hook + auto memory off) used by being-handle/being-job"""
import hashlib, json, os, re, shlex, signal, sys

KIT = os.path.dirname(os.path.realpath(__file__))
H = r"(?:~|\$\{?HOME\}?|/home/[^/\s'\"]+|/Users/[^/\s'\"]+|/root)"
ENV_FILE = r"(?<![\w.-])\.env(?![\w-])(?!\.example)"
# Extra denied path fragments, comma-separated regexes (e.g. a private notes dir): BEING_FENCE_DENY in the kit .env.
EXTRA = [p for p in os.environ.get("BEING_FENCE_DENY", "").split(",") if p.strip()]
# The owner's private files. Upstream layout: a .beings-local/ dir (BEING_PRIVATE_DIR). A Being whose memory lives in
# .beings/ (a single-store Being) keeps the owner's personal and org context in these files, so they are denied by name wherever they are.
PRIV = os.environ.get("BEING_PRIVATE_DIR", ".beings-local")
B = r"\.beings/"
# Words that mark a memory-graph note as being about the owner as a person: the owner's first name (OWNER_NAME),
# a generic list, and BEING_FENCE_PERSONAL_WORDS (extra words, comma-separated, e.g. the owner's employer).
PERSONAL = "|".join(re.escape(w.lower()) for w in [(os.environ.get("OWNER_NAME") or "").split(" ")[0]] +
                    os.environ.get("BEING_FENCE_PERSONAL_WORDS", "").split(",") if w.strip()) or "(?!)"
PERSONAL = PERSONAL + "|personal|family|health|journey|salary|appraisal"
OWNER_FILES = r"\b(?:MEMORY|USER|DECISIONS|AUTONOMY|GOALS|ORG)\.md\b"
# The owner's browser profile (owner-access web sign-in): OWNER_BROWSER_PROFILE (or BEING_OWNER_BROWSER_DIR), plus default names.
BROWSER = [re.escape(p.rstrip("/")) for p in [os.environ.get("OWNER_BROWSER_PROFILE", ""), os.environ.get("BEING_OWNER_BROWSER_DIR", "")] if p.strip()]
DENY = [
    (re.escape(PRIV.rstrip("/")), "private owner files"),
    (OWNER_FILES, "the owner's memory and decisions"),
    (B + r"(?:memory|bond|hr|audits|inbox)(?=/|[\s\"'\\]|$)", "the owner's daily logs and personal notes"),
    (r"\b(?:bond_us|personal_moments|personal_journey[\w-]*)\b", "the owner's personal notes"),
    (r"(?:" + H + r"/|\b)hive/(?:spool|tokens|minds|audit|deliver|locks)", "the hive (other minds' mail)"),
    (r"\bconversations/[\w.@-]+\.jsonl\b", "other conversations"),
    (B + r"sessions(?=/|[\s\"'\\]|$)", "session dumps"),
    (r"\bstate/jobs/?(?=[\s\"'\\*]|$)", "other conversations' jobs"),   # listing every job; one job's files: lane check below
    (r"\bjob-scopes\b", "kit state"),
    (H + r"/\.(?:config|ssh|aws|azure|kube|gnupg|docker|netrc|git-credentials|password-store|cloudflared)\b", "credentials"),
    (r"(?:\.cloudflared\b|\b(?:cloudflare|cf)[-_]?(?:tokens?|creds?|credentials|secrets?)\b)", "Cloudflare tokens"),
    (r"(?<![\w.-])[\w-]*(?:cloudflare|tunnel|secrets?|creds?|credentials|tokens?)[\w-]*\.env(?![\w-])", "credentials"),
    (H + r"/\.claude(?:/projects|\.json)", "other sessions and auto memory"),
    (H + r"/\.codex/(?:sessions|archived_sessions|session_index|auth|history)", "other sessions"),
    # Sourcing the kit .env to send is fine; reading or copying any .env is not.
    (r"\b(?:cat|head|tail|less|more|grep|rg|sed|awk|strings|base64|xxd|od|cp|mv|scp|curl|python3?|node|env)\b[^|;&\n]*" + ENV_FILE, "credentials"),
    (r"teams-kit/state/(?!jobs/|attachments/team-[0-9a-f]{10}/)", "kit state"),
    (r"\b(?:comms\.jsonl|owner-inbox|owner-watermark|token-cache[\w-]*|handler\.key|grants/|handler\.log|codex\.log|inbox\.jsonl|send-as/)", "kit state"),
    (r"\b(?:owner-read|owner-mail|draft-for-owner|approve\.mjs|scope\.mjs)\b", "owner tools"),
    (r"\bowner-(?:web|browser|access|channel[\w-]*|forward[\w-]*)\b", "owner tools"),
    (r"\b(?:shared-mailbox-drafts|shared-inbox-monitor|channel-posts|mail-forward-rules|owner-session|oa-config|go-approval)(?:\.mjs|\.sh)?\b|\bowner-access\.toml\b|outlook-cache[\w-]*", "owner tools"),
    (r"/proc/[\w$]+/environ", "process environment"),
] + [(p, "the owner's browser profile") for p in BROWSER] + [(p.strip(), "private (BEING_FENCE_DENY)") for p in EXTRA]
# memory-graph is shared work knowledge (designs of the Being's own systems included), except notes about the owner as a
# person; a note's frontmatter decides first (share: team / share: private, see shared_note()).
GRAPH, NAMED = re.compile(B + r"memory-graph/", re.I), re.compile(PERSONAL, re.I)
PATH_END = re.compile(r'["\n]|\\n|\.md(?![\w/])', re.I)
def personal_note(blob, stops=True):
    """A memory-graph path with a personal word in it. Each stretch is read once, up to the next such path: linear time.
    stops=False (a Bash command): read to the next graph path or the end, since `cd graph/; cat a.md <word>.md` reads the note."""
    at = [m.end() for m in GRAPH.finditer(blob)] + [len(blob)]
    for s, nxt in zip(at, at[1:]):
        e = min(nxt, s + 4096) if stops else nxt; m = PATH_END.search(blob, s, e) if stops else None
        if NAMED.search(blob, s, m.start() if m else e): return True
    return False

JOB = re.compile(r"jobs/([0-9]{4}-[0-9]{6}-[\w-]+?)(?:\.result\.md|\.events\.jsonl|\.exec\.log|\.log|\.json\b|/|(?=[\s\"'\\*]|$))")

def lane_of(job_id):
    state = os.environ.get("BEING_STATE_DIR") or os.path.join(KIT, "state")
    s = None
    for f in (os.path.join(state, "job-scopes", job_id + ".json"), os.path.join(state, "jobs", job_id + ".json")):   # signed store first
        try: s = json.load(open(f)).get("scope") or ""; break
        except (OSError, ValueError): continue
    if s is None: return None
    return "team:" + s[6:].split(",")[0] if s.startswith("chats:") and s[6:] else "owner"

def settings():
    hook = {"type": "command", "command": "python3 " + json.dumps(os.path.realpath(__file__)), "timeout": 30, "onFailure": "block"}
    return json.dumps({"autoMemoryEnabled": False, "hooks": {"PreToolUse": [{"matcher": "*", "hooks": [hook]}]}})

WS = os.path.realpath(os.environ.get("BEING_WORKSPACE") or os.path.dirname(os.path.dirname(KIT)))   # = being-handle WORKSPACE

_ST = [re.escape(os.path.realpath(os.environ["BEING_STATE_DIR"]).rstrip("/"))] if os.environ.get("BEING_STATE_DIR") else []
ATTACH = re.compile(r"(?:" + "|".join(_ST + [r"\bstate"]) + r")/attachments(?:/([\w-]*))?(?=/|[\s\"'\\*]|$)")


def lane_attachments():
    lane = os.environ.get("BEING_LANE", "")
    return "team-" + hashlib.sha1(lane[5:].encode()).hexdigest()[:10] if lane.startswith("team:") else None


HIVE_CMD = re.compile(r"(?:^|[;&|(`\s])(?:hive-mcp|hive-mcp-http|hive-status)(?=\s|$)")
# Message bodies are text, not file access: a heredoc fed to the sender or the board is not scanned for paths (the sender's
# own secret filter refuses credentials). Only these exact command forms; anything after the terminator is scanned.
# The script is node's first argument (an option such as --title=… would leave node reading the heredoc as code).
SEND = re.compile(r"^\s*(?:node\s+(?!-)(?:\S*/)?teams-send-dm\.mjs|(?:\S*/)?being-board\s+add)(?=\s|$)")
RISKY = set(";&|$({[`")
def heredoc_delim(cmd):
    """Delimiter of a plain heredoc on the send command's first line, else None: nothing before << may chain, expand or group."""
    try:
        lex = shlex.shlex(cmd.split("\n", 1)[0], posix=True, punctuation_chars=True); lex.whitespace_split = True; t = list(lex)
    except ValueError: return None
    for i, a in enumerate(t[1:], 1):
        if a != "<<" or i + 1 >= len(t): continue
        if any(RISKY & set(x) for x in t[:i]): return None
        d = t[i + 1][1:] if t[i + 1].startswith("-") else t[i + 1]
        return d if re.fullmatch(r"\w+", d) else None   # bash and shlex agree on a plain word only (not " EOF", $'EOF')
    return None

def strip_bodies(cmd):
    if not SEND.match(cmd): return cmd
    d, lines = heredoc_delim(cmd), cmd.split("\n")
    if not d: return cmd
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == d), len(lines))
    return "\n".join([lines[0]] + lines[end:])

NOTE = re.compile(r"\.beings/memory-graph/[^\"'\n]+?\.md", re.I)
def real(p, cwd):
    """p resolved against the run's cwd (./, //, .., symlinks); workspace paths also as their workspace-relative form."""
    r = os.path.realpath(os.path.join(cwd, os.path.expanduser(p)))
    return [r] + ([os.path.relpath(r, WS)] if r == WS or r.startswith(WS + "/") else [])

def shared_note(ev):
    """'share: team' / 'share: private' in a memory-graph note's frontmatter: True / False; None when not set or not a note."""
    i = ev.get("tool_input") or {}
    p = i.get("file_path") or i.get("path") or ""
    if ev.get("tool_name") != "Read" or not p: return None
    r = real(p, ev.get("cwd") or os.getcwd())
    if not NOTE.search(r[-1]): return None
    try:
        head = open(r[0]).read(2000)
    except OSError: return None
    m = re.match(r"---\n(.*?)\n---", head, re.S)
    v = re.search(r"^share:\s*(\w+)", m.group(1), re.M) if m else None
    return None if not v else v.group(1).lower() == "team"

def wide_search(ev):
    """A Grep/Glob over the whole workspace (or .beings/, or above it) reads the private files without naming them."""
    if ev.get("tool_name") not in ("Grep", "Glob"): return False
    cwd = ev.get("cwd") or os.getcwd()
    p = os.path.realpath(os.path.join(cwd, os.path.expanduser((ev.get("tool_input") or {}).get("path") or ".")))
    p, priv = p.lower(), os.path.join(WS, ".beings").lower()
    return p == priv or priv.startswith(p.rstrip("/") + "/")

TOKEN = re.compile(r"[^\s\"'`;|&<>(){}=,]+")
PATH_KEYS = ("file_path", "path", "notebook_path")
def words(v):
    if len(v) > 65536: raise ValueError("value too long to check")   # fail closed: padding must not hide a path past the limit
    try: w = shlex.split(v)
    except ValueError: w = TOKEN.findall(re.sub(r"[\"'\\]", "", v))   # unbalanced for shlex: also read it with the quoting taken out
    return w + TOKEN.findall(v)

# Per tool, the fields that are text, not paths: blob-checked only. Every other string, nested ones too, gets path resolution.
CONTENT_KEYS = {"Write": {"content"}, "Edit": {"old_string", "new_string"}, "MultiEdit": {"old_string", "new_string"},
                "NotebookEdit": {"new_source"}, "Bash": {"description"}}
def strings(v, key=""):
    """(innermost key, value) for every string in v, inside nested objects and lists as well."""
    if isinstance(v, str): yield key, v
    elif isinstance(v, dict):
        for k, x in v.items(): yield from strings(x, k)
    elif isinstance(v, list):
        for x in v: yield from strings(x, key)

def normalised(ti, cwd, tool=""):
    """The tool input with paths resolved, so '.beings/./memory', '.beings//memory' and '../' match like '.beings/memory'."""
    pairs, text = list(strings(ti)), CONTENT_KEYS.get(tool, set())
    out = [re.sub(r"/{2,}", "/", re.sub(r"/(?:\./)+", "/", v)) for _, v in pairs]
    ws = [ti[k] for k in PATH_KEYS if isinstance(ti.get(k), str)] + [w for k, v in pairs if k not in text for w in words(v)]
    paths = list(dict.fromkeys(w for w in ws if "/" in w or w.startswith("~")))
    if len(paths) > 500: raise ValueError("too many paths to check")   # fail closed: padding must not push a path past the cap
    for w in paths: out += real(w, cwd)
    return "\n".join(out)

def check(ev):
    """Reason string if the tool call must be refused, else None."""
    if ev.get("tool_name") in ("SendMessage",):   # other sessions only through being-steer (scope-checked, logged)
        return "session messaging"
    if str(ev.get("tool_name", "")).startswith("mcp__basic-memory"):   # the index of all of the owner's memory
        return "the owner's memory index"
    if str(ev.get("tool_name", "")).startswith("mcp__hive"): return "the hive (other minds' mail)"
    if wide_search(ev): return "search a specific project folder, not the whole workspace or .beings/"
    ti = dict(ev.get("tool_input") or {})
    if len(json.dumps(ti, ensure_ascii=False)) > 1 << 20: return "a tool input over 1 MiB (too large to check)"   # all of it, nested too
    if ev.get("tool_name") == "Bash" and isinstance(ti.get("command"), str):
        ti["command"] = strip_bodies(ti["command"])
        if HIVE_CMD.search(ti["command"]): return "the hive (other minds' mail)"
    share = shared_note(ev)
    if share is False: return "a note marked share: private"
    blob = json.dumps(ti, ensure_ascii=False).replace("\\/", "/") + "\n" + normalised(ti, ev.get("cwd") or os.getcwd(), str(ev.get("tool_name", "")))
    if ev.get("tool_name") in ("Read", "Edit", "Write", "Grep", "Glob", "NotebookEdit") and re.search(ENV_FILE, blob, re.I):
        return "credentials"
    for pat, what in DENY:
        if re.search(pat, blob, re.I): return what   # case-insensitive: case-folding filesystems
    bash = ti.get("command") if ev.get("tool_name") == "Bash" and isinstance(ti.get("command"), str) else ""
    bash = re.sub(r"/{2,}", "/", re.sub(r"/(?:\./)+", "/", bash))
    if not share and (personal_note(blob) or (bash and personal_note(bash, stops=False))): return "a note about the owner personally"   # share: team overrides this rule only
    own = lane_attachments()
    for d in ATTACH.findall(blob):   # attachments: this lane's own folder only (teams-fetch-attachment.mjs names it)
        if d != own: return "another conversation's attachments"
    for jid in JOB.findall(blob):
        if lane_of(jid) != os.environ.get("BEING_LANE", ""): return f"job {jid} belongs to another conversation"
    return None

def block(why):
    try: os.write(2, (f"team-fence: blocked ({why}). Teammate runs may not open the owner's private files, other conversations, "
                      "credentials or owner tools. Answer from this chat and the project files.\n").encode())
    finally: os._exit(2)   # exit 2 even when stderr is closed

if __name__ == "__main__":
    if sys.argv[1:] == ["--settings"]: print(settings()); sys.exit(0)
    # The deadline exits 2 itself (a raised TimeoutError is an OSError, and an except on the way would swallow it).
    signal.signal(signal.SIGALRM, lambda *_: block("the check took too long"))
    try: limit = min(20, max(1, int(os.environ.get("BEING_FENCE_DEADLINE") or 20)))   # may only shorten it
    except ValueError: limit = 20
    signal.alarm(limit)   # block before the hook's own 30 s timeout, which would not block
    try: why = check(json.load(sys.stdin))
    except Exception: why = "the fence could not check this call"   # any error blocks (exit 2), never exit 1
    if why: block(why)
