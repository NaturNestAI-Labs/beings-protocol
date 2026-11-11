#!/usr/bin/env python3
"""Read-only live view of a Being's jobs and Claude/Codex sessions."""
import argparse
import curses
import datetime as dt
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid
from collections import deque

# Installed as <home>/ops/monitor/monitor.py; BEING_WORKSPACE / BEING_STATE_DIR / BEING_NAME override.
ROOT = Path(os.environ.get('BEING_WORKSPACE') or Path(__file__).resolve().parents[2])
WORKERS = ('codex', 'claude', 'being-job', 'being-handle')
# Prompt headers the Teams kit puts on daily-session turns.
TEAMS_MARKERS = ('[Teams triage', '[Teams voice', ' Teams work · daily session', ' job result · daily session')


def redact(value):
    text = str(value)
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
    text = re.sub(r'[\x00-\x08\x0b-\x1f\x7f]', '', text)
    text = re.sub(r'(?i)\bBearer\s+[^\s"\'<>]+', 'Bearer [REDACTED]', text)
    text = re.sub(r'\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+|xox[baprs]-[\w-]+)', '[REDACTED]', text)
    text = re.sub(r'(?i)(["\']?(?:[\w-]{0,64}(?:token|password|secret|api[_-]?key)|chat_?id|notify|scope)["\']?\s*[:=]\s*)("[^"\n]*"|\'[^\'\n]*\'|[^\s,;}]+)', r'\1[REDACTED]', text)
    text = re.sub(r'\b(?:19|48|8):(?=[^\s"\'<>]*[A-Za-z@])[^\s"\'<>]+', '[chat]', text)
    text = re.sub(r'\beyJ[\w-]+\.[\w-]+\.[\w-]+', '[REDACTED]', text)
    return text


def sanitized(value):
    if isinstance(value, dict):
        return {k: sanitized(v) for k, v in value.items()}
    if isinstance(value, list):
        return [sanitized(v) for v in value]
    return redact(value) if isinstance(value, str) else value


def stamp(value):
    try:
        return dt.datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp()
    except (ValueError, TypeError):
        return 0


def date(value):
    return dt.datetime.fromtimestamp(value).astimezone().strftime('%Y-%m-%d %H:%M:%S %Z') if value else 'unknown'


def day(value):
    return dt.datetime.fromtimestamp(value).astimezone().strftime('%Y-%m-%d')


def age(seconds):
    seconds = max(0, int(seconds))
    return f'{seconds // 3600}h{seconds % 3600 // 60:02}m' if seconds >= 3600 else f'{seconds // 60}m{seconds % 60:02}s'


def compact(value, limit=240):
    if not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False)
    return ' '.join(redact(value[:max(4096, limit)]).split())[:limit]


def read(path):
    try:
        return path.read_text(errors='replace')
    except OSError:
        return ''


def obj(path):
    try:
        return json.loads(read(path))
    except ValueError:
        return {}


