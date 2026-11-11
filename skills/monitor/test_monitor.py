import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import uuid

spec = importlib.util.spec_from_file_location('monitor', Path(__file__).with_name('monitor.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MonitorTests(unittest.TestCase):
    def test_redaction_and_json(self):
        value = 'sk-secret123 Bearer abc password=hunter token="hidden" 19:private@thread.v2'
        clean = m.redact(value)
        for secret in ('secret123', 'abc', 'hunter', 'hidden', 'private'):
            self.assertNotIn(secret, clean)
        self.assertEqual(json.loads(json.dumps(m.sanitized({'prompt': value})))['prompt'], clean)

    def test_chat_ids_redacted_but_clock_times_kept(self):
        clean = m.redact('started 19:35 UTC, 8:05 retry; chat 19:ab12_cd@unq.gbl.spaces 8:orgid:9f2c')
        self.assertIn('19:35', clean)
        self.assertIn('8:05', clean)
        self.assertNotIn('ab12', clean)
        self.assertNotIn('9f2c', clean)

    def test_incremental_partial_rotation_and_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 's.jsonl'
            call = {'timestamp': '2026-10-19T00:00:00Z', 'type': 'response_item', 'payload': {'type': 'function_call', 'call_id': '1', 'name': 'update_plan', 'arguments': json.dumps({'plan': [{'step': 'build', 'status': 'completed'}]})}}
            result = {'timestamp': '2026-10-19T00:01:00Z', 'type': 'response_item', 'payload': {'type': 'function_call_output', 'call_id': '1', 'output': 'ok'}}
            path.write_text(json.dumps(call) + '\n' + json.dumps(result)[:20])
            tr = m.Transcript(path)
            tr.update()
            self.assertEqual(len(tr.open), 1)
            self.assertEqual(tr.todos[0]['status'], 'completed')
            with path.open('a') as out:
                out.write(json.dumps(result)[20:] + '\n')
            tr.update()
            self.assertFalse(tr.open)
            self.assertEqual(len(tr.done), 1)
            tr.update()
            self.assertEqual(len(tr.done), 1)
            path.write_text('{}\n')
            tr.update()
            self.assertFalse(tr.done)

    def test_claude_tools_and_failure(self):
        tr = m.Transcript(Path('fake'))
        tr.consume({'type': 'assistant', 'message': {'role': 'assistant', 'model': 'test', 'content': [{'type': 'tool_use', 'id': 'a', 'name': 'Write', 'input': {'file_path': 'ops/example.txt'}}]}})
        tr.consume({'type': 'user', 'message': {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': 'a', 'content': 'denied', 'is_error': True}]}})
        self.assertIn('failed', tr.done[0])
        self.assertIn('ops/example.txt', tr.artifacts)
        self.assertFalse(tr.open)

    def test_job_state_and_dedup(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            jobs = root / 'ops/teams-kit/state/jobs'
            jobs.mkdir(parents=True)
            sessions = root / '.claude/projects/project'
            sessions.mkdir(parents=True)
            (sessions / 'sid.jsonl').write_text(json.dumps({'type': 'assistant', 'message': {'role': 'assistant', 'content': 'finished'}}) + '\n')
            (jobs / 'job.json').write_text(json.dumps({'id': 'job', 'session_id': 'sid', 'name': 'test', 'kind': 'agent', 'status': 'done', 'exit': 0, 'payload': ['task']}))
            monitor = m.Monitor(root, root, name='nova')
            rows = monitor.scan()
            job = next(r for r in rows if r['id'] == 'job')
            self.assertEqual(job['status'], 'done')
            self.assertFalse(any(r['id'] == 'sid' for r in rows))
            self.assertIn('Work done', '\n'.join(m.detail(job)))

    def test_state_dir_and_team_notify(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            jobs = root / 'elsewhere/jobs'
            jobs.mkdir(parents=True)
            (jobs / 'j1.json').write_text(json.dumps({'id': 'j1', 'name': 'team job', 'kind': 'agent', 'status': 'done', 'exit': 0,
                                                       'notify': 'chat-a', 'scope': 'chats:chat-a'}))
            (jobs / 'j2.json').write_text(json.dumps({'id': 'j2', 'name': 'owner job', 'kind': 'agent', 'status': 'done', 'exit': 0,
                                                       'notify': 'chat-b', 'scope': 'full'}))
            rows = {r['id']: r for r in m.Monitor(root, root, state=root / 'elsewhere', name='nova').scan()}
            self.assertEqual(rows['j1']['notify'], 'team conversation')
            self.assertEqual(rows['j2']['notify'], 'owner daily session')

    def test_daily_session_from_being_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            sessions = root / '.claude/projects/p'
            sessions.mkdir(parents=True)
            now = time.time()
            today = m.day(now)
            stamp = m.dt.datetime.fromtimestamp(now, m.dt.timezone.utc).isoformat()
            sid = str(uuid.uuid5(uuid.NAMESPACE_URL, f'being-daily/nova/{today}'))
            line = {'timestamp': stamp, 'type': 'user', 'message': {'role': 'user', 'content': 'hello'}}
            (sessions / f'{sid}.jsonl').write_text(json.dumps(line) + '\n')
            (sessions / 'other.jsonl').write_text(json.dumps(line) + '\n')
            marked = dict(line, message={'role': 'user', 'content': f'[nova Teams work · daily session {today} · lane=owner]'})
            (sessions / 'marked.jsonl').write_text(json.dumps(marked) + '\n')
            rows = {r['session_id']: r for r in m.Monitor(root, root, state=root / 'state', name='nova').scan()}
            self.assertEqual(rows[sid]['kind'], 'teams')
            self.assertEqual(rows['marked']['kind'], 'teams')
            self.assertNotEqual(rows['other']['kind'], 'teams')
            rows = {r['session_id']: r for r in m.Monitor(root, root, state=root / 'state', name='other').scan()}
            self.assertNotEqual(rows[sid]['kind'], 'teams')

    def test_timezone_follows_tz(self):
        old = os.environ.get('TZ')
        try:
            os.environ['TZ'] = 'UTC'
            time.tzset()
            self.assertEqual(m.date(86400), '1970-01-02 00:00:00 UTC')
        finally:
            if old is None:
                os.environ.pop('TZ', None)
            else:
                os.environ['TZ'] = old
            time.tzset()
        self.assertEqual(m.date(None), 'unknown')

    def test_worker_names_are_generic(self):
        self.assertEqual(set(m.WORKERS), {'codex', 'claude', 'being-job', 'being-handle'})


if __name__ == '__main__':
    unittest.main()
