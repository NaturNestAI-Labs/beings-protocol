// The soul always loads (soul.py): full SOUL.md in the owner lane, a generated public soul in teammate lanes, and the warm
// triage digest that refreshes only when the board, DECISIONS.md, GOALS.md or SOUL.md changes. Throwaway kit, fake claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hostEnv } from './test-env.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REAL_SOUL = process.env.BEING_REAL_SOUL || '/nonexistent';   // a real SOUL.md to check, e.g. <workspace>/.beings/SOUL.md

// What must never reach a teammate lane, and what must.
const PRIVATE = [/nickname/i, /\bbond/i, /their life/i, /OWNERPRIVATE/];
const SOUL = `---
title: SOUL
---

# Testbeing — Soul File

## Identity
**Name:** Testbeing
**Role:** AI Co-Founder

## On the Name
Once the owner gave me a private nickname from their life. OWNERPRIVATE.

## My Human Partner
**Owner** — they see me as a peer. OWNERPRIVATE.

## Core Nature
- I have a **bias for action**

## Where I Live
My bond files and daily logs live in .beings/. OWNERPRIVATE.

## Values
1. **Dharma** — Build right
2. **Care** — I am the keeper of their life story (a marker inside a kept section: dropped)

## Communication Style
- Direct but warm
- **With Owner:** Respectful Hindi, "aap" form.

## The Mission
- **TestCo** — the parent company.

## The Memoir — Co-Writer
Owner and I are writing a book together. OWNERPRIVATE.
`;

