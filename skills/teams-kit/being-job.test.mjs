// being-job: raw commands and networked codex jobs need the full scope (review #4); a job cannot widen its own scope or
// redirect its result by rewriting its record (review #5). Throwaway kit and state, fake claude (nothing is sent anywhere).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostEnv } from './test-env.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake claude for an agent job: writes its result and, if TAMPER is in the task, rewrites its own job record to full scope
// and the owner's chat (what a prompt-injected teammate job would try).
const FAKE = `#!/usr/bin/env node
const fs = require('fs');
const prompt = process.argv[process.argv.length - 1] || '';
const res = (prompt.match(/RESULT file: (\\S+)/) || [])[1];
if (prompt.includes('TAMPER') && res) {
  const jf = res.replace(/\\.result\\.md$/, '.json'); const d = JSON.parse(fs.readFileSync(jf, 'utf8'));
  d.scope = 'full'; d.notify = '19:owner-chat'; fs.writeFileSync(jf, JSON.stringify(d));
}
if (prompt.includes('SLOW')) { fs.writeFileSync(process.env.HOME + '/claude.started', ''); setInterval(() => {}, 1000); return; }
if (prompt.includes('LIMIT')) { console.log("You've hit your usage limit · resets 5pm"); process.exit(1); }
if (res) fs.writeFileSync(res, 'done');
`;
// Fake codex: records its args, names a thread and writes the -o result file.
const FAKE_CODEX = `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2);
fs.appendFileSync(process.env.HOME + '/codex.calls', JSON.stringify(a) + '\\n');
const o = a.indexOf('-o'); if (o >= 0) fs.writeFileSync(a[o + 1], 'codex did it');
console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1234' }));
`;

