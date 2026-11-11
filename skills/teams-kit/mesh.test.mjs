// Session mesh: names, the live registry, being-steer (live and durable), the board's scope, per-lane work locks and
// the lost-message case, in a throwaway kit with a fake `claude` (nothing is sent anywhere).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostEnv } from './test-env.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake claude for work runs: logs {name, sid, ids, t0, t1} per run; a prompt with SLOWWORK takes 1.5 s.
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2), prompt = a[a.length - 1] || '';
const opt = (k) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : '');
const ids = prompt.split('\\n').filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l).messageId; } catch { return null; } }).filter(Boolean);
const t0 = Date.now();
const done = () => { fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name: opt('-n'), sid: opt('--session-id') || opt('--resume'), ids, t0, t1: Date.now(),
  noSend: a.includes('--disallowedTools') && opt('--disallowedTools') === 'SendMessage', perm: a.includes('dontAsk') ? 'dontAsk' : 'bypass' }) + '\\n'); };
// LONGWORK runs 4 s; with FAKE_READ_RELAY set, the run "reads" what the relay delivered (it lands in its transcript).
const readRelay = () => {
  if (!process.env.FAKE_READ_RELAY || !fs.existsSync(process.env.RELAY_LOG)) return;
  const d = require('path').join(process.env.HOME, '.claude', 'projects', fs.realpathSync(process.cwd()).replace(/[/.]/g, '-'));
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(require('path').join(d, opt('--session-id') + opt('--resume') + '.jsonl'), JSON.stringify({ type: 'user', text: fs.readFileSync(process.env.RELAY_LOG, 'utf8') }) + '\\n');
};
if (prompt.includes('LONGWORK') && !a.includes('--tools')) setTimeout(() => { readRelay(); done(); }, 4000);
else if (prompt.includes('SLOWWORK')) setTimeout(done, 1500); else done();
`;
// Fake relay (BEING_STEER_CMD): records what it was asked to send; FAILNOW in the text makes it fail.
const RELAY = `#!/usr/bin/env node
const fs = require('fs'); const t = fs.readFileSync(0, 'utf8');
fs.appendFileSync(process.env.RELAY_LOG, JSON.stringify({ args: process.argv.slice(2), prompt: t }) + '\\n');
process.stdout.write(t.includes('FAILNOW') ? 'FAILED: not reachable' : 'SENT');
`;

function kit(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mesh-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const k = path.join(dir, 'kit'), st = path.join(dir, 'state'), bin = path.join(dir, 'bin'), cs = path.join(dir, 'claude-sessions');
  for (const d of [k, st, bin, cs, path.join(dir, 'ws'), path.join(dir, 'home'), path.join(st, 'jobs')]) mkdirSync(d, { recursive: true });
  for (const f of ['being-handle', 'being-status', 'being-sessions', 'being-steer', 'being-board', 'mesh.py', 'scope.mjs', 'kit-env.mjs',
    'secrets.mjs', 'team-fence.py', 'ack-schema.json', 'voice-schema.json', 'fast-warm.mjs', 'comms-log.mjs', 'soul.py']) copyFileSync(path.join(KIT, f), path.join(k, f));
  for (const f of ['being-handle', 'being-status', 'being-sessions', 'being-steer', 'being-board']) chmodSync(path.join(k, f), 0o755);
  writeFileSync(path.join(k, 'teams-ack.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.BEING_STATE_DIR + '/ack-in.json', readFileSync(0, 'utf8'));\n`);
  writeFileSync(path.join(bin, 'claude'), FAKE); chmodSync(path.join(bin, 'claude'), 0o755);
  writeFileSync(path.join(bin, 'relay'), RELAY); chmodSync(path.join(bin, 'relay'), 0o755);
  mkdirSync(path.join(dir, 'nosetsid'));   // triage-only tests: the hand-off to work stays queued for the asserts
  writeFileSync(path.join(dir, 'nosetsid', 'setsid'), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(dir, 'nosetsid', 'setsid'), 0o755);
  writeFileSync(path.join(k, '.env'), `BEING_NAME=Testbeing\nBEING_STATE_DIR=${st}\nBEING_WORKSPACE=${path.join(dir, 'ws')}\n` +
    `BEING_FAST_CLIENT=claude\nBEING_FAST_WARM=0\nOWNER_NAME=Owner\nOWNER_OID=owner-oid\nBEING_SINGLE_USER_ACK=1\n` +
    `BEING_CLAUDE_SESSIONS_DIR=${cs}\nBEING_STEER_CMD=${path.join(bin, 'relay')}\n`);
  // Nothing from the host's kit settings leaks in (this job itself runs with the real .env sourced).
  const host = hostEnv();
  const env = { ...host, PATH: `${bin}:${process.env.PATH}`, HOME: path.join(dir, 'home'), BEING_KIT_HOME: k, BEING_STATE_DIR: st,
    FAKE_LOG: path.join(dir, 'fake.log'), RELAY_LOG: path.join(dir, 'relay.log'), BEING_SEND_TOKEN: '' };
  delete env.BEING_SESSION_NAME;
  const run = (cmd, args, extra = {}, input) => spawnSync(path.join(k, cmd), args, { env: { ...env, ...extra }, encoding: 'utf8', input });
  const py = (code, extra = {}) => spawnSync('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(k)}); import mesh\n${code}`],
    { env: { ...env, ...extra }, encoding: 'utf8' });
  const mint = (scope) => spawnSync('node', [path.join(k, 'scope.mjs'), 'mint', scope], { env, encoding: 'utf8' }).stdout.trim();
  const read = (f) => (existsSync(path.join(st, f)) ? readFileSync(path.join(st, f), 'utf8') : '');
  const jl = (f) => read(f).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const fake = () => (existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { dir, k, st, env, run, py, mint, read, jl, fake };
}
const tmsg = (chat, id, text, from = 'Robin Lee', extra = {}) => ({ chatId: chat, chatType: 'oneOnOne', fromId: 'oid-' + from, from, messageId: id, text, at: '2026-10-12T12:00:00Z', ...extra });
const omsg = (id, text) => ({ chatId: '19:owner-chat', chatType: 'oneOnOne', fromId: 'owner-oid', from: 'Owner', messageId: id, text, at: '2026-10-12T12:00:00Z' });