class Transcript:
    def __init__(self, path):
        self.path = path
        self.offset = 0
        self.identity = None
        self.sid = path.stem
        self.started = self.last = 0
        self.model = self.title = self.prompt = self.final = self.now = ''
        self.open = {}
        self.done = deque(maxlen=2000)
        self.events = deque(maxlen=500)
        self.todos = []
        self.teams = False
        self.artifacts = set()
        self.ended = 0
        self.error = ''
        self.sampled = False
        self.full = False

    def emit(self, ts, label, text):
        self.events.append(f'{date(ts)} | {label}: {compact(text, 1000)}')

    def call(self, key, name, args, ts):
        self.open[key] = (name, args, ts)
        self.now = f'{name} {compact(args)}'
        self.emit(ts, 'tool started', self.now)
        raw = args if isinstance(args, str) else json.dumps(args)
        self.artifacts.update(redact(x) for x in re.findall(r'\*\*\* (?:Add|Update|Delete) File: ([^\n]+)', raw))
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                pass
        if isinstance(args, dict):
            if name.lower().endswith(('todowrite', 'update_plan')):
                self.todos = args.get('todos', args.get('plan', []))
            for field in ('file_path', 'path', 'target_file'):
                if isinstance(args.get(field), str):
                    self.artifacts.add(redact(args[field]))

    def finish(self, key, output, ts, failed=False):
        call = self.open.pop(key, None)
        if call:
            name, args, _ = call
            self.done.append(f'{date(ts)} | {name} {compact(args)} → {"failed" if failed else "completed (tool returned; success unverified)"}')
        self.emit(ts, 'tool result', output)

    def consume(self, d):
        ts = stamp(d.get('timestamp'))
        if ts:
            self.started = self.started or ts
            self.last = max(self.last, ts)
        typ = d.get('type')
        p = d.get('payload', {})
        if typ == 'session_meta':
            self.sid = p.get('id', self.sid)
        if typ == 'thread.started':
            self.sid = d.get('thread_id', self.sid)
        if typ == 'turn_context':
            self.model = p.get('model', self.model)
        if typ == 'custom-title':
            self.title = d.get('customTitle', '')
        if typ == 'event_msg':
            if p.get('type') == 'task_complete':
                self.ended = ts
                self.final = p.get('last_agent_message', self.final) or self.final
            elif p.get('type') == 'task_started':
                self.ended = 0
            return
        if typ in ('item.started', 'item.completed', 'item.updated'):
            item = d.get('item', {})
            kind = item.get('type')
            key = item.get('id')
            if kind == 'todo_list':
                self.todos = [{'content': x.get('text', ''), 'status': 'completed' if x.get('completed') else 'pending'} for x in item.get('items', [])]
            elif kind == 'agent_message':
                self.now = self.final = item.get('text', '')
                self.emit(ts, 'assistant', self.now)
            else:
                args = item.get('command', item.get('changes', item))
                if key not in self.open:
                    self.call(key, kind or 'tool', args, ts)
                if typ == 'item.completed':
                    self.finish(key, item.get('aggregated_output', item), ts, item.get('exit_code', 0) not in (None, 0))
            return
        if typ == 'response_item':
            pt = p.get('type')
            if pt in ('function_call', 'custom_tool_call'):
                self.call(p.get('call_id'), p.get('name', 'tool'), p.get('arguments', p.get('input', '')), ts)
            elif pt in ('function_call_output', 'custom_tool_call_output'):
                self.finish(p.get('call_id'), p.get('output', ''), ts)
            elif pt == 'message':
                self.message(p, ts)
        elif typ in ('assistant', 'user'):
            msg = d.get('message', {})
            if isinstance(msg, dict):
                self.model = msg.get('model', self.model)
                self.message(msg, ts)

    def message(self, msg, ts):
        role = msg.get('role')
        blocks = msg.get('content', [])
        if isinstance(blocks, str):
            blocks = [{'type': 'text', 'text': blocks}]
        for b in blocks:
            if not isinstance(b, dict):
                continue
            typ = b.get('type')
            if typ == 'tool_use':
                self.call(b.get('id'), b.get('name', 'tool'), b.get('input', {}), ts)
            elif typ == 'tool_result':
                self.finish(b.get('tool_use_id'), b.get('content', ''), ts, b.get('is_error', False))
            elif typ in ('text', 'input_text', 'output_text'):
                text = b.get('text', '')
                if role == 'user':
                    if any(marker in text for marker in TEAMS_MARKERS):
                        self.teams = True
                    if not self.prompt:
                        self.prompt = text
                if role == 'assistant':
                    self.now = text
                    self.final = text
                    self.emit(ts, 'assistant', text)
                    self.artifacts.update(redact(x.rstrip('.,:;)`')) for x in re.findall(r'(?:/|\b(?:ops|projects|memory-graph)/)[\w./-]+', text))

    def update(self):
        try:
            stat = self.path.stat()
            identity = (stat.st_dev, stat.st_ino)
            if self.identity != identity or stat.st_size < self.offset:
                full = self.full
                self.__init__(self.path)
                self.full = full
                self.identity = identity
            with self.path.open('rb') as stream:
                stream.seek(self.offset)
                if not self.offset and stat.st_size > 262144 and not self.full:
                    for _ in range(8):
                        line = stream.readline()
                        try:
                            d = json.loads(line)
                            if isinstance(d, dict):
                                self.consume(d)
                        except ValueError:
                            pass
                    stream.seek(max(stream.tell(), stat.st_size - 131072))
                    stream.readline()
                    self.offset = stream.tell()
                    self.sampled = True
                for line in stream:
                    if not line.endswith(b'\n'):
                        break
                    self.offset += len(line)
                    try:
                        d = json.loads(line)
                    except ValueError:
                        if self.path.suffix == '.log':
                            self.emit(0, 'log (timestamp unavailable)', line.decode(errors='replace'))
                        continue
                    if isinstance(d, dict):
                        self.consume(d)
            self.last = self.last if self.started else stat.st_mtime
            self.error = ''
        except OSError as exc:
            self.error = f'{type(exc).__name__}: transcript unavailable'