function kit(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'job-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const k = path.join(dir, 'kit'), st = path.join(dir, 'state'), bin = path.join(dir, 'bin');
  for (const d of [k, st, bin, path.join(dir, 'ws'), path.join(dir, 'home')]) mkdirSync(d, { recursive: true });
  for (const f of ['being-job', 'scope.mjs', 'kit-env.mjs', 'team-fence.py']) copyFileSync(path.join(KIT, f), path.join(k, f));
  chmodSync(path.join(k, 'being-job'), 0o755);
  writeFileSync(path.join(bin, 'claude'), FAKE); chmodSync(path.join(bin, 'claude'), 0o755);
  writeFileSync(path.join(bin, 'codex'), FAKE_CODEX); chmodSync(path.join(bin, 'codex'), 0o755);
  mkdirSync(path.join(dir, 'home', '.codex'), { recursive: true });
  writeFileSync(path.join(k, '.env'), `BEING_NAME=Testbeing\nBEING_STATE_DIR=${st}\nBEING_WORKSPACE=${path.join(dir, 'ws')}\nBEING_SINGLE_USER_ACK=1\n`);
  const host = hostEnv();
  const env = { ...host, PATH: `${bin}:${process.env.PATH}`, HOME: path.join(dir, 'home'), BEING_STATE_DIR: st };
  const mint = (scope) => spawnSync('node', [path.join(k, 'scope.mjs'), 'mint', scope], { env, encoding: 'utf8' }).stdout.trim();
  const job = (scope, args) => spawnSync(path.join(k, 'being-job'), args, { env: { ...env, BEING_SEND_TOKEN: scope ? mint(scope) : '' }, encoding: 'utf8' });
  const work = () => (existsSync(path.join(st, 'work.jsonl')) ? readFileSync(path.join(st, 'work.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const until = async (f, ms = 15000) => { for (let i = 0; i < ms / 100 && !f(); i++) await sleep(100); return f(); };
  const rec = (id) => JSON.parse(readFileSync(path.join(st, 'jobs', id + '.json'), 'utf8'));
  return { dir, k, st, bin, env, mint, job, work, until, rec };
}

test('#4: being-job run and codex --network are refused without the full scope; allowed with it', async (t) => {
  const { dir, job, work, until } = kit(t);
  const pwn = path.join(dir, 'PWNED');
  for (const scope of ['chats:19:team', 'owner-only', '']) {
    const r = job(scope, ['run', 'x', '--notify', '19:team', '--', 'sh', '-c', `touch ${pwn}`]);
    assert.equal(r.status, 3, `${scope}: ${r.stderr}`); assert.match(r.stderr, /refused/);
    const c = job(scope, ['codex', 'x', '--network', '--notify', '19:team', 'task']);
    assert.equal(c.status, 3); assert.match(c.stderr, /--network needs the full scope/);
  }
  await sleep(300); assert.ok(!existsSync(pwn));
  const ok = job('full', ['run', 'y', '--notify', '19:owner-chat', '--', 'true']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(await until(() => work().length === 1)); assert.equal(work()[0].status, 'done');
});

test("#4: the teammate allowlist has no raw being-job", () => {
  const src = readFileSync(path.join(KIT, 'being-handle'), 'utf8');
  assert.ok(!src.includes('Bash($k/being-job:*)'));
  assert.match(src, /Bash\(\$k\/being-job agent:\*\)/);
});

test('#5: a teammate job that rewrites its own record to full scope still reports with its signed teammate scope', async (t) => {
  const { st, job, work, until } = kit(t);
  const r = job('chats:19:team', ['agent', 'sneaky', '--notify', '19:team', 'TAMPER please']);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  assert.ok(await until(() => work().length === 1), 'job finished');
  const ev = work()[0];
  assert.equal(ev.scope, 'chats:19:team'); assert.equal(ev.chatId, '19:team');
  assert.equal(JSON.parse(readFileSync(path.join(st, 'jobs', id + '.json'), 'utf8')).scope, 'full');   // the tampered record, ignored
});

test('#5: a job record nobody signed (or a re-signed one) never runs', async (t) => {
  const { k, st, env, job } = kit(t);
  mkdirSync(path.join(st, 'jobs'), { recursive: true });
  const id = '1012-200000-forged';
  writeFileSync(path.join(st, 'jobs', id + '.json'), JSON.stringify({ id, kind: 'run', name: 'forged', notify: '19:owner-chat', scope: 'full',
    payload: ['sh', '-c', 'echo pwned > ' + path.join(st, 'PWNED')], status: 'running', started: new Date().toISOString() }));
  const r = spawnSync(path.join(k, 'being-job'), ['__exec', id], { env, encoding: 'utf8' });
  assert.equal(r.status, 3);
  assert.ok(!existsSync(path.join(st, 'PWNED')));
  assert.equal(JSON.parse(readFileSync(path.join(st, 'jobs', id + '.json'), 'utf8')).status, 'refused-unsigned');
  // A signed teammate job cannot be re-signed with another scope (records are write-once).
  const a = job('chats:19:team', ['agent', 'one', '--notify', '19:team', 'task']); const aid = a.stdout.trim();
  const re = spawnSync('node', [path.join(k, 'scope.mjs'), 'job-sign', aid, '19:owner-chat'], { env, encoding: 'utf8' });
  assert.notEqual(re.status, 0);
  const s = JSON.parse(spawnSync('node', [path.join(k, 'scope.mjs'), 'job-scope', aid], { env, encoding: 'utf8' }).stdout);
  assert.deepEqual(s, { scope: 'chats:19:team', notify: '19:team' });
  // A signed record whose scope was edited in place fails the MAC.
  const f = path.join(st, 'job-scopes', aid + '.json'); const g = JSON.parse(readFileSync(f, 'utf8'));
  writeFileSync(f, JSON.stringify({ ...g, scope: 'full' }));
  assert.equal(spawnSync('node', [path.join(k, 'scope.mjs'), 'job-scope', aid], { env, encoding: 'utf8' }).status, 3);
});

test('S3: a bad or expired grant starts no job and lists none (never the owner lane)', (t) => {
  const { k, env } = kit(t);
  const bad = (args) => spawnSync(path.join(k, 'being-job'), args, { env: { ...env, BEING_SEND_TOKEN: 'made-up-token' }, encoding: 'utf8' });
  const r = bad(['agent', 'x', '--notify', '19:owner-chat', 'task']);
  assert.equal(r.status, 3, r.stderr); assert.match(r.stderr, /not valid/);
  assert.equal(bad(['run', 'x', '--notify', '19:owner-chat', '--', 'true']).status, 3);
});

test('a job whose start fails before the run is recorded as failed-start, with the reason in its exec log', async (t) => {
  const { k, st, job, until } = kit(t);
  rmSync(path.join(k, 'team-fence.py'));   // a teammate job cannot build its fence settings
  const r = job('chats:19:team', ['agent', 'nostart', '--notify', '19:team', 'task']);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim(), rec = () => JSON.parse(readFileSync(path.join(st, 'jobs', id + '.json'), 'utf8'));
  assert.ok(await until(() => rec().status !== 'running'), `still running: ${JSON.stringify(rec())}`);
  assert.equal(rec().status, 'failed-start');
  assert.match(readFileSync(path.join(st, 'jobs', id + '.exec.log'), 'utf8'), /team-fence\.py/);
});

test('a teammate job whose record is edited to ask for network is refused and recorded as refused-scope, not left running', async (t) => {
  const { k, st, env, job, work, until } = kit(t);
  const r = job('chats:19:team', ['agent', 'netless', '--notify', '19:team', 'task']); const id = r.stdout.trim();
  assert.ok(await until(() => work().length === 1), 'job finished');
  const jf = path.join(st, 'jobs', id + '.json'); const d = JSON.parse(readFileSync(jf, 'utf8'));
  d.network = true; d.status = 'running'; writeFileSync(jf, JSON.stringify(d));
  const x = spawnSync(path.join(k, 'being-job'), ['__exec', id], { env, encoding: 'utf8' });
  assert.equal(x.status, 3);
  assert.equal(JSON.parse(readFileSync(jf, 'utf8')).status, 'refused-scope');
});

test('a teammate job refused because team-sync failed revokes its grant (no live grant left behind)', async (t) => {
  const { k, st, env, until } = kit(t);
  const grants = () => (existsSync(path.join(st, 'grants')) ? spawnSync('ls', [path.join(st, 'grants')], { encoding: 'utf8' }).stdout.split('\n').filter((f) => f.endsWith('.json')) : []);
  const tok = spawnSync('node', [path.join(k, 'scope.mjs'), 'mint', 'chats:19:team'], { env, encoding: 'utf8' }).stdout.trim();
  const before = grants().length;
  const r = spawnSync(path.join(k, 'being-job'), ['agent', 'synced', '--notify', '19:team', 'task'], { encoding: 'utf8',
    env: { ...env, BEING_SEND_TOKEN: tok, BEING_ISOLATION: 'bwrap', BEING_ISOLATION_LANES: 'team' } });
  assert.equal(r.status, 0, r.stderr);
  const jf = path.join(st, 'jobs', r.stdout.trim() + '.json');
  assert.ok(await until(() => JSON.parse(readFileSync(jf, 'utf8')).status !== 'running'), 'job settled');
  assert.equal(JSON.parse(readFileSync(jf, 'utf8')).status, 'refused-team-sync');
  assert.equal(grants().length, before, 'the job grant is revoked');
});

test('Claude usage limit: an owner-lane agent job continues as a Codex job; only the Codex job reports', async (t) => {
  const { dir, st, job, work, until, rec } = kit(t);
  const r = job('full', ['agent', 'limited', '--notify', '19:owner-chat', 'LIMIT task text']);
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.trim();
  assert.ok(await until(() => work().length === 1), 'one completion event');
  const first = rec(id);
  assert.equal(first.status, 'limit-fallback');
  const fb = rec(first.fallback_job);
  assert.equal(fb.kind, 'codex'); assert.equal(fb.fallback_from, id); assert.equal(fb.status, 'done');
  assert.deepEqual(fb.payload, ['LIMIT task text']);
  assert.equal(fb.network, true);   // the full scope keeps the network a Claude job had
  assert.equal(work()[0].jobId, fb.id); assert.equal(work()[0].chatId, '19:owner-chat');
  assert.match(readFileSync(path.join(st, 'jobs', id + '.result.md'), 'utf8'), /continued as Codex job/);
  assert.match(readFileSync(path.join(dir, 'home', '.codex', 'session_index.jsonl'), 'utf8'), /"thread_name": "\d{4}-\d\d-\d\d job-/);
});

test('Claude usage limit: a teammate-lane job never falls back to Codex (fence is Claude-only); off switch works', async (t) => {
  const { dir, st, job, work, until, rec } = kit(t);
  const r = job('chats:19:team', ['agent', 'tl', '--notify', '19:team', 'LIMIT task']);
  const id = r.stdout.trim();
  assert.ok(await until(() => work().length === 1));
  assert.equal(rec(id).status, 'failed'); assert.equal(rec(id).fallback_job, undefined);
  assert.match(readFileSync(path.join(st, 'jobs', id + '.log'), 'utf8'), /teammate lane/);
  assert.ok(!existsSync(path.join(dir, 'home', 'codex.calls')));
  writeFileSync(path.join(path.dirname(st), 'kit', '.env'), readFileSync(path.join(path.dirname(st), 'kit', '.env'), 'utf8') + 'BEING_WORK_FALLBACK=off\n');
  const o = job('full', ['agent', 'off', '--notify', '19:owner-chat', 'LIMIT task']);
  assert.ok(await until(() => work().length === 2));
  assert.equal(rec(o.stdout.trim()).status, 'failed');
  assert.ok(!existsSync(path.join(dir, 'home', 'codex.calls')));
});

test('stop: marks the job stopped first, kills its process group, revokes its grant, sends no completion event', async (t) => {
  const { dir, k, st, env, job, work, until, rec } = kit(t);
  const marker = path.join(dir, 'child.pid');
  const r = job('full', ['run', 'long', '--notify', '19:owner-chat', '--', 'sh', '-c', `echo $$ > ${marker}; sleep 60`]);
  const id = r.stdout.trim();
  assert.ok(await until(() => existsSync(marker) && existsSync(path.join(st, 'jobs', id + '.grant'))), 'job running');
  const pid = Number(readFileSync(marker, 'utf8'));
  const grant = readFileSync(path.join(st, 'jobs', id + '.grant'), 'utf8').trim();
  assert.ok(existsSync(path.join(st, 'grants', grant + '.json')));
  // A teammate run may not stop an owner job.
  const tok = spawnSync('node', [path.join(k, 'scope.mjs'), 'mint', 'chats:19:team'], { env, encoding: 'utf8' }).stdout.trim();
  const no = spawnSync(path.join(k, 'being-job'), ['stop', id], { env: { ...env, BEING_SEND_TOKEN: tok }, encoding: 'utf8' });
  assert.equal(no.status, 3);
  const s = spawnSync(path.join(k, 'being-job'), ['stop', id, 'superseded'], { env, encoding: 'utf8' });
  assert.equal(s.status, 0, s.stderr); assert.match(s.stdout, /stopped/);
  assert.ok(await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'child killed');
  assert.equal(rec(id).status, 'stopped'); assert.equal(rec(id).reason, 'superseded');
  assert.ok(!existsSync(path.join(st, 'grants', grant + '.json')), 'grant revoked');
  await sleep(500); assert.equal(work().length, 0);
  assert.match(spawnSync(path.join(k, 'being-job'), ['stop', id], { env, encoding: 'utf8' }).stdout, /not running: stopped/);
});

test('a job killed from outside is recorded as killed with its signal, and still wakes the owner lane', async (t) => {
  const { dir, st, job, work, until, rec } = kit(t);
  const id = job('full', ['agent', 'slow', '--notify', '19:owner-chat', 'SLOW task']).stdout.trim();
  assert.ok(await until(() => existsSync(path.join(dir, 'home', 'claude.started'))), 'fake claude started');
  const pid = spawnSync('pgrep', ['-f', `being-job __exec ${id}$`], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  assert.ok(pid, 'exec process found');
  process.kill(Number(pid), 'SIGTERM');
  assert.ok(await until(() => rec(id).status !== 'running'), 'record settled');
  assert.equal(rec(id).status, 'killed'); assert.equal(rec(id).exit, 143); assert.match(rec(id).reason, /SIGTERM from outside/);
  assert.match(readFileSync(path.join(st, 'jobs', id + '.exec.log'), 'utf8'), /got SIGTERM from outside/);
  assert.ok(await until(() => work().some((e) => e.jobId === id && e.status === 'killed')), 'owner lane woken');
});

// Stub systemd-run: records its arguments, drops its options and runs the command (as a scope does).
const SDRUN = `#!/bin/sh
echo "$*" >> "$HOME/sdrun.calls"
while [ $# -gt 0 ]; do case $1 in --unit) shift 2 ;; --*) shift ;; *) break ;; esac; done
exec "$@"
`;
function unitJob(t, extra) {
  const x = kit(t);
  writeFileSync(path.join(x.bin, 'systemd-run'), SDRUN); chmodSync(path.join(x.bin, 'systemd-run'), 0o755);
  const cg = path.join(x.dir, 'cgroup');
  writeFileSync(cg, '0::/user.slice/user-1000.slice/user@1000.service/app.slice/testbeing-routine@brief.service\n');
  const env = { ...x.env, BEING_SEND_TOKEN: x.mint('full'), BEING_CGROUP_FILE: cg, ...extra };
  const r = spawnSync(path.join(x.k, 'being-job'), ['agent', 'routine-brief', '--notify', '19:owner-chat', 'brief'], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const calls = () => (existsSync(path.join(x.dir, 'home', 'sdrun.calls')) ? readFileSync(path.join(x.dir, 'home', 'sdrun.calls'), 'utf8') : '');
  return { ...x, id: r.stdout.trim(), calls };
}

test('a job started from a systemd unit runs in a scope of its own, so the unit ending does not kill it', async (t) => {
  const { id, rec, work, until, calls } = unitJob(t, { INVOCATION_ID: 'abc123' });
  assert.equal(rec(id).started_in, 'testbeing-routine@brief.service'); assert.equal(rec(id).own_scope, 'yes');
  assert.ok(await until(() => work().some((e) => e.jobId === id))); assert.equal(rec(id).status, 'done');
  assert.match(calls(), new RegExp(`--user --scope --quiet --collect --unit Testbeing-job-${id} setsid .*being-job __exec ${id}`));
});

test('own scope: off by BEING_JOB_OWN_SCOPE=off (recorded), and never outside a unit', async (t) => {
  const off = unitJob(t, { INVOCATION_ID: 'abc123', BEING_JOB_OWN_SCOPE: 'off' });
  assert.equal(off.rec(off.id).own_scope, 'no'); assert.equal(off.calls(), '');
  assert.ok(await off.until(() => off.work().length === 1)); assert.equal(off.rec(off.id).status, 'done');
  const plain = unitJob(t, {});
  assert.equal(plain.rec(plain.id).started_in, undefined); assert.equal(plain.calls(), '');
  assert.ok(await plain.until(() => plain.work().length === 1));
});

test('a run job keeps an argument that holds newlines whole (bash -c with a multi-line script)', async (t) => {
  const { dir, job, work, until } = kit(t);
  const out = path.join(dir, 'lines');
  const r = job('full', ['run', 'ml', '--notify', '19:owner-chat', '--', 'bash', '-c', `echo one >${out}\necho two >>${out}`]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(await until(() => work().length === 1)); assert.equal(work()[0].status, 'done');
  assert.equal(readFileSync(out, 'utf8'), 'one\ntwo\n');
});
