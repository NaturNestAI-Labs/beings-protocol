#!/usr/bin/env python3
"""triage-jobs.py [--chat <chatId>] [--jobs DIR] [--hours H] [--max N]: compact job list for the triage snapshot.
   Running jobs (newest first), then jobs finished in the last H hours with their first result line.
   --chat: a teammate chat sees only the jobs its own lane started (lane from the signed job scope)."""
import glob, json, os, sys, time
from datetime import datetime

KIT = os.path.dirname(os.path.realpath(__file__))
# Run standalone too: fill missing settings from the kit's .env.
if os.path.exists(os.path.join(KIT, ".env")):
    for l in open(os.path.join(KIT, ".env")):
        k, _, v = l.split("#", 1)[0].strip().partition("=")
        if k and v.strip(): os.environ.setdefault(k, v.strip().strip("'\""))
arg = lambda k, d: sys.argv[sys.argv.index(k) + 1] if k in sys.argv and sys.argv.index(k) + 1 < len(sys.argv) else d
STATE = os.environ.get("BEING_STATE_DIR", "")
JOBS = arg("--jobs", os.path.join(STATE, "jobs") if STATE else "")
if not JOBS: sys.exit("BEING_STATE_DIR not set")
SCOPES = os.path.join(os.path.dirname(JOBS), "job-scopes")
CHAT = arg("--chat", "")
HOURS = float(arg("--hours", "12"))
MAX = int(arg("--max", "1800"))
now = time.time()


def lane(d):
    try: s = json.load(open(os.path.join(SCOPES, d["id"] + ".json"))).get("scope") or ""   # signed store first
    except (OSError, ValueError, KeyError): s = d.get("scope") or ""
    return "team:" + s[6:].split(",")[0] if s.startswith("chats:") and s[6:] else "owner"


def first_line(path):
    try:
        for l in open(path, errors="replace"):
            t = " ".join(l.strip().lstrip("#").split())
            if t: return t[:110]
    except OSError: pass
    return ""


def hm(iso):
    try: return datetime.fromisoformat(iso).astimezone().strftime("%H:%M")
    except (TypeError, ValueError): return "?"


running, done = [], []
for f in glob.glob(os.path.join(JOBS, "*.json")):
    try: d = json.load(open(f))
    except (OSError, ValueError): continue
    if not isinstance(d, dict) or "id" not in d: continue
    if CHAT and lane(d) != "team:" + CHAT: continue
    if d.get("status") == "running":
        running.append((d.get("started", ""), f"- {d.get('name')} [{d.get('kind')}] (started {hm(d.get('started'))})"))
        continue
    try: fin = datetime.fromisoformat(d.get("finished", "")).timestamp()
    except (TypeError, ValueError): continue
    if now - fin > HOURS * 3600: continue
    res = first_line(f[:-5] + ".result.md")
    done.append((fin, f"- {d.get('name')} ({d.get('status')}, exit {d.get('exit')}, {hm(d.get('finished'))})" + (f": {res}" if res else "")))

out = [f"RUNNING JOBS: {len(running) or 'none'}"] + [l for _, l in sorted(running, reverse=True)]
out += [f"FINISHED JOBS (last {HOURS:g} h, newest first): {len(done) or 'none'}"] + [l for _, l in sorted(done, reverse=True)]
text = "\n".join(out)
if len(text) > MAX: text = text[:MAX].rsplit("\n", 1)[0] + "\n- … (older entries cut)"
print(text)