def processes():
    found = []
    for path in Path('/proc').glob('[0-9]*'):
        try:
            args = (path / 'cmdline').read_bytes().decode(errors='replace').split('\0')
            if not any(Path(a).name in WORKERS for a in args[:3]):
                continue
            if (path / 'stat').read_text().split(') ', 1)[1].startswith('Z'):
                continue
            files = set()
            for fd in (path / 'fd').iterdir():
                try:
                    files.add(str(fd.resolve()))
                except OSError:
                    pass
            env = (path / 'environ').read_bytes().split(b'\0')
            homes = [x.split(b'=', 1)[1].decode() for x in env if x.startswith(b'CODEX_HOME=')]
            found.append((int(path.name), args, files, homes))
        except (OSError, IndexError):
            continue
    return found


class Monitor:
    def __init__(self, root=None, home=None, state=None, name=None):
        self.root = Path(root or ROOT)
        self.home = Path(home or Path.home())
        self.state = Path(state or os.environ.get('BEING_STATE_DIR') or self.root / 'ops/teams-kit/state')
        self.name = name or os.environ.get('BEING_NAME') or self.root.name
        self.cache = {}
        self.rows = []

    def transcript(self, path):
        path = Path(path)
        if path not in self.cache:
            self.cache[path] = Transcript(path)
        self.cache[path].update()
        return self.cache[path]

    def scan(self):
        procs = processes()
        homes = {self.home / '.codex', Path(os.environ.get('CODEX_HOME', self.home / '.codex'))}
        homes.update(Path(h) for _, _, _, hs in procs for h in hs)
        paths = set((self.home / '.claude/projects').glob('*/*.jsonl'))
        for home in homes:
            paths.update((home / 'sessions').glob('**/*.jsonl'))
        self.registrations = {}
        for path in (self.home / '.claude/sessions').glob('*.json'):
            registration = obj(path)
            if registration.get('sessionId'):
                self.registrations[registration['sessionId']] = registration
        titles = {}
        for home in homes:
            for line in read(home / 'session_index.jsonl').splitlines():
                try:
                    entry = json.loads(line)
                    titles[entry['id']] = entry.get('thread_name', '')
                except (ValueError, KeyError, TypeError):
                    continue
        sessions = {}
        for path in paths:
            tr = self.transcript(path)
            sessions[tr.sid] = tr
            if tr.sid in titles:
                tr.title = titles[tr.sid]
        daily = {read(p).strip(): p.stem for p in (self.state / 'fast-daily').glob('*.id')}
        for tr in sessions.values():
            if tr.started:
                when = day(tr.started)
                if tr.teams or tr.sid == str(uuid.uuid5(uuid.NAMESPACE_URL, f'being-daily/{self.name}/{when}')):
                    daily[tr.sid] = when
        for p in self.state.glob('work-session.*'):
            fields = read(p).split()
            if fields:
                daily.setdefault(fields[0], 'daily')
        rows = []
        linked = set()
        for path in (self.state / 'jobs').glob('*.json'):
            state = obj(path)
            if not state.get('id'):
                continue
            sid = state.get('session_id')
            ev = path.with_suffix('.events.jsonl')
            event = self.transcript(ev) if ev.exists() else None
            if event:
                sid = event.sid
            tr = sessions.get(sid) or event
            if tr:
                linked.add(tr.sid)
            log = path.with_suffix('.log')
            if not tr and log.exists():
                tr = self.transcript(log)
            row = self.row(tr, procs, state)
            row['result'] = read(path.with_suffix('.result.md'))
            row['artifacts'] += [str(p) for p in (log, ev, path.with_suffix('.result.md')) if p.exists()]
            rows.append(row)
        for sid, tr in sessions.items():
            if sid not in linked:
                row = self.row(tr, procs)
                if sid in daily:
                    row['kind'] = 'teams'
                    row['task'] = f'Teams daily {daily[sid]} ({row["worker"]})'
                    row['notify'] = 'Teams conversation (inferred)'
                rows.append(row)
        self.rows = sorted(rows, key=lambda r: r['started'], reverse=True)
        return self.rows

    def expand(self, row):
        path = Path(row['transcript'])
        tr = self.cache.get(path)
        if tr and tr.sampled:
            tr.__init__(path)
            tr.full = True
            tr.update()
            return True
        return False

    def row(self, tr, procs, state=None):
        state = state or {}
        sid = tr.sid if tr else ''
        jid = state.get('id', '')
        pids = [pid for pid, args, files, _ in procs if (jid and '__exec' in args and jid in args) or (sid and sid in args) or (tr and str(tr.path) in files)]
        registration = getattr(self, 'registrations', {}).get(sid, {})
        registered_pid = registration.get('pid')
        for pid, _, _, _ in procs:
            if pid == registered_pid and pid not in pids:
                pids.append(pid)
        started = stamp(state.get('started')) or (tr.started if tr else 0)
        ended = stamp(state.get('finished'))
        last = tr.last if tr else started
        status = state.get('status')
        basis = 'state'
        if status == 'running':
            if pids:
                basis = 'state + live PID'
            else:
                if 'sandbox' in read(Path('/proc/1/cmdline')).split('\0')[0]:
                    status, basis = 'running', 'state only: host PID visibility unavailable in sandbox'
                else:
                    status, basis = 'stopped', 'inferred: state says running, no matching live PID'
        elif not status:
            status = 'running' if pids and (tr.open or time.time() - last < 15) else 'idle'
            basis = 'inferred: live PID + open tool/recent activity' if status == 'running' else 'inferred: no confirmed active tool; idle does not mean exited'
        if state.get('exit') is not None and status not in ('stopped', 'running'):
            status = 'done' if state['exit'] == 0 else 'failed'
            basis = 'state + exit code'
        worker = state.get('kind') or ('claude' if tr and '.claude' in str(tr.path) else 'codex')
        task = state.get('name') or (tr.title or compact(tr.prompt, 90) if tr else '') or sid
        return dict(id=jid or sid, session_id=sid, job_id=jid, kind='job' if jid else worker,
                    worker=worker, task=task, status=status, status_source=basis, pids=pids,
                    started=started, ended=ended, last_activity=last,
                    duration_seconds=max(0, (ended or time.time()) - started) if started else None,
                    duration_source='elapsed since start; includes idle time',
                    model=tr.model if tr else '', notify=('team conversation' if str(state.get('scope', '')).startswith('chats:') else 'owner daily session') if state.get('notify') else 'unknown',
                    exit_code=state.get('exit'), prompt='\n'.join(state.get('payload', [])) or (tr.prompt if tr else ''),
                    now=compact(tr.now) if tr else '', work_done=list(tr.done) if tr else [],
                    in_progress=[f'{name} {compact(args)}' for name, args, _ in tr.open.values()] if tr else [],
                    todos=tr.todos if tr else [], artifacts=sorted(tr.artifacts) if tr else [],
                    result='', final_candidate=tr.final if tr else '', live=list(tr.events) if tr else [],
                    transcript=str(tr.path) if tr else '', warning=(tr.error or ('History sampled (head + tail); detail loads full transcript' if tr.sampled else '')) if tr else 'No transcript found')


