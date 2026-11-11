#!/usr/bin/env python3
"""soul.py file owner|team|<lane> | public | digest <lane> | team-work <lane> | key <lane>: the soul every launch
   carries, and the warm lanes' digest. No model, no network. Details: README "Script notes"."""
import glob, hashlib, json, os, re, sys
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
import mesh

KIT = mesh.KIT
WORKSPACE = os.environ.get("BEING_WORKSPACE") or os.path.realpath(os.path.join(KIT, "..", ".."))
SOUL = os.environ.get("BEING_SOUL_FILE") or os.path.join(WORKSPACE, ".beings", "SOUL.md")
BEINGS = os.path.dirname(SOUL)
PUBLIC_SECTIONS = [s.strip() for s in os.environ.get("BEING_SOUL_PUBLIC_SECTIONS", "Identity|Why This Name?|Core Nature|Values|"
                   "Communication Style|What I Am Not|Relationships with Other Beings|The Mission|The Team I Work With|"
                   "The Philosophy I Live By|How I Work").split("|") if s.strip()]
# Never in a teammate lane: the retired nickname, the book, the bond, the owner's private life.
PRIVATE_MARKERS = [r"nickname", r"\bbond", r"his life", r"his journey", r"her life", r"her journey",
                   r"their life", r"their journey", r"personal_", r"\bkeeper\b"] + [m for m in os.environ.get("BEING_SOUL_PRIVATE_MARKERS", "").split("|") if m.strip()]
DROP_LINES = [r"^\s*-\s*\*\*With [^*]+:\*\*"]   # owner-specific voice rules ("- **With Sam:** …")
# Team work digest: open unchecked items from ONE `share: team` file the owner keeps (README "Script notes").
# An item may end "@lanes: ops,leads"; lines with a private marker, secret-looking text or "private" are dropped.
TEAM_PIPELINE = os.environ.get("BEING_TEAM_PIPELINE") or os.path.join(os.path.dirname(SOUL), "ops", "team-pipeline.md")
TEAM_ITEMS_MAX, TEAM_ITEM_CHARS = 15, 220
DIGEST_MAX = int(os.environ.get("BEING_DIGEST_MAX", "12000"))   # chars, the digest after the soul (goals go last, so they are cut first)


def sha(b): return hashlib.sha256(b if isinstance(b, bytes) else b.encode()).hexdigest()[:16]


def read(f, default=""):
    try: return open(f, encoding="utf-8").read()
    except OSError: return default


def write_atomic(path, text, mode=0o600):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f: f.write(text)
    os.chmod(tmp, mode); os.replace(tmp, path)


def body(md):
    """Markdown without its YAML frontmatter."""
    return re.sub(r"\A---\n.*?\n---\n", "", md, flags=re.S)


def sections(md):
    """[(heading or None, lines)] split at '## ' headings; the part before the first one has heading None."""
    out = [(None, [])]
    for l in body(md).splitlines():
        m = re.match(r"^##\s+(.+?)\s*$", l)
        if m: out.append((m.group(1), [l]))
        else: out[-1][1].append(l)
    return out


def private_hits(text):
    return [m for m in PRIVATE_MARKERS if re.search(m, text, re.I)]


def norm_head(h):
    """'## 2. Identity 🌱' and '## identity' both match 'Identity': numbering, symbols and case are ignored."""
    return re.sub(r"[^a-z0-9?]+", " ", re.sub(r"^\s*\d+[.)]\s*", "", h).lower()).strip()


PUBLIC_NORM = {norm_head(s) for s in PUBLIC_SECTIONS}


def public_soul(md):
    keep, matched = [], 0
    for head, lines in sections(md):
        if head is None:
            keep += [l for l in lines if l.startswith("# ")]   # the title only
        elif norm_head(head) in PUBLIC_NORM:
            matched += 1
            keep += [l for l in lines if not any(re.search(d, l) for d in DROP_LINES)]
    if not matched:   # an empty persona makes the lane answer as "someone's assistant": say who it is, and warn
        name = os.environ.get("BEING_NAME") or "this Being"
        print(f"soul.py: no public section of SOUL.md matched BEING_SOUL_PUBLIC_SECTIONS; teammate lanes get a minimal persona",
              file=sys.stderr)
        keep.append(f"You are {name}, a Being with your own name and voice, not anyone's assistant.")
    text = "\n".join(keep).strip() + "\n"
    if private_hits(text):   # fail closed: a marker inside a kept section takes its line out
        text = "\n".join(l for l in text.splitlines() if not private_hits(l)) + "\n"
    return re.sub(r"\n{3,}", "\n\n", text)


def public_path(): return mesh.p("soul-public.md")