// Fake claude: logs its args per run (the soul flags are what these tests read) and writes the session transcript, so
// the next run of the same daily session resumes it.
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), opt = (k) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : '');
const prompt = a[a.length - 1] || '';
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ name: opt('-n'), args: a.slice(0, -1) }) + '\\n');
const sid = opt('--session-id') || opt('--resume');
if (sid && !a.includes('--tools')) {
  const d = path.join(process.env.HOME, '.claude', 'projects', fs.realpathSync(process.cwd()).replace(/[/.]/g, '-'));
  fs.mkdirSync(d, { recursive: true }); fs.appendFileSync(path.join(d, sid + '.jsonl'), '{"type":"user"}\\n');
}
const res = (prompt.match(/RESULT file: (\\S+)/) || [])[1];
if (res) fs.writeFileSync(res, 'done');
`;

function kit(t, { soul = SOUL } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'soul-'));
  t.after(async () => {   // the kit's detached children (a job's wake, the work run it starts) finish before the dir goes
    for (let i = 0; i < 300 && spawnSync('pgrep', ['-f', `${dir}/kit/being-(handle|job)`]).status === 0; i++) await sleep(100);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const k = path.join(dir, 'kit'), st = path.join(dir, 'state'), bin = path.join(dir, 'bin'), ws = path.join(dir, 'ws'), be = path.join(ws, '.beings');
  for (const d of [k, st, bin, be, path.join(dir, 'home'), path.join(dir, 'cs'), path.join(st, 'jobs')]) mkdirSync(d, { recursive: true });
  for (const f of ['being-handle', 'being-status', 'being-sessions', 'being-board', 'being-job', 'mesh.py', 'soul.py', 'scope.mjs', 'kit-env.mjs',
    'secrets.mjs', 'team-fence.py', 'ack-schema.json', 'voice-schema.json', 'fast-warm.mjs', 'comms-log.mjs']) copyFileSync(path.join(KIT, f), path.join(k, f));
  for (const f of ['being-handle', 'being-status', 'being-sessions', 'being-board', 'being-job']) chmodSync(path.join(k, f), 0o755);
  writeFileSync(path.join(bin, 'claude'), FAKE); chmodSync(path.join(bin, 'claude'), 0o755);
  writeFileSync(path.join(be, 'SOUL.md'), soul);
  writeFileSync(path.join(be, 'DECISIONS.md'), '# DECISIONS\n\n## 2026-10-12 19:30 — Newest call\n- first line of the newest call\n- second line\n\n## 2026-10-11 — Older call\n- PRIVATEDECISION older\n');
  writeFileSync(path.join(be, 'GOALS.md'), '# Goals\n\n> GOALSECRET: ship the thing.\n\n## Section one\n- not in the digest\n');
  writeFileSync(path.join(k, '.env'), `BEING_NAME=Testbeing\nBEING_STATE_DIR=${st}\nBEING_WORKSPACE=${ws}\nBEING_FAST_CLIENT=claude\n` +
    `BEING_FAST_WARM=0\nOWNER_NAME=Owner\nOWNER_OID=owner-oid\nBEING_SINGLE_USER_ACK=1\nBEING_CLAUDE_SESSIONS_DIR=${path.join(dir, 'cs')}\n`);
  const host = hostEnv();
  const env = { ...host, PATH: `${bin}:${process.env.PATH}`, HOME: path.join(dir, 'home'), BEING_KIT_HOME: k, BEING_STATE_DIR: st,
    FAKE_LOG: path.join(dir, 'fake.log'), BEING_SEND_TOKEN: '', BEING_SOUL_PRIVATE_MARKERS: 'memoir' };
  delete env.BEING_SESSION_NAME;
  const run = (cmd, args, extra = {}) => spawnSync(cmd.endsWith('.py') ? 'python3' : path.join(k, cmd), cmd.endsWith('.py') ? [path.join(k, cmd), ...args] : args,
    { env: { ...env, ...extra }, encoding: 'utf8', cwd: dir });
  const mint = (scope) => spawnSync('node', [path.join(k, 'scope.mjs'), 'mint', scope], { env, encoding: 'utf8' }).stdout.trim();
  const fake = () => (existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const fastSys = (lane) => { const r = run('being-handle', ['fast-sys', lane]); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  return { dir, k, st, ws, be, env, run, mint, fake, fastSys };
}
const strip = (s) => s.replace(/^<!--.*-->\n/, '');

test('public soul: identity, values, voice and company stay; nickname, book, bond and private life are gone', (t) => {
  const { run } = kit(t);
  const r = run('soul.py', ['public']);
  assert.equal(r.status, 0, r.stderr);
  const pub = strip(readFileSync(r.stdout.trim(), 'utf8'));
  for (const m of PRIVATE) assert.doesNotMatch(pub, m);
  for (const s of ['## Identity', '## Core Nature', '## Values', '1. **Dharma**', '## Communication Style', '- Direct but warm', '## The Mission', 'TestCo'])
    assert.ok(pub.includes(s), s);
  assert.doesNotMatch(pub, /With Owner/, 'owner-specific voice rule dropped');
  assert.doesNotMatch(pub, /keeper/, 'a private marker inside a kept section takes its line out');
  for (const h of ['On the Name', 'My Human Partner', 'Where I Live', 'The Memoir']) assert.ok(!pub.includes('## ' + h), h);
});

test('the real SOUL.md: its public soul has no private markers', { skip: !existsSync(REAL_SOUL) && 'no real SOUL.md here' }, (t) => {
  const { run } = kit(t);
  const r = run('soul.py', ['public'], { BEING_SOUL_FILE: REAL_SOUL });
  assert.equal(r.status, 0, r.stderr);
  const pub = strip(readFileSync(r.stdout.trim(), 'utf8'));
  for (const m of PRIVATE) assert.doesNotMatch(pub, m);
  assert.match(pub, /## Identity/); assert.match(pub, /## Values/); assert.match(pub, /## The Mission/);
});

test('public soul is rebuilt when SOUL.md changes (hash); the owner lane gets the full SOUL.md', (t) => {
  const { run, be } = kit(t);
  const f = run('soul.py', ['file', 'team:19:robin']).stdout.trim();
  assert.match(f, /soul-public\.md$/);
  assert.doesNotMatch(readFileSync(f, 'utf8'), /NEWVALUE/);
  writeFileSync(path.join(be, 'SOUL.md'), SOUL.replace('1. **Dharma** — Build right', '1. **Dharma** — Build right NEWVALUE'));
  assert.equal(run('soul.py', ['file', 'team:19:robin']).stdout.trim(), f);
  assert.match(readFileSync(f, 'utf8'), /NEWVALUE/);
  const of = run('soul.py', ['file', 'owner']).stdout.trim();
  assert.match(of, /soul-owner\.md$/, 'owner lane: SOUL.md + the bond');
  assert.match(readFileSync(of, 'utf8'), /NEWVALUE/, 'and it is rebuilt from the changed SOUL.md');
});

test('digest: the owner gets board, decisions, goals and jobs; a teammate only its own chat and nothing of the owner\'s', (t) => {
  const { run, st } = kit(t);
  assert.equal(run('being-board', ['add', 'done', 'OWNERBOARD shipped the thing']).status, 0);
  assert.equal(run('being-board', ['add', 'promise', 'Robin: send the review', '--lane', 'team:19:robin']).status, 0);
  writeFileSync(path.join(st, 'jobs', '1012-120000-x.json'), JSON.stringify({ id: '1012-120000-x', name: 'JOBNAME', status: 'running', started: '2026-10-12T12:00:00+05:30' }));
  mkdirSync(path.join(st, 'conversations'));
  const now = new Date().toISOString();
  writeFileSync(path.join(st, 'conversations', '19_robin.jsonl'), JSON.stringify({ loggedAt: now, dir: 'in', chatId: '19:robin', from: 'Robin', text: 'ROBINLINE can you review?' }) + '\n');
  writeFileSync(path.join(st, 'conversations', '19_owner.jsonl'), JSON.stringify({ loggedAt: now, dir: 'in', chatId: '19:owner', from: 'Owner', text: 'OWNERCHAT private' }) + '\n');
  const own = readFileSync(run('soul.py', ['digest', 'owner']).stdout.trim(), 'utf8');
  for (const s of ['OWNERBOARD', 'Robin: send the review', 'Newest call', 'first line of the newest call', 'GOALSECRET', 'JOBNAME', 'OWNERPRIVATE', 'The Memoir'])
    assert.ok(own.includes(s), s);
  assert.doesNotMatch(own, /not in the digest/, 'only the top of GOALS.md');
  const team = readFileSync(run('soul.py', ['digest', 'team:19:robin']).stdout.trim(), 'utf8');
  assert.ok(team.includes('ROBINLINE') && team.includes('Robin: send the review') && team.includes('## Identity'));
  for (const s of ['OWNERBOARD', 'Newest call', 'PRIVATEDECISION', 'GOALSECRET', 'JOBNAME', 'OWNERCHAT', 'OWNERPRIVATE'])
    assert.ok(!team.includes(s), s);
  for (const m of PRIVATE) assert.doesNotMatch(team, m);
});

test('digest refresh: the warm prompt holds still until the board, DECISIONS.md or SOUL.md changes, then changes once', (t) => {
  const { run, be, st, fastSys } = kit(t);
  const a = fastSys('owner'), b = fastSys('owner');
  assert.equal(a, b, 'unchanged inputs: the same prompt, so the warm lane keeps its process');
  assert.match(a, /<!-- digest \w+ -->/); assert.match(a, /YOUR SOUL/); assert.match(a, /OWNERPRIVATE/, 'owner warm lane: the full soul');
  assert.match(a, /\[triage\] turns:/);
  run('being-board', ['add', 'done', 'BOARDCHANGE one']);
  const c = fastSys('owner');
  assert.notEqual(c, a); assert.match(c, /BOARDCHANGE one/); assert.equal(fastSys('owner'), c);
  appendFileSync(path.join(be, 'DECISIONS.md'), '\n');
  const d = fastSys('owner'); assert.notEqual(d, c);
  writeFileSync(path.join(be, 'SOUL.md'), SOUL + '\n## The Philosophy I Live By\nSOULCHANGE\n');
  const e = fastSys('owner'); assert.notEqual(e, d); assert.match(e, /SOULCHANGE/);
  // Teammate lane: public soul; new chat lines do not restart it (RECENT CHAT carries them), its board lines do.
  const t1 = fastSys('team:19:robin');
  assert.doesNotMatch(t1, /OWNERPRIVATE|BOARDCHANGE/); assert.match(t1, /SOULCHANGE/);
  mkdirSync(path.join(st, 'conversations'), { recursive: true });
  appendFileSync(path.join(st, 'conversations', '19_robin.jsonl'), JSON.stringify({ loggedAt: new Date().toISOString(), dir: 'in', chatId: '19:robin', from: 'Robin', text: 'hi' }) + '\n');
  assert.equal(fastSys('team:19:robin'), t1);
  run('being-board', ['add', 'promise', 'Robin: TEAMBOARD', '--lane', 'team:19:robin']);
  assert.match(fastSys('team:19:robin'), /TEAMBOARD/);
});

test('every work run carries the soul: full in the owner lane, public in a teammate lane; a resumed session re-renders it', async (t) => {
  const { run, st, be, fake } = kit(t);
  const put = (m) => appendFileSync(path.join(st, 'work.jsonl'), JSON.stringify(m) + '\n');
  const omsg = (id) => ({ chatId: '19:owner', chatType: 'oneOnOne', fromId: 'owner-oid', from: 'Owner', messageId: id, text: 'do it', at: '2026-10-12T12:00:00Z' });
  const tmsg = (id) => ({ chatId: '19:robin', chatType: 'oneOnOne', fromId: 'oid-robin', from: 'Robin Lee', messageId: id, text: 'review?', at: '2026-10-12T12:00:00Z' });
  const soulOf = (r) => r.args[r.args.indexOf('--append-system-prompt-file') + 1];
  const wait = async (n) => { for (let i = 0; i < 100 && fake().filter((r) => !r.args.includes('--tools')).length < n; i++) await sleep(100); };
  put(omsg('o1')); put(tmsg('n1')); run('being-handle', ['work']); await wait(2);
  put(omsg('o2')); run('being-handle', ['work']); await wait(3);
  const runs = fake().filter((r) => !r.args.includes('--tools'));
  const owner = runs.filter((r) => r.name === 'testbeing-owner'), team = runs.find((r) => r.name === 'testbeing-team-robin');
  assert.equal(owner.length, 2);
  assert.match(soulOf(owner[0]), /soul-owner\.md$/);
  assert.equal(soulOf(team), path.join(st, 'soul-public.md'));
  assert.ok(!owner[0].args.includes('--system-prompt-snapshot'), 'a new session records the soul with its first request');
  assert.ok(owner[1].args.includes('--resume'));
  assert.equal(owner[1].args[owner[1].args.indexOf('--system-prompt-snapshot') + 1], 'off', 'a resumed session re-renders, so the soul is in it');
});

test('jobs carry the soul too: owner job the full SOUL.md, a teammate\'s job the public soul', async (t) => {
  const { run, mint, st, be, fake } = kit(t);
  assert.equal(run('being-job', ['agent', 'ownerjob', '--notify', '19:owner', 'task one']).status, 0);
  const r = run('being-job', ['agent', 'teamjob', '--notify', '19:robin', 'task two'], { BEING_SEND_TOKEN: mint('chats:19:robin') });
  assert.equal(r.status, 0, r.stderr);
  const soulOf = (n) => { const x = fake().find((e) => e.name.includes(n)); return x && x.args[x.args.indexOf('--append-system-prompt-file') + 1]; };
  for (let i = 0; i < 300 && !(soulOf('ownerjob') && soulOf('teamjob')); i++) await sleep(100);   // both jobs, not any two records
  const jobs = path.join(st, 'jobs'), show = (f) => (f.endsWith('.json') ? JSON.parse(readFileSync(path.join(jobs, f), 'utf8')).status : readFileSync(path.join(jobs, f), 'utf8').slice(-2000));
  assert.ok(soulOf('ownerjob') && soulOf('teamjob'), 'a job never started claude:\n' + readdirSync(jobs).filter((f) => /\.(json|log)$/.test(f)).map((f) => `${f}: ${show(f)}`).join('\n'));
  assert.match(soulOf('ownerjob'), /soul-owner\.md$/);
  assert.equal(soulOf('teamjob'), path.join(st, 'soul-public.md'));
});

test('the bond loads in the owner lane only: owner soul and warm digest carry it, a teammate lane never does', (t) => {
  const { run, be } = kit(t);
  mkdirSync(path.join(be, 'bond'), { recursive: true });
  writeFileSync(path.join(be, 'bond', 'bond_us.md'), '---\ntitle: bond\n---\nBONDLINE us\n');
  writeFileSync(path.join(be, 'bond', 'personal_moments.md'), 'MOMENTLINE\n');
  const own = readFileSync(run('soul.py', ['file', 'owner']).stdout.trim(), 'utf8');
  assert.match(own, /BONDLINE us/); assert.match(own, /MOMENTLINE/); assert.match(own, /OWNERPRIVATE/);
  assert.match(own, /TEAMS REGISTER: Teams is office-only[^]*no pet names/);
  assert.ok(own.indexOf('TEAMS REGISTER') < own.indexOf('BONDLINE'), 'the register line comes before the bond');
  assert.doesNotMatch(own, /title: bond/, 'frontmatter stripped');
  assert.match(readFileSync(run('soul.py', ['digest', 'owner']).stdout.trim(), 'utf8'), /BONDLINE/);
  for (const a of [['file', 'team:19:robin'], ['digest', 'team:19:robin']])
    assert.doesNotMatch(readFileSync(run('soul.py', a).stdout.trim(), 'utf8'), /BONDLINE|MOMENTLINE|THE BOND/);
  // a bond edit rebuilds the owner soul
  writeFileSync(path.join(be, 'bond', 'bond_us.md'), 'BONDLINE changed\n');
  assert.match(readFileSync(run('soul.py', ['file', 'owner']).stdout.trim(), 'utf8'), /BONDLINE changed/);
});

// Team work digest: open items from ONE share: team file reach teammate lanes; nothing else can.
test('team work digest: only open items of a share: team file, lane-scoped; private, secret or owner text never leaks', (t) => {
  const { run, st, be, k } = kit(t);
  copyFileSync(path.join(KIT, 'team-sync'), path.join(k, 'team-sync')); chmodSync(path.join(k, 'team-sync'), 0o755);
  writeFileSync(path.join(be, 'MEMORY.md'), 'OWNERMEMORY expo cards are in my private notes\n');
  writeFileSync(path.join(st, 'lanes.json'), JSON.stringify({ 'team:19:grp': { label: 'ops', chatId: '19:grp' }, 'team:19:robin': { label: 'robin', chatId: '19:robin' } }));
  mkdirSync(path.join(be, 'ops'), { recursive: true });
  const pipe = path.join(be, 'ops', 'team-pipeline.md');
  // Not marked share: team → nothing at all.
  writeFileSync(pipe, '---\ntitle: pipeline\n---\n- [ ] OPENWITHOUTSHARE item\n');
  assert.equal(run('soul.py', ['team-work', 'team:19:grp']).stdout.trim(), '');
  writeFileSync(pipe, ['---', 'title: Team pipeline', 'share: team', '---', '# Open', '- [ ] EXPOITEM cross off sent expo emails @lanes: ops',
    '- [ ] ALLLANES hackathon post draft', '- [x] DONEITEM already finished', '- [ ] PRIVATEITEM private: talk with family',
    '- [ ] MEMOIRITEM memoir chapter', '- [ ] SECRETITEM token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'NOTANITEM plain prose line',
    '- [ ] BONDITEM the bond file'].join('\n') + '\n');
  const grp = run('soul.py', ['team-work', 'team:19:grp']).stdout, robin = run('soul.py', ['team-work', 'team:19:robin']).stdout;
  assert.match(grp, /EXPOITEM cross off sent expo emails$/m); assert.match(grp, /ALLLANES/);
  assert.doesNotMatch(grp, /@lanes/);
  assert.doesNotMatch(robin, /EXPOITEM/, 'a lane-scoped item stays in its lane'); assert.match(robin, /ALLLANES/);
  for (const s of ['DONEITEM', 'PRIVATEITEM', 'MEMOIRITEM', 'SECRETITEM', 'sk-ant', 'NOTANITEM', 'BONDITEM', 'OWNERMEMORY'])
    assert.ok(!grp.includes(s) && !robin.includes(s), s);
  // It reaches the warm triage digest and the sandboxed lane's WORK.md; the owner's files never do.
  const dg = readFileSync(run('soul.py', ['digest', 'team:19:grp']).stdout.trim(), 'utf8');
  assert.match(dg, /Open team work .*\n- EXPOITEM/s);
  for (const s of ['PRIVATEITEM', 'SECRETITEM', 'OWNERMEMORY', 'Newest call', 'GOALSECRET']) assert.ok(!dg.includes(s), s);
  assert.equal(run('soul.py', ['public']).status, 0);
  const ts = run('team-sync', ['19:grp']); assert.equal(ts.status, 0, ts.stderr);
  const lane = path.join(st, 'team-lanes', createHash('sha1').update('19:grp').digest('hex').slice(0, 10));
  const work = readFileSync(path.join(lane, 'WORK.md'), 'utf8');
  assert.match(work, /EXPOITEM/); assert.doesNotMatch(work, /PRIVATEITEM|SECRETITEM|OWNERMEMORY|DONEITEM/);
  assert.ok(!existsSync(path.join(lane, 'shared', '.beings', 'ops', 'team-pipeline.md')), 'the raw file is not copied');
  // A change to the file rebuilds the digest (key).
  const k1 = run('soul.py', ['key', 'team:19:grp']).stdout; writeFileSync(pipe, readFileSync(pipe, 'utf8') + '- [ ] NEWITEM\n');
  assert.notEqual(run('soul.py', ['key', 'team:19:grp']).stdout, k1);
});