def table(rows):
    lines = [f'{"KIND":6} {"TASK":30} {"JOB / SESSION ID":38} {"STATUS*":8} {"STARTED":19} {"END / AGE":19} {"DURATION":9} NOW DOING']
    for r in rows:
        last = date(r['ended'])[:19] if r['ended'] else age(time.time() - r['last_activity']) + ' ago'
        status = r['status'] + ('*' if r['status_source'].startswith(('inferred', 'state only')) else '')
        dur = age(r['duration_seconds']) if r['duration_seconds'] is not None else '?'
        lines.append(f'{r["kind"]:6} {compact(r["task"],30):30} {r["id"]:38} {status:8} {date(r["started"])[:19]:19} {last:19} {dur:9} {r["now"]}')
    return [redact(x) for x in lines]


def detail(r, expanded=False):
    lines = [r['task'], f'Job: {r["job_id"] or "—"} | Session: {r["session_id"] or "—"}',
             f'Worker: {r["worker"]} | Model: {r["model"] or "unknown"} (transcript) | Notify target — {r["notify"]}',
             f'Status: {r["status"]} [{r["status_source"]}] | PID: {r["pids"]} | Exit: {r["exit_code"]}',
             f'Started: {date(r["started"])} | Ended: {date(r["ended"])} (state/transcript)',
             f'Last activity: {date(r["last_activity"])} | Duration: {age(r["duration_seconds"] or 0)} ({r["duration_source"]})',
             f'Transcript: {r["transcript"]}', 'Task prompt (state/transcript; p expands):']
    lines += r['prompt'].splitlines() if expanded else r['prompt'].splitlines()[:5]
    lines += ['Work done (tool returns; latest 2,000 retained):'] + (r['work_done'] or ['None recorded'])
    lines += ['In progress (inferred unmatched calls / last assistant; may be stale if finished):'] + (r['in_progress'] or [r['now'] or 'None recorded'])
    lines += ['Todo (transcript plan):']
    for todo in r['todos']:
        if isinstance(todo, dict):
            lines.append(f'[{"x" if todo.get("status") == "completed" else " "}] {todo.get("content", todo.get("step", ""))} ({todo.get("status", "unknown")})')
    lines += ['Outputs / artifacts (paths mentioned; existence unverified):'] + r['artifacts']
    lines += ['Final result (result file, otherwise last assistant — inferred):', r['result'] or (r['final_candidate'] if r['status'] in ('done', 'failed', 'stopped') else 'Not finished / no final result recorded')]
    if r['warning']:
        lines += [r['warning']]
    return [redact(line) for block in lines for line in str(block).splitlines()]