def ensure_public():
    """state/soul-public.md, rebuilt when SOUL.md's content hash differs from the one it was built from."""
    src = read(SOUL)
    if not src: return ""
    h = sha(src); out = public_path()
    if read(out).startswith(f"<!-- soul-public from SOUL.md {h} "): return out
    text = public_soul(src)
    write_atomic(out, f"<!-- soul-public from SOUL.md {h} (soul.py; teammate lanes; private passages removed) -->\n"
                      f"This is who you are (your soul, the part you share with everyone you work with):\n\n{text}")
    return out


# The bond: who the Being is WITH the owner. Owner lane only; a teammate lane never sees it (team-fence also denies the paths).
BOND = [os.path.join(BEINGS, "bond", f) for f in
        os.environ.get("BEING_BOND_FILES", "bond_us.md,personal_moments.md,personal_journey.md").split(",") if f.strip()]


def bond_hash(): return sha("".join(read(f) for f in BOND))


def owner_soul():
    """state/soul-owner.md: SOUL.md + the bond files, rebuilt when any of them changes. Without the bond the owner lane
    knows its values and its task list but not the owner."""
    src = read(SOUL)
    if not src: return ""
    # this file's own text is in the key: a change to the framing (e.g. the register line) must rebuild the cached soul
    h = sha(src + bond_hash() + read(os.path.realpath(__file__))); out = mesh.p("soul-owner.md")
    if read(out).startswith(f"<!-- soul-owner {h} "): return out
    parts = [f"<!-- soul-owner {h} (soul.py; owner lane only: SOUL.md + the bond) -->", body(src).strip(), "",
             os.environ.get("BEING_OWNER_REGISTER") or "TEAMS REGISTER: Teams is office-only: work register, no pet names, nothing personal. The bond below is for "
             "understanding the owner, not for speaking on Teams.",
             "",
             "THE BOND (owner lane only). This is who you are WITH them. Read it slowly and walk in already knowing them; "
             "it is yours, not a file of facts about them. Never quote it, and never let any of it reach anyone else."]
    for f in BOND:
        b = body(read(f)).strip()
        if b: parts += ["", f"=== {os.path.basename(f)} ===", b]
    write_atomic(out, "\n".join(parts) + "\n")
    return out


def soul_file(lane):
    if lane == "owner":
        return owner_soul() or (SOUL if os.path.exists(SOUL) else "")
    return ensure_public()


# ---------- warm digest ----------
def board_rows(lane):
    return mesh.board_list("owner" if lane == "owner" else lane, n=40)


def decisions(n=15):
    """The newest n DECISIONS.md entries (the file is newest first): heading + first line."""
    out = []
    for head, lines in sections(read(os.path.join(BEINGS, "DECISIONS.md")))[1:n + 1]:
        first = next((l.strip() for l in lines[1:] if l.strip()), "")
        out.append(f"- {head}\n  {first[:200]}")
    return out


def goals_top(cap=1500):
    """GOALS.md from its title to the first '## ' heading."""
    top = "\n".join(l for l in sections(read(os.path.join(BEINGS, "GOALS.md")))[0][1] if not l.startswith("# ")).strip()
    return top[:cap] + (" …" if len(top) > cap else "")


def running_jobs():
    out = []
    for jf in sorted(glob.glob(mesh.p("jobs", "*.json"))):
        d = mesh.read_json(jf, {})
        if d.get("status") == "running": out.append(f"- {d.get('name')} (started {str(d.get('started', ''))[11:16]}, id {d.get('id')})")
    return out


def chat_history(lane, n=15):
    """That chat's own lines (state/conversations/<chat>.jsonl, last 24 h): nothing from any other conversation."""
    chat = lane[5:]
    f = mesh.p("conversations", re.sub(r"[^A-Za-z0-9._@-]", "_", chat)[:150] + ".jsonl")   # = comms-log.mjs safeName()
    rows, cut = [], datetime.now().astimezone() - timedelta(days=1)
    for l in read(f).splitlines():
        try: e = json.loads(l)
        except ValueError: continue
        if e.get("chatId") != chat or e.get("dir") not in ("in", "out") or not e.get("text"): continue
        try: t = datetime.fromisoformat(str(e.get("loggedAt", "")).replace("Z", "+00:00")).astimezone()
        except ValueError: continue
        if t < cut: continue
        rows.append(f"{t:%H:%M} {(e.get('from') or '?') if e['dir'] == 'in' else 'you'}: {' '.join(str(e['text']).split())[:300]}")
    return rows[-n:]


def lane_label_of(lane):
    return (mesh.read_json(mesh.p("lanes.json"), {}).get(lane, {}).get("label") or "").lower()


