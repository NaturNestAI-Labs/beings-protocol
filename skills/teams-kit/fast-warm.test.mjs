// Warm fast sessions (fast-warm.mjs) and the triage path through being-handle, against a fake `claude`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lane, ask, claudeArgs } from './fast-warm.mjs';

import { hostEnv } from './test-env.mjs';
const KIT = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fake claude: answers each turn (SLOW never answers, CRASH exits); triage: "status" answered directly, "react?"
// reacted to, anything else acknowledged as work. The summary says which path produced it.
const FAKE = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const decide = (p, via) => {
  if (/\\[voice/.test(p) || /Teams voice/.test(p)) return JSON.stringify({ messages: [] });
  const msgs = p.split('MESSAGES:').pop().split('\\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
  return JSON.stringify({ summary: via, actions: msgs.filter((m) => !/SKIPME/.test(m.text)).map((m) => /status/i.test(m.text) ?
    { chatId: m.chatId, messageId: m.messageId, action: 'reply', text: 'All quiet: nothing running.', answered: true, needsWork: false, emoji: '' }
    : /react\\?|REACTME/.test(m.text) ? { chatId: m.chatId, messageId: m.messageId, action: 'react', text: '', answered: false, needsWork: false, emoji: '👍' }
    : { chatId: m.chatId, messageId: m.messageId, action: 'reply', text: 'On it.', answered: false, needsWork: true, emoji: '' }) });
};
if (!argv.includes('--input-format')) { process.stdout.write(decide(argv[argv.length - 1], 'cold')); process.exit(0); }
let buf = '', n = 0;
process.stdin.on('data', (d) => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const p = JSON.parse(buf.slice(0, i)).message.content; buf = buf.slice(i + 1); n++;
    if (p.includes('CRASH')) process.exit(1);
    if (p.includes('SLOW')) continue;
    const result = p.startsWith('[triage') || p.startsWith('[voice') ? decide(p, 'warm') : 'pid ' + process.pid + ' turn ' + n + ' ' + p;
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n' + JSON.stringify({ type: 'result', subtype: 'success', result }) + '\\n');
  }
});
`;

function sandbox() {
  const dir = mkdtempSync(path.join(tmpdir(), 'fastwarm-'));
  const bin = path.join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(path.join(bin, 'claude'), FAKE); chmodSync(path.join(bin, 'claude'), 0o755);
  // being-handle hands off to the work stage with setsid: a no-op here keeps the queued work in place for the asserts.
  writeFileSync(path.join(bin, 'setsid'), '#!/bin/sh\nexit 0\n'); chmodSync(path.join(bin, 'setsid'), 0o755);
  return { dir, fake: path.join(bin, 'claude'), bin };
}
const laneWith = (fake, opts) => new Lane('owner', (sys, o = {}) => spawn(fake, claudeArgs(sys, o), { stdio: ['pipe', 'pipe', 'ignore'] }), opts);
const pidOf = (r) => r.text.split(' ')[1];

test('claudeArgs keeps the lean flags and the system prompt', () => {
  const a = claudeArgs('SYS', { model: 'haiku', effort: 'low', sessionId: 'x' });
  for (const f of ['--input-format', 'stream-json', '--tools', '', '--strict-mcp-config', '--disable-slash-commands', '--effort', 'low']) assert.ok(a.includes(f), f);
  assert.equal(a[a.indexOf('--system-prompt') + 1], 'SYS');
});

test('a lane reuses one process across turns and restarts after maxTurns', async (t) => {
  const { dir, fake } = sandbox(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const l = laneWith(fake, { maxTurns: 2 }); t.after(() => l.kill('test end'));
  const a = await l.ask('S', 'one', 3000), b = await l.ask('S', 'two', 3000), c = await l.ask('S', 'three', 3000);
  assert.equal(pidOf(a), pidOf(b));
  assert.ok(a.fresh && !b.fresh);
  assert.notEqual(pidOf(c), pidOf(a));
  assert.equal(c.gen, 2);
});

test('a changed system prompt starts a new process', async (t) => {
  const { dir, fake } = sandbox(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const l = laneWith(fake); t.after(() => l.kill('test end'));
  const a = await l.ask('S1', 'x', 3000), b = await l.ask('S2', 'y', 3000);
  assert.notEqual(pidOf(a), pidOf(b));
});

test('a changed model (from .env) starts a new process with that model', async (t) => {
  const { dir, fake } = sandbox(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const l = laneWith(fake); t.after(() => l.kill('test end'));
  const a = await l.ask('S', 'x', 3000, { model: 'haiku', effort: 'low' });
  const b = await l.ask('S', 'y', 3000, { model: 'haiku', effort: 'low' });
  const c = await l.ask('S', 'z', 3000, { model: 'opus', effort: 'low' });
  assert.equal(pidOf(a), pidOf(b)); assert.notEqual(pidOf(b), pidOf(c));
  assert.ok(l.child.spawnargs.includes('opus'));
});

test('a turn that overruns its timeout fails and the next turn gets a fresh process', async (t) => {
  const { dir, fake } = sandbox(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const l = laneWith(fake); t.after(() => l.kill('test end'));
  const a = await l.ask('S', 'warm', 3000);
  await assert.rejects(l.ask('S', 'SLOW', 300), /timeout/);
  const b = await l.ask('S', 'again', 3000);
  assert.notEqual(pidOf(a), pidOf(b));
  assert.ok(b.fresh);
});

test('a process that dies mid-turn fails that turn and is restarted on the next', async (t) => {
  const { dir, fake } = sandbox(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const l = laneWith(fake); t.after(() => l.kill('test end'));
  await assert.rejects(l.ask('S', 'CRASH', 3000), /exited/);
  const r = await l.ask('S', 'ok', 3000);
  assert.match(r.text, /turn 1 ok/);
});

test('a prewarmed lane counts as used now (the idle reaper must not stop it at once)', async (t) => {
  const { dir, fake } = sandbox(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const l = laneWith(fake); t.after(() => l.kill('test end'));
  await l.prewarm('S');
  assert.ok(l.alive()); assert.ok(Date.now() - l.lastUse < 5000);
  const r = await l.ask('S', 'first', 3000);
  assert.ok(r.fresh); assert.equal(r.gen, 1);   // the prewarmed process takes the first turn
});

test('fifo-wait: a line written before the reader looks is kept; .ready names the pid', async (t) => {
  const { openTrigger, readLine } = await import('./fifo-wait.mjs');
  const dir = mkdtempSync(path.join(tmpdir(), 'fifo-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'f'); spawnSync('mkfifo', [f]);
  const fd = openTrigger(f);
  assert.equal(readFileSync(f + '.ready', 'utf8'), String(process.pid));
  spawnSync('bash', ['-c', `{ printf 'go\\nextra\\n' >&5; } 5<>"${f}"`]);   // the writer is gone before we read
  assert.equal(readLine(fd), 'go');
});

test('turns in one lane are serialised', async (t) => {
  const { dir, fake } = sandbox(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const l = laneWith(fake); t.after(() => l.kill('test end'));
  const [a, b] = await Promise.all([l.ask('S', 'p1', 3000), l.ask('S', 'p2', 3000)]);
  assert.match(a.text, /turn 1 p1/); assert.match(b.text, /turn 2 p2/);
});

test('client: no daemon is exit code 2, so being-handle falls back at once', async () => {
  const r = await ask(path.join(tmpdir(), 'no-such-fast-warm.sock'), { lane: 'owner' }, 1000);
  assert.equal(r.ok, false); assert.equal(r.code, 2);
});

test('ack-schema requires "answered" next to needsWork', () => {
  const s = JSON.parse(readFileSync(path.join(KIT, 'ack-schema.json'), 'utf8')).properties.actions.items;
  assert.ok(s.required.includes('answered') && s.required.includes('needsWork'));
  assert.equal(s.properties.answered.type, 'boolean');
  assert.equal(s.additionalProperties, false);
});

// ---------- being-handle triage end to end, in a throwaway kit (nothing is sent: teams-ack is a recorder) ----------
function kitSandbox(t, envExtra = '') {
  const { dir, fake, bin } = sandbox(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kit = path.join(dir, 'kit'), st = path.join(dir, 'state'), home = path.join(dir, 'home');
  for (const d of [kit, st, home, path.join(dir, 'ws')]) mkdirSync(d, { recursive: true });
  for (const f of ['being-handle', 'being-status', 'ack-schema.json', 'voice-schema.json', 'fast-warm.mjs', 'mesh.py', 'soul.py']) copyFileSync(path.join(KIT, f), path.join(kit, f));
  chmodSync(path.join(kit, 'being-handle'), 0o755); chmodSync(path.join(kit, 'being-status'), 0o755);
  writeFileSync(path.join(kit, 'teams-ack.mjs'), `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(process.env.BEING_STATE_DIR + '/ack-in.json', readFileSync(0, 'utf8'));\n`);
  writeFileSync(path.join(kit, '.env'), `BEING_NAME=Testbeing\nBEING_STATE_DIR=${st}\nBEING_WORKSPACE=${path.join(dir, 'ws')}\n` +
    `BEING_FAST_CLIENT=claude\nOWNER_NAME=Owner\nOWNER_OID=owner-oid\nBEING_FAST_WARM_TIMEOUT_MS=1500\n${envExtra}`);
  const env = { ...hostEnv(), PATH: `${bin}:${process.env.PATH}`, HOME: home, BEING_KIT_HOME: kit, BEING_STATE_DIR: st };
  const triage = (msgs) => {
    writeFileSync(path.join(st, 'queue.jsonl'), msgs.map((m) => JSON.stringify(m)).join('\n') + '\n');
    const r = spawnSync(path.join(kit, 'being-handle'), ['triage'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return { ack: JSON.parse(readFileSync(path.join(st, 'ack-in.json'), 'utf8')), log: readFileSync(path.join(st, 'handler.log'), 'utf8'),
      work: existsSync(path.join(st, 'work.jsonl')) ? readFileSync(path.join(st, 'work.jsonl'), 'utf8') : '' };
  };
  // nodeOnlyPath: the daemon's PATH holds node but no claude, so only the named variable can find the client.
  const serve = async (cmdVar = 'BEING_FAST_WARM_CMD', nodeOnlyPath = false) => {
    const extra = { [cmdVar]: fake };
    if (nodeOnlyPath) {
      const nb = path.join(dir, 'node-only'); mkdirSync(nb, { recursive: true }); symlinkSync(process.execPath, path.join(nb, 'node'));
      extra.PATH = `${nb}:/usr/bin:/bin`;
    }
    const d = spawn(process.execPath, [path.join(kit, 'fast-warm.mjs'), 'serve'], { env: { ...env, ...extra }, stdio: 'ignore' });
    t.after(() => d.kill('SIGTERM'));
    for (let i = 0; i < 50 && !existsSync(path.join(st, 'fast-warm.sock')); i++) await sleep(50);
  };
  return { triage, serve, st };
}
const msg = (id, text, extra = {}) => ({ chatId: '19:owner-chat', chatType: 'oneOnOne', fromId: 'owner-oid', from: 'Owner', messageId: id, text, at: '2026-10-12T12:00:00Z', ...extra });

test('triage without the warm daemon falls back to the cold call and still answers', (t) => {
  const { triage } = kitSandbox(t);
  const r = triage([msg('m1', 'status?')]);
  assert.match(r.log, /fast warm failed \(triage, rc 2: no daemon\); cold fallback/);
  const a = r.ack.actions[0];
  assert.equal(a.action, 'reply'); assert.equal(a.answered, true); assert.equal(a.needsWork, false);
  assert.equal(r.work, '');   // a direct answer queues no work run
});

test('triage on the warm daemon: direct answer for status, ack + work for a request', async (t) => {
  const { triage, serve } = kitSandbox(t);
  await serve();
  const r = triage([msg('m2', 'status?'), msg('m3', 'please draft the proposal')]);
  assert.match(r.log, /fast warm ok \(triage, owner/);
  const by = Object.fromEntries(r.ack.actions.map((a) => [a.messageId, a]));
  assert.equal(by.m2.answered, true); assert.equal(by.m2.needsWork, false);
  assert.equal(by.m3.answered, false); assert.equal(by.m3.needsWork, true);
  assert.match(r.work, /"messageId": "m3"/); assert.doesNotMatch(r.work, /"messageId": "m2"/);
});

test('the warm daemon uses BEING_CLAUDE_BIN when BEING_FAST_WARM_CMD is unset', async (t) => {
  const { triage, serve } = kitSandbox(t);
  await serve('BEING_CLAUDE_BIN', true);
  const r = triage([msg('m6', 'status?')]);
  assert.match(r.log, /fast warm ok \(triage, owner/);
});

test('a warm turn that times out falls back to the cold call', async (t) => {
  const { triage, serve } = kitSandbox(t);
  await serve();
  const r = triage([msg('m4', 'SLOW status?')]);
  assert.match(r.log, /fast warm failed \(triage, rc 3: timeout\/error\); cold fallback/);
  assert.match(r.log, /triage ok/);
  assert.equal(r.ack.actions[0].answered, true);
});

test('a reaction chosen for a question is turned into none + work', (t) => {
  const { triage } = kitSandbox(t);
  const r = triage([msg('m5', 'can you react?')]);
  const a = r.ack.actions[0];
  assert.equal(a.action, 'none'); assert.equal(a.needsWork, true);
  assert.match(r.work, /"messageId": "m5"/);
});

// ---------- triage guards from an eval ----------
test('reaction events are decided in code (none), with no model turn; work only when they answer a question', (t) => {
  const { triage } = kitSandbox(t);
  const r = triage([msg('r1', '', { addressedBy: 'reaction', preview: 'Like on my message [x]: "Shall I restart now?"' }),
    msg('r2', '', { addressedBy: 'reaction', preview: 'Like on my message [y]: "Done, restarted."' })]);
  assert.match(r.log, /reactions only, no model/); assert.doesNotMatch(r.log, /triage model start/);
  for (const a of r.ack.actions) assert.equal(a.action, 'none');
  assert.match(r.work, /"r1"/); assert.doesNotMatch(r.work, /"r2"/);
});

test('a 1:1 question the model left without a decision gets none + work, never the 👍 fallback', (t) => {
  const { triage } = kitSandbox(t);
  const r = triage([msg('q1', 'itna time kyu lag rha hai SKIPME'), msg('q2', 'thanks SKIPME')]);
  const q1 = r.ack.actions.find((a) => a.messageId === 'q1');
  assert.equal(q1.action, 'none'); assert.equal(q1.needsWork, true);
  assert.ok(!r.ack.actions.find((a) => a.messageId === 'q2'), 'a non-question keeps the usual fallback (teams-ack reacts)');
  assert.match(r.work, /"q1"/);
});

test('Hinglish question words anywhere in the text count as a question (no reaction)', (t) => {
  const { triage } = kitSandbox(t);
  const texts = ['ye new hai iska btao REACTME', 'deploy ho gaya kya REACTME', 'kitna baki hai REACTME', 'ye kaise chalega REACTME', 'kaun dekh raha hai REACTME', 'sab theek hai REACTME'];
  const r = triage(texts.map((x, i) => msg('h' + i, x)));
  const act = (i) => r.ack.actions.find((a) => a.messageId === 'h' + i).action;
  for (let i = 0; i < 5; i++) assert.equal(act(i), 'none', texts[i]);
  assert.equal(act(5), 'react', 'a plain statement may still get a reaction');
});

test('teams-ack: its own no-decision fallback never reacts to a question', () => {
  const src = readFileSync(path.join(KIT, 'teams-ack.mjs'), 'utf8');
  const re = new RegExp(/const QUESTION = \/(.*)\/i;/.exec(src)[1], 'i');
  for (const q of ['itna time kyu lag rha hai', 'ye new hai iska btao', 'is it done', 'status?']) assert.ok(re.test(q), q);
  for (const s of ['thanks', 'ok done', 'sab theek hai']) assert.ok(!re.test(s), s);
  assert.match(src, /m\.chatType === 'oneOnOne' && !QUESTION\.test\(m\.text \?\? m\.preview \?\? ''\) \? 'react' : 'none'/);
});