def tui(screen, monitor, target=None):
    curses.curs_set(0)
    screen.timeout(200)
    selected = 0
    search = ''
    editing = False
    running = False
    expanded = False
    offset = 0
    refresh = 0
    rows = []
    while True:
        if time.monotonic() >= refresh:
            rows = monitor.scan()
            refresh = time.monotonic() + 2
        filtered = [r for r in rows if (not running or r['status'] == 'running') and search.lower() in compact((r['task'], r['id']), 10000).lower()]
        selected = max(0, min(selected, len(filtered) - 1))
        screen.erase()
        height, width = screen.getmaxyx()
        def draw(y, text, highlight=False):
            if 0 <= y < height:
                try:
                    screen.addnstr(y, 0, redact(text), max(0, width - 1), curses.A_REVERSE if highlight else 0)
                except curses.error:
                    pass
        draw(0, f'{monitor.name} monitor | r running · a all · / search · Enter detail · q/Esc back/quit | ' + search)
        current = next((r for r in rows if target in (r['id'], r['session_id'])), None) if target else None
        if target and current:
            if monitor.expand(current):
                rows = monitor.scan()
                continue
            split = max(3, height * 2 // 3)
            lines = detail(current, expanded)
            offset = min(offset, max(0, len(lines) - max(1, split - 2)))
            for y, line in enumerate(lines[offset:offset + split - 2], 1):
                draw(y, line)
            draw(split - 1, 'LIVE FOLLOW (latest 500 events; ↑↓/PgUp/PgDn scroll detail · p prompt)')
            for y, line in enumerate(current['live'][-max(1, height - split):], split):
                draw(y, line)
        elif target:
            draw(2, 'Session disappeared or unavailable; q returns to list')
        else:
            lines = table(filtered)
            draw(1, lines[0])
            start = max(0, selected - max(0, height - 4))
            for index in range(start, min(len(filtered), start + max(0, height - 2))):
                draw(index - start + 2, lines[index + 1], index == selected)
        screen.refresh()
        key = screen.getch()
        if editing:
            if key in (10, 13, 27):
                editing = False
            elif key in (curses.KEY_BACKSPACE, 127, 8):
                search = search[:-1]
            elif 32 <= key < 127:
                search += chr(key)
            continue
        if key in (ord('q'), 27):
            if target:
                target = None
                offset = 0
            else:
                return
        elif key == ord('/') and not target:
            search = ''
            editing = True
        elif key == ord('r'):
            running = True
        elif key == ord('a'):
            running = False
            search = ''
        elif key in (10, 13) and filtered and not target:
            target = filtered[selected]['id']
        elif key == ord('p'):
            expanded = not expanded
        elif key in (curses.KEY_DOWN, curses.KEY_NPAGE):
            step = 10 if key == curses.KEY_NPAGE else 1
            if target:
                offset += step
            else:
                selected += step
        elif key in (curses.KEY_UP, curses.KEY_PPAGE):
            step = 10 if key == curses.KEY_PPAGE else 1
            if target:
                offset = max(0, offset - step)
            else:
                selected = max(0, selected - step)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('session', nargs='?')
    parser.add_argument('--list', action='store_true', help='plain table')
    parser.add_argument('--json', action='store_true', help='redacted structured snapshot')
    parser.add_argument('--once', action='store_true', help='non-interactive detail + readable tail')
    args = parser.parse_args()
    monitor = Monitor()
    rows = monitor.scan()
    if args.session:
        matches = [r for r in rows if args.session in (r['id'], r['session_id'])]
        if not matches:
            parser.error('session/job ID not found')
        if monitor.expand(matches[0]):
            matches = [r for r in monitor.scan() if args.session in (r['id'], r['session_id'])]
        rows = matches
    if args.json:
        print(json.dumps(sanitized(rows), ensure_ascii=False, indent=2))
    elif args.once and args.session:
        print('\n'.join(detail(rows[0]) + ['LIVE FOLLOW (snapshot):'] + rows[0]['live'][-30:]))
    elif args.list or args.once or not sys.stdout.isatty():
        print('\n'.join(table(rows)))
    else:
        curses.wrapper(tui, monitor, args.session)


if __name__ == '__main__':
    main()
