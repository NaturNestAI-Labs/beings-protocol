// being-retry: failed work and failed sends are re-queued with an attempt count, at most 3 tries, then one alert;
// items already handled by hand are never replayed. Throwaway kit and state, fake sender (nothing is sent anywhere).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostEnv } from './test-env.mjs';
const KIT = path.dirname(fileURLToPath(import.meta.url));

function kit(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'retry-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const k = path.join(dir, 'kit'), st = path.join(dir, 'state');
  mkdirSync(k); mkdirSync(path.join(st, 'outbox', 'failed'), { recursive: true });
  copyFileSync(path.join(KIT, 'being-retry'), path.join(k, 'being-retry'));
  writeFileSync(path.join(k, '.env'), `BEING_STATE_DIR=${st}\nBEING_NAME=Test\n`);
  // Fake sender: records each alert line.
  writeFileSync(path.join(k, 'teams-send-dm.mjs'), `import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(path.join(dir, 'sent.log'))}, readFileSync(0, 'utf8') + '\\n');`);
  const run = (...a) => spawnSync('python3', [path.join(k, 'being-retry'), ...a], {
    encoding: 'utf8', env: { ...hostEnv(), BEING_STATE_DIR: st, BEING_RETRY_BACKOFF_SEC: '0', BEING_RETRY_DISPATCH: '0' } });
  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const sent = () => (existsSync(path.join(dir, 'sent.log')) ? readFileSync(path.join(dir, 'sent.log'), 'utf8').split('\n').filter(Boolean) : []);
  return { st, run, lines, sent };
}

const msg = (id) => ({ messageId: id, chatId: '19:abc', from: 'Sam', text: 'please do X', fromId: 'o1', chatType: 'oneOnOne' });

test('a failed work item is re-queued with an attempt count, at most 3 tries, then one blocker + one line', (t) => {
  const { st, run, lines, sent } = kit(t);
  const fail = (m) => writeFileSync(path.join(st, 'failed.jsonl'), JSON.stringify(m) + '\n', { flag: 'a' });
  fail(msg('m1'));
  assert.equal(run('run').status, 0);
  let w = lines(path.join(st, 'work.jsonl'));
  assert.equal(w.length, 1); assert.equal(w[0].messageId, 'm1'); assert.equal(w[0].retry, 2);
  assert.ok(!existsSync(path.join(st, 'failed.jsonl')));
  // The retry fails too (being-handle appends the line it ran, retry field included).
  fail(w[0]); writeFileSync(path.join(st, 'work.jsonl'), '');
  run('run');
  w = lines(path.join(st, 'work.jsonl')); assert.equal(w.length, 1); assert.equal(w[0].retry, 3);
  // Third failure: no fourth try; given up, recorded, one alert.
  fail(w[0]); writeFileSync(path.join(st, 'work.jsonl'), '');
  run('run');
  assert.equal(lines(path.join(st, 'work.jsonl')).length, 0);
  const h = lines(path.join(st, 'failed-handled.jsonl'));
  assert.equal(h.length, 1); assert.equal(h[0].retryKey, 'm1'); assert.ok(h[0].gaveUpAt);
  assert.equal(lines(path.join(st, 'blockers.jsonl')).length, 1);
  assert.equal(sent().length, 1); assert.match(sent()[0], /Gave up after 3 tries/);
  // Coming back again (a stray copy) is ignored: no replay, no second alert.
  fail(msg('m1')); run('run');
  assert.equal(lines(path.join(st, 'work.jsonl')).length, 0); assert.equal(sent().length, 1);
  assert.match(run('status').stdout, /given up: 1 work/);
});

test('items already handled by hand (failed-handled.jsonl) are never replayed', (t) => {
  const { st, run, lines } = kit(t);
  writeFileSync(path.join(st, 'failed-handled.jsonl'), JSON.stringify(msg('done1')) + '\n' +
    JSON.stringify({ messageId: 'note:n1', addressedBy: 'note', text: 'x' }) + '\n');
  writeFileSync(path.join(st, 'failed.jsonl'), [msg('done1'), { messageId: 'note:n1', addressedBy: 'note', text: 'x' }, msg('new1')]
    .map((m) => JSON.stringify(m)).join('\n') + '\n');
  run('run');
  const w = lines(path.join(st, 'work.jsonl'));
  assert.deepEqual(w.map((m) => m.messageId), ['new1']);
});