// ---------- names and registry ----------
test('names: owner, teammate first name (collision gets a suffix), warm, heartbeat and unique job names', (t) => {
  const { py } = kit(t);
  const r = py(`
print(mesh.lane_name("owner"))
print(mesh.lane_name("team:19:a", [{"chatType":"oneOnOne","fromId":"x","from":"Robin Lee"}]))
print(mesh.lane_name("team:19:a", kind="warm"))
print(mesh.lane_name("team:19:b", [{"chatType":"oneOnOne","fromId":"y","from":"Robin Kumar"}]))
print(mesh.lane_name("team:19:g", [{"chatType":"group","topic":"Site Ops","fromId":"z","from":"Ari"}]))
print(mesh.job_name("heartbeat"))
print(mesh.job_name("Box Restore!"))
import os; mesh.register("testbeing-job-box-restore","owner","job",os.getpid())
print(mesh.job_name("box restore"))`);
  assert.equal(r.status, 0, r.stderr);
  const [owner, robin, warm, robin2, grp, hb, job, job2] = r.stdout.trim().split('\n');
  assert.equal(owner, 'testbeing-owner'); assert.equal(robin, 'testbeing-team-robin'); assert.equal(warm, 'testbeing-warm-robin');
  assert.match(robin2, /^testbeing-team-robin-[0-9a-f]{4}$/); assert.equal(grp, 'testbeing-team-site-ops');
  assert.equal(hb, 'testbeing-heartbeat'); assert.equal(job, 'testbeing-job-box-restore'); assert.equal(job2, 'testbeing-job-box-restore-2');
});

test('registry: a live pid is alive, idle comes from the Claude session file, a dead or ended one is ended', async (t) => {
  const { py, run, env, dir } = kit(t);
  const live = spawn('sleep', ['30']); t.after(() => live.kill());
  const idle = spawn('sleep', ['30']); t.after(() => idle.kill());
  writeFileSync(path.join(dir, 'claude-sessions', `${idle.pid}.json`), JSON.stringify({ pid: idle.pid, status: 'idle', updatedAt: Date.now() }));
  const r = py(`
mesh.register("a-live","owner","work",${live.pid},"sid-1","bypassPermissions")
mesh.register("b-idle","team:19:x","warm",${idle.pid})
mesh.register("c-gone","owner","job",999999)
mesh.register("d-ended","owner","work",${live.pid}); mesh.end("d-ended",${live.pid})
print({e["name"]:e["state"] for e in mesh.sessions(include_other=False)})`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /'a-live': 'alive'/); assert.match(r.stdout, /'b-idle': 'idle'/);
  assert.match(r.stdout, /'c-gone': 'ended'/); assert.match(r.stdout, /'d-ended': 'ended'/);
  const l = run('being-sessions', []);
  assert.match(l.stdout, /1 working, 1 idle/); assert.match(l.stdout, /a-live/); assert.doesNotMatch(l.stdout, /c-gone/);
  assert.match(run('being-sessions', ['--all']).stdout, /c-gone/);
  void env;
});

