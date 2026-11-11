// detect-util: the sweep's 120 s look-back, time (not string) comparison, and the webhook offset that moves only after a
// successful fetch (review #11).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sweepSince, after, readNotified, commitOffset } from './detect-util.mjs';

test('the sweep looks 120 s behind its watermark', () => {
  assert.equal(sweepSince('2026-10-12T14:01:05Z'), '2026-10-12T13:59:05.000Z');
  assert.equal(sweepSince('2026-10-12T14:01:05Z', 0), '2026-10-12T14:01:05.000Z');
  assert.throws(() => sweepSince('garbage'));
});

test('times compare as times: a message half a second after a whole-second watermark is new', () => {
  // As strings "…:00.500Z" < "…:00Z" ('.' sorts before 'Z'), which lost these messages for good.
  assert.ok('2026-10-12T14:00:00.500Z' < '2026-10-12T14:00:00Z');
  assert.equal(after('2026-10-12T14:00:00.500Z', '2026-10-12T14:00:00Z'), true);
  assert.equal(after('2026-10-12T13:59:59.999Z', '2026-10-12T14:00:00Z'), false);
  assert.equal(after('2026-10-12T14:00:00Z', '2026-10-12T14:00:00Z'), false);
  assert.equal(after(undefined, '2026-10-12T14:00:00Z'), false);
});

test('the hook offset moves only after a successful fetch; a stuck line gives up after 3 tries', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hook-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const q = path.join(dir, 'queue.jsonl'), of = path.join(dir, 'hook-offset');
  const line = (mid) => JSON.stringify({ kind: 'notify', changeType: 'created', resource: `chats('19:c')/messages('${mid}')` }) + '\n';
  writeFileSync(q, line('m1')); writeFileSync(of, '0');
  let n = readNotified(q, of);
  assert.deepEqual([...n.ids.keys()], ['m1']);
  assert.equal(readFileSync(of, 'utf8'), '0');                       // reading alone never moves it
  commitOffset(of, n, false);                                         // fetch failed: same lines next kick
  appendFileSync(q, line('m2'));
  n = readNotified(q, of);
  assert.deepEqual([...n.ids.keys()], ['m1', 'm2']);
  commitOffset(of, n, true);
  assert.equal(Number(readFileSync(of, 'utf8')), readFileSync(q).length);
  // A half-written line waits.
  appendFileSync(q, '{"kind":"notify"');
  n = readNotified(q, of); assert.equal(n.ids.size, 0); assert.equal(n.next, n.from);
  // Never-readable message: offset held twice, then moved on (the sweep still covers it).
  writeFileSync(q, line('bad')); writeFileSync(of, '0');
  for (const want of [0, 0]) { commitOffset(of, readNotified(q, of), false); assert.equal(Number(readFileSync(of, 'utf8')), want); }
  commitOffset(of, readNotified(q, of), false);
  assert.equal(Number(readFileSync(of, 'utf8')), readFileSync(q).length);
});

// The owner's group follow-ups without the name must be detected.
import { addressedBy } from './detect-util.mjs';
test('group addressing: name/@mention, the owner, an active thread; plain chatter is still ignored', () => {
  const ctx = { self: 'being', owner: 'owner', recent: [] };
  const at = '2026-10-13T03:49:04Z';
  const g = (x) => ({ chatType: 'group', fromId: 'kim', at, ...x });
  assert.equal(addressedBy({ chatType: 'oneOnOne', fromId: 'x', at }, ctx), 'direct-chat');
  assert.equal(addressedBy(g({ named: true }), ctx), 'named-or-mentioned');
  assert.equal(addressedBy(g({ mentionsSelf: true }), ctx), 'named-or-mentioned');
  // (b) the owner, in any group, with or without the name
  assert.equal(addressedBy(g({ fromId: 'owner' }), ctx), 'owner-in-group');
  assert.equal(addressedBy(g({ fromId: 'owner' }), { ...ctx, ownerWakes: false }), null);
  // (c) active thread: the Being spoke here 5 min ago and this sender named it 10 min ago
  const thread = { ...ctx, recent: [{ fromId: 'kim', at: '2026-10-13T03:39:00Z', toBeing: true }, { fromId: 'being', at: '2026-10-13T03:44:00Z' }] };
  assert.equal(addressedBy(g({}), thread), 'active-thread');
  // ...but not when the Being's last word is older than 15 min
  assert.equal(addressedBy(g({}), { ...ctx, recent: [{ fromId: 'kim', at: '2026-10-13T03:39:00Z', toBeing: true }, { fromId: 'being', at: '2026-10-13T03:30:00Z' }] }), null);
  // ...nor for another person who never spoke to the Being (plain chatter in a live thread)
  assert.equal(addressedBy(g({ fromId: 'lee' }), thread), null);
  // ...nor when the sender's earlier message was not to the Being, or is older than 30 min
  assert.equal(addressedBy(g({}), { ...ctx, recent: [{ fromId: 'kim', at: '2026-10-13T03:39:00Z', toBeing: false }, { fromId: 'being', at: '2026-10-13T03:44:00Z' }] }), null);
  assert.equal(addressedBy(g({}), { ...ctx, recent: [{ fromId: 'kim', at: '2026-10-13T03:10:00Z', toBeing: true }, { fromId: 'being', at: '2026-10-13T03:44:00Z' }] }), null);
  // plain chatter, nothing recent
  assert.equal(addressedBy(g({}), ctx), null);
});
