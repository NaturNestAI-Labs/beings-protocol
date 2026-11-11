// triage-jobs.py and being-status: compact job list for triage (teammate chats see only their own lane's jobs, by the
// signed scope), running jobs first, sub-agent actions merged, --no-jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostEnv } from './test-env.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const A = '19:a@thread.v2', B = '19:b@thread.v2';
const iso = (minAgo) => new Date(Date.now() - minAgo * 60000).toISOString();
const host = hostEnv();

function fixture(t) {
  const d = mkdtempSync(path.join(tmpdir(), 'triage-jobs-'));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  const jobs = path.join(d, 'jobs'), scopes = path.join(d, 'job-scopes');
  mkdirSync(jobs); mkdirSync(scopes);
  const job = (id, o, signed) => {
    writeFileSync(path.join(jobs, `${id}.json`), JSON.stringify({ id, kind: 'agent', notify: '', scope: 'full', ...o }));
    if (signed !== undefined) writeFileSync(path.join(scopes, `${id}.json`), JSON.stringify({ scope: signed }));
  };
  job('j1', { name: 'owner-running', status: 'running', started: iso(300) }, 'full');
  job('j2', { name: 'owner-done', status: 'done', exit: 0, started: iso(120), finished: iso(60) }, 'full');
  writeFileSync(path.join(jobs, 'j2.result.md'), '\n# Result: owner thing shipped\nmore\n');
  job('j3', { name: 'a-running', status: 'running', started: iso(10) }, `chats:${A}`);
  // The record claims chat A, but the signed scope says owner: the signed store wins.
  job('j4', { name: 'owner-reports-to-a', status: 'done', exit: 1, started: iso(50), finished: iso(40), notify: A, scope: `chats:${A}` }, 'full');
  job('j5', { name: 'b-done', status: 'done', exit: 0, started: iso(50), finished: iso(30), scope: `chats:${B}` });   // older job, no signed entry
  job('j6', { name: 'owner-old', status: 'done', exit: 0, started: iso(1500), finished: iso(1440) }, 'full');
  return { d, jobs };
}
const run = (jobs, ...a) => execFileSync('python3', [path.join(KIT, 'triage-jobs.py'), '--jobs', jobs, ...a], { encoding: 'utf8', env: host });

test('owner lane: every running job, recent finished ones with their first result line', (t) => {
  const out = run(fixture(t).jobs);
  assert.match(out, /RUNNING JOBS: 2/);
  assert.match(out, /owner-running \[agent\] \(started/);
  assert.match(out, /owner-done \(done, exit 0, \d\d:\d\d\): Result: owner thing shipped/);
  assert.match(out, /b-done/);
  assert.doesNotMatch(out, /owner-old/);   // outside the 12 h window
});

test('teammate lane: only jobs its own lane started, by the signed scope', (t) => {
  const { jobs } = fixture(t);
  const a = run(jobs, '--chat', A);
  assert.match(a, /a-running/);
  assert.doesNotMatch(a, /owner-|b-done/);
  const b = run(jobs, '--chat', B);
  assert.match(b, /RUNNING JOBS: none/);
  assert.match(b, /b-done/);
  assert.doesNotMatch(b, /a-running|owner-/);
});

test('empty dir says none; output is capped', (t) => {
  const e = path.join(fixture(t).d, 'empty'); mkdirSync(e);
  assert.match(run(e), /RUNNING JOBS: none\nFINISHED JOBS \(last 12 h, newest first\): none/);
  const out = run(fixture(t).jobs, '--max', '120');
  assert.ok(out.length <= 160, out);
  assert.match(out, /older entries cut/);
});

test('being-status: running jobs first, last output line, sub-agent actions merged; --no-jobs leaves jobs out', (t) => {
  const { d } = fixture(t);
  const ws = path.join(d, 'ws'), home = path.join(d, 'home'); mkdirSync(ws); mkdirSync(home);
  // Eight finished jobs newer on disk than the running one: running still comes first.
  for (let i = 0; i < 8; i++) {
    writeFileSync(path.join(d, 'jobs', `n${i}.json`), JSON.stringify({ id: `n${i}`, kind: 'run', name: `newer-${i}`, status: 'done',
      exit: 0, started: iso(20), finished: iso(5), scope: 'full' }));
  }
  const old = new Date(Date.now() - 7200e3);
  for (const j of ['j1', 'j3']) utimesSync(path.join(d, 'jobs', `${j}.json`), old, old);
  writeFileSync(path.join(d, 'jobs', 'j1.log'), 'step one\nrendering frame 41/90\n');
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  writeFileSync(path.join(d, 'jobs', 'j1.json'), JSON.stringify({ id: 'j1', kind: 'agent', name: 'owner-running', status: 'running',
    started: iso(300), session_id: sid, scope: 'full' }));
  utimesSync(path.join(d, 'jobs', 'j1.json'), old, old);
  const cdir = path.join(home, '.claude', 'projects', ws.replace(/[/.]/g, '-'));
  mkdirSync(path.join(cdir, sid, 'subagents'), { recursive: true });
  const tool = (name, input) => JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', name, input }] } }) + '\n';
  writeFileSync(path.join(cdir, sid + '.jsonl'), tool('Task', { description: 'delegate review' }));
  writeFileSync(path.join(cdir, sid, 'subagents', 'agent-1.jsonl'), tool('Grep', { pattern: 'needle' }));
  writeFileSync(path.join(cdir, sid, 'subagents', 'agent-1.meta.json'), JSON.stringify({ description: 'code reviewer' }));
  const env = { ...host, HOME: home, BEING_STATE_DIR: d, BEING_WORKSPACE: ws, BEING_NAME: 'testbeing' };
  const st = (...a) => execFileSync('python3', [path.join(KIT, 'being-status'), ...a], { encoding: 'utf8', env, cwd: d });
  const out = st();
  const lines = out.split('\n').filter((l) => l.startsWith('   - '));
  const jl = lines.slice(lines.findIndex((l) => /\[(agent|run)\]/.test(l)));
  assert.deepEqual(jl.slice(0, 2).map((l) => l.split(' [')[0].trim()).sort(), ['- a-running', '- owner-running']);
  assert.equal(jl.length, 8);   // capped at 8, the running ones kept
  assert.match(out, /last output: rendering frame 41\/90/);
  assert.match(out, /Task: delegate review/);
  assert.match(out, /\[code reviewer\] Grep: needle/);
  const nj = st('--no-jobs');
  assert.doesNotMatch(nj, /Jobs:|owner-running/);
});