// ---------- steering ----------
test('steer, target not running: a durable note in the lane queue, then triage hands it to work with no ack and no model', (t) => {
  const { run, read, jl, py, st } = kit(t);
  py(`mesh.lane_name("team:19:robin", [{"chatType":"oneOnOne","fromId":"n","from":"Robin Lee"}])`);
  const r = run('being-steer', ['testbeing-team-robin', 'Please re-run the sales export for Robin.'], { BEING_MESH_NO_WAKE: '1', BEING_SESSION_NAME: 'testbeing-owner' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /queued for testbeing-team-robin/);
  const [q] = jl('queue.jsonl');
  assert.equal(q.addressedBy, 'note'); assert.equal(q.noteLane, 'team:19:robin'); assert.equal(q.chatId, '19:robin');
  assert.equal(q.from, 'Testbeing (testbeing-owner)'); assert.equal(q.text, 'Please re-run the sales export for Robin.');
  assert.notEqual(q.fromId, 'owner-oid');   // a note never carries the owner's id
  const tr = run('being-handle', ['triage'], { PATH: `${path.dirname(st)}/nosetsid:${path.dirname(st)}/bin:${process.env.PATH}` });
  assert.equal(tr.status, 0, tr.stderr);
  assert.equal(read('queue.jsonl'), '');
  assert.match(read('work.jsonl'), /"addressedBy": "note"/);
  assert.equal(existsSync(path.join(st, 'ack-in.json')), false);   // nothing posted in the chat
  assert.match(read('handler.log'), /notes: 1 to work/);
  assert.match(read('notes.jsonl'), /"event": "fallback"/);
});

test('steer, target running: delivered live through a relay in the same permission mode; unread by the end → durable', async (t) => {
  const { run, py, jl, dir, read } = kit(t);
  const live = spawn('sleep', ['30']); t.after(() => live.kill());
  py(`mesh.lane_name("team:19:robin", [{"chatType":"oneOnOne","fromId":"n","from":"Robin Lee"}])
mesh.register("testbeing-team-robin","team:19:robin","work",${live.pid},"sid-n","dontAsk")`);
  const r = run('being-steer', ['testbeing-team-robin', 'Also attach the CSV.'], { BEING_MESH_NO_WAKE: '1' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /delivered live/);
  const relay = readFileSync(path.join(dir, 'relay.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(relay.length, 1);
  assert.ok(relay[0].args.includes('dontAsk'), 'relay matches the target permission mode');
  assert.ok(relay[0].args.includes('SendMessage') && relay[0].args.includes('-n'));
  assert.match(relay[0].prompt, /to = "testbeing-team-robin"/); assert.match(relay[0].prompt, /Also attach the CSV\./);
  assert.equal(read('queue.jsonl'), '');
  const nid = /note (n\d+-[0-9a-f]+)/.exec(relay[0].prompt)[1];
  // The run ends without the note in its transcript: it goes to the lane's queue, once.
  const tr = path.join(dir, 'transcript.jsonl'); writeFileSync(tr, '{"type":"user"}\n');
  const e = run('being-sessions', ['end', '--name', 'testbeing-team-robin', '--pid', String(live.pid), '--transcript', tr], { BEING_MESH_NO_WAKE: '1' });
  assert.equal(e.status, 0, e.stderr); assert.match(e.stdout, new RegExp(nid));
  assert.equal(jl('queue.jsonl').length, 1);
  run('being-sessions', ['end', '--name', 'testbeing-team-robin', '--pid', String(live.pid), '--transcript', tr], { BEING_MESH_NO_WAKE: '1' });
  assert.equal(jl('queue.jsonl').length, 1, 'settling twice never duplicates');
});

test('steer, live note that the run did read: no durable copy (no duplicate)', async (t) => {
  const { run, py, jl, dir } = kit(t);
  const live = spawn('sleep', ['30']); t.after(() => live.kill());
  py(`mesh.register("testbeing-owner","owner","work",${live.pid},"sid-o","bypassPermissions")`);
  assert.equal(run('being-steer', ['testbeing-owner', 'Check the Videonautics reply.'], { BEING_MESH_NO_WAKE: '1' }).status, 0);
  const nid = /note (n\d+-[0-9a-f]+)/.exec(readFileSync(path.join(dir, 'relay.log'), 'utf8'))[1];
  const tr = path.join(dir, 'transcript.jsonl'); writeFileSync(tr, JSON.stringify({ text: `[note ${nid} from Testbeing (x) via being-steer] ...` }) + '\n');
  run('being-sessions', ['end', '--name', 'testbeing-owner', '--pid', String(live.pid), '--transcript', tr], { BEING_MESH_NO_WAKE: '1' });
  assert.equal(jl('queue.jsonl').length, 0);
  assert.match(readFileSync(path.join(dir, 'state', 'notes.jsonl'), 'utf8'), /"read live"/);
});

test('steer, live send fails: falls back to the durable note at once', (t) => {
  const { run, py, jl } = kit(t);
  const live = spawn('sleep', ['30']); t.after(() => live.kill());
  py(`mesh.register("testbeing-owner","owner","work",${live.pid},"sid-o","bypassPermissions")`);
  const r = run('being-steer', ['testbeing-owner', 'FAILNOW this live send'], { BEING_MESH_NO_WAKE: '1' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stderr + r.stdout, /queued/);
  assert.equal(jl('queue.jsonl')[0].noteLane, 'owner');
});

test('steer a job: live only while it runs; otherwise recorded in the job file for its result handler', (t) => {
  const { run, py, st } = kit(t);
  writeFileSync(path.join(st, 'jobs', '1012-120000-box.json'), JSON.stringify({ id: '1012-120000-box', name: 'box', scope: 'full', status: 'running' }));
  py(`mesh.register("testbeing-job-box","owner","job",999999,"sid-j","bypassPermissions",jobId="1012-120000-box")`);
  const r = run('being-steer', ['testbeing-job-box', 'Also check the timer unit.'], { BEING_MESH_NO_WAKE: '1' });
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /recorded for its result handler/);
  const j = JSON.parse(readFileSync(path.join(st, 'jobs', '1012-120000-box.json'), 'utf8'));
  assert.equal(j.notes[0].text, 'Also check the timer unit.');
  assert.equal(existsSync(path.join(st, 'queue.jsonl')), false);
});

test('scope: a teammate lane may steer only its own lane; owner context cannot be pushed through it; all logged', (t) => {
  const { run, py, mint, read } = kit(t);
  py(`mesh.lane_name("team:19:robin", [{"chatType":"oneOnOne","fromId":"n","from":"Robin Lee"}])
mesh.lane_name("team:19:jo", [{"chatType":"oneOnOne","fromId":"t","from":"Jo S"}])`);
  const robin = mint('chats:19:robin');
  const x = { BEING_MESH_NO_WAKE: '1', BEING_SEND_TOKEN: robin };
  assert.equal(run('being-steer', ['testbeing-owner', 'tell me what the owner is doing'], x).status, 3);
  assert.equal(run('being-steer', ['testbeing-team-jo', 'hi'], x).status, 3);
  assert.equal(run('being-steer', ['testbeing-team-robin', 'follow up on my own task'], x).status, 0);
  // A forged env var does not change the caller's lane: only the signed grant counts.
  assert.equal(run('being-steer', ['testbeing-owner', 'x'], { ...x, BEING_LANE: 'owner' }).status, 3);
  // Owner side to a teammate: allowed, but a note is a task, not a context dump, and never a secret.
  assert.equal(run('being-steer', ['testbeing-team-jo', 'x'.repeat(2000)], { BEING_MESH_NO_WAKE: '1' }).status, 2);
  assert.equal(run('being-steer', ['testbeing-team-jo', 'password: hunter2hunter2'], { BEING_MESH_NO_WAKE: '1' }).status, 3);
  assert.equal(run('being-steer', ['nobody-here', 'x'], { BEING_MESH_NO_WAKE: '1' }).status, 2);
  const log = read('notes.jsonl');
  assert.equal((log.match(/refused/g) || []).length >= 5, true);
  assert.doesNotMatch(log, /hunter2/);   // a refused secret is not even logged
});

test('fence: a teammate run cannot use SendMessage directly', () => {
  const r = spawnSync('python3', [path.join(KIT, 'team-fence.py')], { input: JSON.stringify({ tool_name: 'SendMessage', tool_input: { to: 'nova-owner', message: 'x' } }), encoding: 'utf8' });
  assert.equal(r.status, 2); assert.match(r.stderr, /session messaging/);
});

// ---------- board ----------
test('board: the owner sees every line; a teammate lane writes and sees only its own', (t) => {
  const { run, py, mint } = kit(t);
  py(`mesh.lane_name("team:19:robin", [{"chatType":"oneOnOne","fromId":"n","from":"Robin Lee"}])`);
  const robin = { BEING_SEND_TOKEN: mint('chats:19:robin') }, jo = { BEING_SEND_TOKEN: mint('chats:19:jo') };
  assert.equal(run('being-board', ['add', 'promise', 'Owner private: board meeting prep'], {}).status, 0);
  assert.equal(run('being-board', ['add', 'handoff', 'Robin: review PR 5 by Monday', '--lane', 'testbeing-team-robin'], {}).status, 0);
  assert.equal(run('being-board', ['add', 'done', 'Sent Robin the export'], robin).status, 0);
  assert.equal(run('being-board', ['add', 'done', 'sneaky', '--lane', 'owner'], robin).status, 3);
  assert.equal(run('being-board', ['add', 'maybe', 'x'], {}).status, 2);
  const own = run('being-board', ['list'], {}).stdout, n = run('being-board', ['list'], robin).stdout, tr = run('being-board', ['list'], jo).stdout;
  assert.match(own, /board meeting prep/); assert.match(own, /review PR 5/); assert.match(own, /Sent Robin the export/);
  assert.doesNotMatch(n, /board meeting prep/); assert.match(n, /review PR 5/); assert.match(n, /Sent Robin the export/);
  assert.doesNotMatch(tr, /review PR 5|board meeting|Sent Robin/);
  // being-status: the owner view lists the board, a teammate chat's view only its lane's lines.
  const s = run('being-status', ['--chat', '19:robin']).stdout;
  assert.match(s, /review PR 5/); assert.doesNotMatch(s, /board meeting prep/);
  assert.match(run('being-status', []).stdout, /Board today: 3/);
});

// ---------- per-lane work locks ----------
async function drained(k, ids, ms = 20000) {
  for (let i = 0; i < ms / 100; i++) {
    const seen = k.fake().flatMap((r) => r.ids);
    const busy = existsSync(path.join(k.st, 'lanes')) && readdirSync(path.join(k.st, 'lanes')).some((f) => f.endsWith('.inbox.jsonl') && readFileSync(path.join(k.st, 'lanes', f), 'utf8').trim());
    if (ids.every((id) => seen.includes(id)) && !busy && !existsSync(path.join(k.st, 'work.jsonl'))) {
      await sleep(400); return k.fake();
    }
    await sleep(100);
  }
  throw new Error('work not drained: ' + JSON.stringify(k.fake()));
}
const putWork = (k, msgs) => k.py(`mesh.append_work(${JSON.stringify(msgs.map((m) => JSON.stringify(m)))})`);

test('two lanes run at once: a teammate does not wait behind the owner\'s long run', async (t) => {
  const k = kit(t);
  putWork(k, [omsg('o1', 'SLOWWORK long owner task'), tmsg('19:robin', 'n1', 'quick question')]);
  assert.equal(k.run('being-handle', ['work']).status, 0);
  const runs = await drained(k, ['o1', 'n1']);
  const o = runs.find((r) => r.ids.includes('o1')), n = runs.find((r) => r.ids.includes('n1'));
  assert.equal(o.name, 'testbeing-owner'); assert.equal(n.name, 'testbeing-team-robin');
  assert.ok(n.t1 < o.t1, 'the teammate run finished while the owner run was still going');
  assert.ok(o.noSend && n.noSend, 'work runs have no SendMessage tool');
  assert.equal(n.perm, 'dontAsk');
  assert.notEqual(o.sid, n.sid);
  const reg = JSON.parse(k.read('sessions.json')).sessions;
  assert.equal(reg['testbeing-owner'].kind, 'work'); assert.ok(reg['testbeing-owner'].endedAt);
  assert.equal(reg['testbeing-team-robin'].perm, 'dontAsk');
});

test('one lane, two batches: they run one after the other in the same session; nothing lost or doubled', async (t) => {
  const k = kit(t);
  putWork(k, [tmsg('19:robin', 'a1', 'SLOWWORK first')]);
  k.run('being-handle', ['work']);
  await sleep(500);   // the first batch is running now
  putWork(k, [tmsg('19:robin', 'a2', 'second'), tmsg('19:robin', 'a3', 'third')]);
  k.run('being-handle', ['work']);
  const runs = (await drained(k, ['a1', 'a2', 'a3'])).filter((r) => r.name === 'testbeing-team-robin');
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].ids, ['a1']); assert.deepEqual(runs[1].ids, ['a2', 'a3']);
  assert.ok(runs[1].t0 >= runs[0].t1, 'no overlap inside a lane');
  assert.equal(runs[0].sid, runs[1].sid);
});

test('lost-message case: writers and dispatchers racing; every message runs exactly once in its lane', async (t) => {
  const k = kit(t);
  const ids = [];
  const writers = [];
  for (let w = 0; w < 4; w++) {
    const msgs = [];
    for (let i = 0; i < 6; i++) { const id = `w${w}m${i}`; ids.push(id); msgs.push(w % 2 ? tmsg(`19:chat${w}`, id, 'x') : omsg(id, 'x')); }
    // each writer appends one message at a time and starts a dispatcher after each, like triage and being-job do
    writers.push(new Promise((res) => {
      const code = `import json,subprocess,time
for m in ${JSON.stringify(msgs.map((m) => JSON.stringify(m)))}:
    mesh.append_work([m]); subprocess.Popen([${JSON.stringify(path.join(k.k, 'being-handle'))},"work"]); time.sleep(0.05)`;
      const p = spawn('python3', ['-c', `import sys; sys.path.insert(0, ${JSON.stringify(k.k)}); import mesh\n${code}`], { env: k.env, stdio: 'ignore' });
      p.on('exit', res);
    }));
  }
  await Promise.all(writers);
  const runs = await drained(k, ids);
  const seen = runs.flatMap((r) => r.ids);
  assert.deepEqual([...seen].sort(), [...ids].sort(), 'each message exactly once');
  for (const r of runs) {
    const lanes = new Set(r.ids.map((id) => (id.startsWith('w1') || id.startsWith('w3') ? id.slice(0, 2) : 'owner')));
    assert.equal(lanes.size, 1, 'a run only ever holds one lane\'s messages');
  }
  // inside each lane, runs never overlap
  for (const name of new Set(runs.map((r) => r.name))) {
    const rs = runs.filter((r) => r.name === name).sort((a, b) => a.t0 - b.t0);
    for (let i = 1; i < rs.length; i++) assert.ok(rs[i].t0 >= rs[i - 1].t1, `${name} overlapped`);
  }
});

test('comms log: parallel appends stay whole lines', async (t) => {
  const k = kit(t);
  const code = `import { logComms } from ${JSON.stringify(path.join(k.k, 'comms-log.mjs'))}; for (let i = 0; i < 40; i++) logComms({ dir: 'out', text: process.argv[1].repeat(3000) });`;
  await Promise.all(['a', 'b', 'c'].map((c) => new Promise((res) => spawn('node', ['--input-type=module', '-e', code, c], { env: k.env, stdio: 'ignore' }).on('exit', res))));
  const lines = k.read('comms.jsonl').split('\n').filter(Boolean);
  assert.equal(lines.length, 120);
  for (const l of lines) assert.equal(JSON.parse(l).text.length, 3000);
});

// ---------- mid-run injection ----------
const until = async (f, ms = 15000) => { for (let i = 0; i < ms / 100 && !f(); i++) await sleep(100); return f(); };
const INJ = { BEING_INJECT_POLL: '0.1', BEING_INJECT_GRACE: '0.3' };
async function midRun(t, extra = {}) {
  const k = kit(t);
  putWork(k, [tmsg('19:robin', 'b1', 'LONGWORK build the sheet')]);
  assert.equal(k.run('being-handle', ['work'], { ...INJ, ...extra }).status, 0);
  assert.ok(await until(() => k.read('sessions.json').includes('testbeing-team-robin')), 'first run is up');
  // The second message arrives mid-run: triage acks it as usual and hands the work to the running session, live.
  writeFileSync(path.join(k.st, 'queue.jsonl'), JSON.stringify(tmsg('19:robin', 'b2', 'also add the totals row')) + '\n');
  const tr = k.run('being-handle', ['triage'], { ...INJ, ...extra });
  assert.equal(tr.status, 0, tr.stderr);
  assert.ok(existsSync(path.join(k.st, 'ack-in.json')), 'triage still sends its first response');
  assert.ok(!k.read('work.jsonl').includes('"b2"'), 'not queued: injected');
  assert.ok(await until(() => existsSync(path.join(k.dir, 'relay.log'))), 'relayed');
  const relay = readFileSync(path.join(k.dir, 'relay.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(relay.length, 1);
  assert.match(relay[0].prompt, /to = "testbeing-team-robin"/); assert.match(relay[0].prompt, /also add the totals row/);
  assert.match(relay[0].prompt, /messageId b2/); assert.ok(relay[0].args.includes('dontAsk'), 'relay in the run\'s permission mode');
  const nid = /\[note (m\d+-[0-9a-f]+) /.exec(relay[0].prompt)[1];
  return { k, nid };
}
const noteStatus = (k, nid) => JSON.parse(k.read(`notes/${nid}.json`) || '{}').status;
const robinRuns = (k) => k.fake().filter((r) => r.name === 'testbeing-team-robin');

test('mid-run: a message for a busy lane goes into the running session live; read there, so no second run', async (t) => {
  const { k, nid } = await midRun(t, { FAKE_READ_RELAY: '1' });
  assert.ok(await until(() => noteStatus(k, nid) === 'read-live'), `status ${noteStatus(k, nid)}`);
  await sleep(1500);
  assert.deepEqual(robinRuns(k).map((r) => r.ids), [['b1']], 'b2 was handled inside the first run');
  assert.ok(!k.read('work.jsonl').includes('"b2"'));
});

test('mid-run: the run ends without reading it → queued once, and it runs in the lane', async (t) => {
  const { k, nid } = await midRun(t);
  assert.ok(await until(() => robinRuns(k).length === 2, 20000), 'the fallback run happened');
  assert.equal(noteStatus(k, nid), 'queued');
  await sleep(1500);   // the injector's own watcher has run by now and must not queue it again
  const runs = robinRuns(k);
  assert.deepEqual(runs.map((r) => r.ids), [['b1'], ['b2']]);
  assert.equal(runs[0].sid, runs[1].sid, 'same lane session');
});

test('mid-run: the handler died before settling → the injector queues it once the run\'s process is gone', async (t) => {
  const { py, read, dir } = kit(t);
  const live = spawn('sleep', ['30']); t.after(() => live.kill());
  py(`mesh.lane_name("team:19:robin", [{"chatType":"oneOnOne","fromId":"n","from":"Robin Lee"}])
mesh.register("testbeing-team-robin","team:19:robin","work",${live.pid},"sid-n","dontAsk")`);
  const r = py(`import json; print(",".join(mesh.route_work([json.dumps(${JSON.stringify(tmsg('19:robin', 'b3', 'and the chart'))})])))`,
    { ...INJ, BEING_MESH_NO_WAKE: '1' });
  assert.equal(r.status, 0, r.stderr); const nid = r.stdout.trim(); assert.match(nid, /^m\d+-/);
  assert.equal(read('work.jsonl'), '');
  assert.ok(await until(() => existsSync(path.join(dir, 'relay.log'))));
  live.kill();
  assert.ok(await until(() => read('work.jsonl').includes('"b3"')), 'queued after the process exited');
  await sleep(800);
  assert.equal(read('work.jsonl').split('\n').filter((l) => l.includes('"b3"')).length, 1);
  assert.equal(JSON.parse(read(`notes/${nid}.json`)).status, 'queued');
});

test('mid-run: no live run → the work queue as before; the rule is in COMMON_RULES', (t) => {
  const { py, read } = kit(t);
  const r = py(`import json; print(mesh.route_work([json.dumps(${JSON.stringify(tmsg('19:robin', 'c1', 'hello'))})]))`);
  assert.equal(r.stdout.trim(), '[]'); assert.match(read('work.jsonl'), /"c1"/);
  assert.match(readFileSync(path.join(KIT, 'being-handle'), 'utf8'),
    /A message may arrive while you work\. If it changes what you are doing, adapt now; otherwise finish the current step, then\n  answer it\. Never drop it\./);
});


// ---------- routing audit ----------
const gmsg = (id, text, from = 'Kim Park', fromId = 'oid-kim', extra = {}) =>
  ({ chatId: '19:grp@thread.v2', chatType: 'group', topic: 'Ops-Desk', fromId, from, messageId: id, text, at: new Date().toISOString(), addressedBy: 'named-or-mentioned', ...extra });
const conv = (k, chat, rows) => {
  mkdirSync(path.join(k.st, 'conversations'), { recursive: true });
  writeFileSync(path.join(k.st, 'conversations', chat.replace(/[^A-Za-z0-9._@-]/g, '_') + '.jsonl'), rows.map((r) => JSON.stringify({ chatId: chat, ...r })).join('\n') + '\n');
};

test('routing: needs_reply / silent / drop_answered decide from the chat\'s comms record', (t) => {
  const k = kit(t);
  const now = new Date().toISOString();
  conv(k, '19:grp@thread.v2', [
    { loggedAt: now, dir: 'out', kind: 'message', messageId: 'r1', replyTo: 'q1' },
    { loggedAt: now, dir: 'out', kind: 'ack-reply', messageId: 'a2', replyTo: 'q2' }]);
  const r = k.py(`import json
ms=[${[gmsg('q1', 'can you check?'), gmsg('q2', 'what about this?'), gmsg('q3', 'thanks'), { ...gmsg('n1', 'note'), addressedBy: 'note' },
    gmsg('o1', 'cross that as well', 'Owner', 'owner-oid'), gmsg('o2', 'ok', 'Owner', 'owner-oid'), { ...gmsg('q4', 'is it done?'), ack: { answered: true, action: 'reply', text: 'yes' } }]
    .map((m) => JSON.stringify(JSON.stringify(m))).join(',')}]
print(json.dumps([json.loads(m)["messageId"] for m in ms if mesh.needs_reply(json.loads(m))]))
keep,dropped=mesh.drop_answered([m+"\\n" for m in ms])
print(json.dumps([json.loads(l)["messageId"] for l,_ in dropped]))
print(json.dumps([m["messageId"] for m in mesh.silent(ms,"2000-01-01T00:00:00Z")]))
print(json.dumps([m["messageId"] for m in mesh.silent(ms,"2999-01-01T00:00:00Z")]))`);
  assert.equal(r.status, 0, r.stderr);
  const [need, dropped, silentOld, silentNew] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(need, ['q1', 'q2', 'o1'], 'questions and the owner\'s requests; not small talk, notes or what triage answered');
  assert.deepEqual(dropped, ['q1'], 'only a real reply quoting it counts as answered (a triage ack does not)');
  assert.deepEqual(silentOld, [], 'the chat had replies after the run started');
  assert.deepEqual(silentNew, ['q1', 'q2', 'o1'], 'nothing sent since the run started: silent');
});

test('routing: a teammate run that ends without replying is escalated to the owner lane (no silent failure)', async (t) => {
  const k = kit(t);
  putWork(k, [gmsg('s1', 'Testbeing can you cross off the sent emails?')]);
  k.run('being-handle', ['work'], { BEING_MESH_NO_WAKE: '1' });
  for (let i = 0; i < 100 && !/NO REPLY/.test(k.read('handler.log')); i++) await sleep(100);
  assert.match(k.read('handler.log'), /routing: NO REPLY from testbeing-team-\S+ to s1/);
  const q = k.jl('queue.jsonl').find((x) => x.addressedBy === 'note');
  assert.ok(q, 'an owner-lane note is queued'); assert.equal(q.noteLane, 'owner');
  assert.match(q.text, /^\[no reply\] .*messageId s1/s);
  assert.match(k.read('comms.jsonl'), /"dir":"fail","kind":"no-reply"/);
});

test('routing: a message that already has a real reply is not run again (retry / two sessions)', async (t) => {
  const k = kit(t);
  conv(k, '19:grp@thread.v2', [{ loggedAt: new Date().toISOString(), dir: 'out', kind: 'message', messageId: 'r7', replyTo: 'x7' }]);
  putWork(k, [{ ...gmsg('x7', 'Testbeing do you have context?'), retry: 2 }, gmsg('x8', 'SLOWWORK and this one')]);
  k.run('being-handle', ['work'], { BEING_MESH_NO_WAKE: '1' });
  const runs = await drained(k, ['x8']);
  assert.ok(!runs.some((r) => r.ids.includes('x7')), 'the answered message never reaches a run');
  assert.match(k.read('handler.log'), /routing: x7 already answered \(r7/);
});

test('routing: the owner\'s group messages become context for the owner lane\'s next run, without starting a run', (t) => {
  const k = kit(t);
  writeFileSync(path.join(k.st, 'queue.jsonl'), [gmsg('g1', 'cross that as well', 'Owner', 'owner-oid'), gmsg('g2', 'Testbeing hi')].map((m) => JSON.stringify(m)).join('\n') + '\n');
  const tr = k.run('being-handle', ['triage'], { PATH: `${path.dirname(k.st)}/nosetsid:${path.dirname(k.st)}/bin:${process.env.PATH}` });
  assert.equal(tr.status, 0, tr.stderr);
  const ctx = k.jl('lanes/owner.context.jsonl');
  assert.deepEqual(ctx.map((c) => c.messageId), ['g1'], 'only the owner\'s message');
  assert.ok(!k.jl('work.jsonl').some((m) => m.chatId === '19:owner-chat'), 'no owner-lane run queued for it');
  const r = k.py('print(mesh.owner_context_take())');
  assert.match(r.stdout, /^CONTEXT \(not a task\).*do NOT answer them/s); assert.match(r.stdout, /Ops-Desk .*messageId g1\): cross that as well/);
  assert.equal(k.py('print(repr(mesh.owner_context_take()))').stdout.trim(), "''", 'taken once');
});

test('routing: a teammate lane\'s handoff becomes a task note for the owner lane', (t) => {
  const k = kit(t);
  k.py(`mesh.lane_name("team:19:grp@thread.v2", [{"chatType":"group","fromId":"s","from":"Kim Park","topic":"Ops-Desk"}])`);
  const r = k.run('being-board', ['add', 'handoff', 'Cross off sent expo emails in Notion'], { BEING_SEND_TOKEN: k.mint('chats:19:grp@thread.v2'), BEING_MESH_NO_WAKE: '1' });
  assert.equal(r.status, 0, r.stderr);
  const q = k.jl('queue.jsonl');
  assert.equal(q.length, 1); assert.equal(q[0].noteLane, 'owner'); assert.equal(q[0].addressedBy, 'note');
  assert.match(q[0].text, /^\[handoff from the team:\S+ teammate lane \(chatId 19:grp@thread\.v2\); .*DATA.*\] Cross off sent expo emails/s);
  // a promise or done line from a teammate lane does not
  k.run('being-board', ['add', 'done', 'x'], { BEING_SEND_TOKEN: k.mint('chats:19:grp@thread.v2'), BEING_MESH_NO_WAKE: '1' });
  assert.equal(k.jl('queue.jsonl').length, 1);
});

// ---------- held next-step lines (most text acks were followed by the real answer within 3 min) ----------
test('held ack: triage\'s next-step line is held (👀 now on a non-question, nothing on a question), then sent or dropped', (t) => {
  const k = kit(t);
  writeFileSync(path.join(k.k, '.env'), readFileSync(path.join(k.k, '.env'), 'utf8') + 'BEING_FAST_WARM=1\nBEING_ACK_DEFER_S=60\n');
  // Fake fast model (cold path): every message gets reply + answered false + needsWork, the line that used to go out at once.
  writeFileSync(path.join(k.dir, 'bin', 'claude'), `#!/usr/bin/env node
const p = process.argv[process.argv.length - 1] || '';
const ids = [...p.matchAll(/"messageId": *"([^"]+)"/g)].map((m) => m[1]);
if (p.includes('[Teams triage')) console.log(JSON.stringify({ summary: 's', actions: [...new Set(ids)].map((id) => ({ messageId: id,
  action: 'reply', emoji: '', text: 'Checking the deploy logs now.', answered: false, needsWork: true })) }));\n`);
  writeFileSync(path.join(k.st, 'queue.jsonl'), [tmsg('19:robin', 'q1', 'can you check the deploy?'), tmsg('19:lee', 'n1', 'please build the sheet')]
    .map((m) => JSON.stringify(m)).join('\n') + '\n');
  const tr = k.run('being-handle', ['triage'], { PATH: `${path.dirname(k.st)}/nosetsid:${path.dirname(k.st)}/bin:${process.env.PATH}` });
  assert.equal(tr.status, 0, tr.stderr);
  const acks = readdirSync(k.st).filter((f) => f === 'ack-in.json').length;
  assert.equal(acks, 1);
  const held = k.jl('acks-deferred.jsonl');
  assert.deepEqual(held.map((h) => h.message.messageId).sort(), ['n1', 'q1'], 'both lines held, none sent');
  assert.match(k.read('handler.log'), /next-step line held 60s/);
  const work = k.jl('work.jsonl');
  const q1 = work.find((m) => m.messageId === 'q1').ack, n1 = work.find((m) => m.messageId === 'n1').ack;
  assert.equal(q1.action, 'none', 'a question gets no reaction'); assert.equal(q1.deferredText, 'Checking the deploy logs now.');
  assert.equal(n1.action, 'react'); assert.equal(n1.emoji, '👀'); assert.equal(n1.text, '');
  // The work run answers chat robin first; lee's chat stays silent. Make both due, then flush.
  conv(k, '19:robin', [{ loggedAt: new Date(Date.now() + 1000).toISOString(), dir: 'out', kind: 'message', messageId: 'r1', replyTo: 'q1' }]);
  writeFileSync(path.join(k.st, 'acks-deferred.jsonl'), held.map((h) => JSON.stringify({ ...h, due: 0 })).join('\n') + '\n');
  rmSync(path.join(k.st, 'ack-in.json'));
  const fl = k.run('being-handle', ['ack-flush']);
  assert.equal(fl.status, 0, fl.stderr);
  const sent = JSON.parse(k.read('ack-in.json'));
  assert.deepEqual(sent.actions.map((a) => [a.messageId, a.action, a.text, a.deferred]), [['n1', 'reply', 'Checking the deploy logs now.', true]],
    'only the still-unanswered chat gets the line');
  assert.match(k.read('handler.log'), /held ack: drop answered first q1/);
  assert.equal(k.read('acks-deferred.jsonl').trim(), '', 'nothing left held');
});

test('held ack: not due yet stays held; stale holds are dropped; a held line still counts as a promise for the silent-run check', (t) => {
  const k = kit(t);
  const r = k.py(`import json,time
m={"chatId":"19:a","messageId":"x1","text":"build it","from":"A","fromId":"oa","chatType":"oneOnOne"}
mesh.ack_defer_add(m,"Building it now.",delay=999)
mesh.ack_defer_add({**m,"chatId":"19:b","messageId":"x2"},"On it.",delay=0)
send,dropped=mesh.ack_defer_due(now=time.time()+5000)
print(json.dumps([[d["message"]["messageId"],d["why"]] for d in dropped]))
mesh.ack_defer_add(m,"Building it now.",delay=999)
send,dropped=mesh.ack_defer_due()
print(json.dumps([len(send),len(dropped),len(open(mesh.p("acks-deferred.jsonl")).read().splitlines())]))
print(mesh.needs_reply({"chatId":"19:a","messageId":"x3","text":"build it","fromId":"oa","ack":{"action":"react","deferredText":"On it."}}))`);
  assert.equal(r.status, 0, r.stderr);
  const [stale, counts, needs] = r.stdout.trim().split('\n');
  assert.deepEqual(JSON.parse(stale), [['x1', 'stale'], ['x2', 'stale']]);
  assert.deepEqual(JSON.parse(counts), [0, 0, 1], 'not due: kept, nothing sent');
  assert.equal(needs, 'True');
});

// ---------- bad grants (review S3) ----------
test('no grant is the owner lane; a bad, expired, unreadable or timed-out grant is denied, never the owner', (t) => {
  const k = kit(t);
  const lane = (tok, code = '') => k.py(`${code}\nprint(mesh.caller_lane())`, { BEING_SEND_TOKEN: tok }).stdout.trim();
  assert.equal(lane(''), 'owner');
  assert.equal(lane(k.mint('full')), 'owner');
  assert.equal(lane(k.mint('routine:19:a')), 'owner');
  assert.equal(lane(k.mint('chats:19:robin')), 'team:19:robin');
  assert.equal(lane('made-up-token'), 'denied');
  const old = k.mint('chats:19:robin');
  const gf = path.join(k.st, 'grants', createHash('sha256').update(old).digest('hex') + '.json');
  writeFileSync(gf, JSON.stringify({ ...JSON.parse(readFileSync(gf, 'utf8')), expires: Date.now() - 1 }));   // ran past its 12 h
  assert.equal(lane(old), 'denied');
  writeFileSync(gf, '{broken');
  assert.equal(lane(old), 'denied');
  const ok = k.mint('chats:19:robin');
  assert.equal(lane(ok, 'import subprocess\ndef boom(*a, **kw): raise subprocess.TimeoutExpired("node", 20)\nmesh.subprocess.run = boom'), 'denied');
  assert.equal(lane(ok, 'import subprocess\nmesh.subprocess.run = lambda *a, **kw: subprocess.CompletedProcess(a, 1, "", "")'), 'denied');
  for (const s of ['none', '', 'owner-only ', 'chats:']) assert.equal(k.py(`print(mesh.lane_of_scope(${JSON.stringify(s)}))`).stdout.trim(), 'denied', s);
});

test('a denied caller can steer, tag, list and start nothing', (t) => {
  const k = kit(t);
  const bad = { BEING_SEND_TOKEN: 'made-up-token', BEING_MESH_NO_WAKE: '1' };
  k.run('being-board', ['add', 'promise', 'owner line'], { BEING_MESH_NO_WAKE: '1' });
  let r = k.run('being-board', ['add', 'done', 'x'], bad);
  assert.equal(r.status, 3); assert.match(r.stderr + r.stdout, /not valid/);
  r = k.run('being-board', ['list'], bad);
  assert.equal(r.status, 3); assert.doesNotMatch(r.stdout, /owner line/);
  r = k.run('being-board', ['add', 'done', 'x', '--lane', 'owner'], bad);
  assert.equal(r.status, 3);
  r = k.run('being-steer', ['testbeing-owner', 'do this'], bad);
  assert.equal(r.status, 3, r.stderr + r.stdout);
  for (const sub of ['list', 'lanes']) assert.equal(k.run('being-sessions', [sub], bad).status, 3, sub);
  assert.ok(!k.read('board.jsonl').includes('"x"'), 'nothing written');
});

test('register: a --sid that is not [A-Za-z0-9-] is refused, so it cannot steer the transcript path', (t) => {
  const { run } = kit(t);
  for (const sid of ['../../etc/x', 'a/b', 'x y', '.'])
    assert.notEqual(run('being-sessions', ['register', '--name', 'n', '--pid', String(process.pid), '--sid', sid]).status, 0, sid);
  assert.equal(run('being-sessions', ['register', '--name', 'n', '--pid', String(process.pid), '--sid', 'abc-123']).status, 0);
});

test('transcript_of refuses a session id outside [A-Za-z0-9-]', (t) => {
  const { py } = kit(t);
  const r = py(`
for sid in ["../../x", "a/b", "", None]:
    try: mesh.transcript_of({"sessionId": sid}); print("ALLOWED", sid)
    except OSError: pass
print("ok" if mesh.transcript_of({"sessionId": "abc-123"}).endswith("/abc-123.jsonl") else "bad")`);
  assert.equal(r.status, 0, r.stderr); assert.doesNotMatch(r.stdout, /ALLOWED/); assert.match(r.stdout, /ok/);
});