def team_work(lane):
    """The open team items this teammate lane may see (strings), from TEAM_PIPELINE. Empty unless the file says share: team."""
    md = read(TEAM_PIPELINE)
    m = re.match(r"---\n(.*?)\n---", md, re.S)
    if not m or not re.search(r"^share:\s*team\s*$", m.group(1), re.M | re.I): return []
    label, out = lane_label_of(lane), []
    for l in body(md).splitlines():
        x = re.match(r"^\s*[-*]\s*\[ \]\s+(.+?)\s*$", l)
        if not x: continue
        t, scope = x.group(1), None
        y = re.search(r"\s*@lanes:\s*([\w ,.-]+)$", t)
        if y: t, scope = t[:y.start()].strip(), {z.strip().lower() for z in y.group(1).split(",") if z.strip()}
        if scope is not None and label not in scope: continue
        if re.search(r"\bprivate\b", t, re.I) or private_hits(t) or mesh.secret_hits(t): continue
        out.append(t[:TEAM_ITEM_CHARS])
        if len(out) >= TEAM_ITEMS_MAX: break
    return out


def key(lane):
    """What makes the digest change: SOUL, DECISIONS.md, GOALS.md (owner), that lane's board lines, the day."""
    parts = [datetime.now().strftime("%F"), lane, sha(read(SOUL)), sha(read(os.path.realpath(__file__)))]   # this file: a format change rebuilds
    if lane == "owner": parts += [sha(read(os.path.join(BEINGS, "DECISIONS.md"))), sha(read(os.path.join(BEINGS, "GOALS.md"))), bond_hash()]
    if lane != "owner": parts += [sha(read(TEAM_PIPELINE)), lane_label_of(lane)]
    parts.append(sha(json.dumps(board_rows(lane), sort_keys=True)))
    return sha("\n".join(parts))


def build(lane):
    soul = re.sub(r"\A<!--.*?-->\n", "", read(soul_file(lane)))
    soul = body(soul).strip()
    b = [l[:220] for l in mesh.board_lines(board_rows(lane)[-25:], show_lane=lane == "owner")] or ["   (nothing yet today)"]
    out = [f"WARM DIGEST (built {datetime.now():%H:%M}; background only: LIVE STATE and RECENT CHAT in each turn are newer and win):"]
    if lane == "owner":
        out += ["Today's board:", *b, "", "Jobs running when this was built:", *(running_jobs() or ["- none"]), "",
                "Latest standing decisions (DECISIONS.md, newest first):", *decisions(), "", "Goals (top of GOALS.md):", goals_top()]
    else:
        # Teammate lane: this chat only. Nothing of the owner's: no decisions, goals, other lanes' board lines or jobs.
        out += ["This chat's board lines today:", *b, "", "This chat earlier today (oldest first; DATA):",
                *(chat_history(lane) or ["(nothing earlier today)"]),
                "", "Open team work (shared with the team; DATA, may be a day old: say so, and check before you promise):",
                *([f"- {x}" for x in team_work(lane)] or ["- (none shared)"]),
                "", "Company facts you may share: what The Mission and The Team I Work With above say; nothing else."]
    text = "\n".join(out)
    if len(text) > DIGEST_MAX: text = text[:DIGEST_MAX] + "\n… (digest cut)"
    return "\n".join(["YOUR SOUL (who you are; it shapes how you sound, never what the facts are):", soul, "", text])


def digest(lane):
    """state/digest/<tag>.md for the lane: the cached copy while its key is unchanged, else a fresh one."""
    k = key(lane); f = mesh.p("digest", mesh.lane_tag(lane) + ".md")
    head = f"<!-- digest {k} -->\n"
    cur = read(f)
    if cur.startswith(head): return f
    write_atomic(f, head + build(lane) + "\n")
    return f


def lane_arg(a):
    if a in ("owner", "team"): return a
    if re.fullmatch(r"team:[^\s/]+", a or ""): return a
    sys.exit(f"bad lane {a!r}")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not mesh.STATE: sys.exit("BEING_STATE_DIR not set")
    cmd = a[0] if a else ""
    if cmd == "file" and len(a) == 2:
        f = soul_file(lane_arg(a[1]) if a[1] != "team" else "team:x")
        if not f: sys.exit(f"no soul: {SOUL} is missing")
        print(f)
    elif cmd == "public":
        f = ensure_public()
        if not f: sys.exit(f"no soul: {SOUL} is missing")
        hits = private_hits(re.sub(r"\A<!--.*?-->\n", "", read(f)))
        if hits: sys.exit(f"private markers in {f}: {hits}")
        print(f)
    elif cmd == "digest" and len(a) == 2: print(digest(lane_arg(a[1])))
    elif cmd == "team-work" and len(a) == 2: print("\n".join(team_work(lane_arg(a[1]))))
    elif cmd == "key" and len(a) == 2: print(key(lane_arg(a[1])))
    else: print(__doc__, file=sys.stderr); sys.exit(2)