test('backoff: a fresh failure waits before its retry', (t) => {
  const { st, lines } = kit(t);
  writeFileSync(path.join(st, 'failed.jsonl'), JSON.stringify(msg('m2')) + '\n');
  const r = spawnSync('python3', [path.join(path.dirname(st), 'kit', 'being-retry'), 'run'], { encoding: 'utf8',
    env: { ...hostEnv(), BEING_STATE_DIR: st, BEING_RETRY_BACKOFF_SEC: '120,600', BEING_RETRY_DISPATCH: '0' } });
  assert.equal(r.status, 0);
  assert.equal(lines(path.join(st, 'work.jsonl')).length, 0);
  const p = JSON.parse(readFileSync(path.join(st, 'retry.json'), 'utf8'));
  assert.equal(p.m2.attempts, 1); assert.equal(p.m2.state, 'waiting'); assert.ok(p.m2.due > Date.now() / 1000 + 100);
});

test('failed sends go back to the outbox with attempts; refused (exit 3) and exhausted ones go to dead/ with one alert each', (t) => {
  const { st, run, sent } = kit(t);
  const ob = path.join(st, 'outbox');
  const put = (id, extra) => writeFileSync(path.join(ob, 'failed', id + '.json'), JSON.stringify({ id, chatId: '19:abc', html: '<p>hi</p>', scope: 'full', final: '<p>hi</p>', how: 'voiced', exit: 1, ...extra }));
  put('o1', {}); put('o2', { exit: 3 }); put('o3', { attempts: 3 });
  for (const f of readdirSync(path.join(ob, 'failed'))) utimesSync(path.join(ob, 'failed', f), new Date(0), new Date(0));
  run('run');
  const back = JSON.parse(readFileSync(path.join(ob, 'o1.json'), 'utf8'));
  assert.equal(back.attempts, 2); assert.equal(back.final, undefined); assert.equal(back.exit, undefined);
  assert.deepEqual(readdirSync(path.join(ob, 'dead')).sort(), ['o2.json', 'o3.json']);
  assert.equal(readdirSync(path.join(ob, 'failed')).length, 0);
  assert.equal(sent().length, 2);
});

// A failed run's message was answered by another session before its retry came due; the retry replayed it anyway.
test('a failed message that has been answered meanwhile is settled, never replayed (and no alert)', (t) => {
  const { st, run, lines, sent } = kit(t);
  const m = { ...msg('1700000000001'), chatId: '19:grp@thread.v2', chatType: 'group' };
  writeFileSync(path.join(st, 'failed.jsonl'), JSON.stringify(m) + '\n' + JSON.stringify(msg('m9')) + '\n');
  // Already answered when the failure is claimed: settled at once.
  writeFileSync(path.join(st, 'comms.jsonl'), JSON.stringify({ dir: 'out', kind: 'message', chatId: '19:grp@thread.v2', messageId: 'r1', replyTo: '1700000000001' }) + '\n' +
    JSON.stringify({ dir: 'out', kind: 'ack-reply', chatId: '19:abc', messageId: 'a1', replyTo: 'm9' }) + '\n');
  run('run');
  assert.deepEqual(lines(path.join(st, 'work.jsonl')).map((x) => x.messageId), ['m9'], 'a triage ack is not an answer: m9 still retried');
  const h = lines(path.join(st, 'failed-handled.jsonl'));
  assert.equal(h.length, 1); assert.equal(h[0].retryKey, '1700000000001'); assert.equal(h[0].answeredBy, 'r1');
  assert.equal(sent().length, 0);
});

test('answered while waiting for its backoff: settled when it comes due, not re-queued', (t) => {
  const { st, lines } = kit(t);
  writeFileSync(path.join(st, 'failed.jsonl'), JSON.stringify(msg('m5')) + '\n');
  const r1 = spawnSync('python3', [path.join(path.dirname(st), 'kit', 'being-retry'), 'run'], { encoding: 'utf8',
    env: { ...hostEnv(), BEING_STATE_DIR: st, BEING_RETRY_BACKOFF_SEC: '1', BEING_RETRY_DISPATCH: '0' } });
  assert.equal(r1.status, 0);
  mkdirSync(path.join(st, 'conversations'), { recursive: true });
  writeFileSync(path.join(st, 'conversations', '19_abc.jsonl'), JSON.stringify({ dir: 'out', kind: 'message', chatId: '19:abc', messageId: 'r5', replyTo: 'm5' }) + '\n');
  spawnSync('sleep', ['1.2']);
  spawnSync('python3', [path.join(path.dirname(st), 'kit', 'being-retry'), 'run'], { encoding: 'utf8',
    env: { ...hostEnv(), BEING_STATE_DIR: st, BEING_RETRY_BACKOFF_SEC: '1', BEING_RETRY_DISPATCH: '0' } });
  assert.equal(lines(path.join(st, 'work.jsonl')).length, 0);
  assert.equal(JSON.parse(readFileSync(path.join(st, 'retry.json'), 'utf8')).m5, undefined);
  assert.equal(lines(path.join(st, 'failed-handled.jsonl'))[0].answeredBy, 'r5');
});
