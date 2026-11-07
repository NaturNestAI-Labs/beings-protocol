// Per-conversation logs: every comms line also lands in state/conversations/<chat>.jsonl (hive per mind), 0600;
// the backfill splits the old global log once without repeating lines; RECENT CHAT's file name rule matches safeName().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostEnv } from './test-env.mjs';
const KIT = path.dirname(fileURLToPath(import.meta.url));
const CL = path.join(KIT, 'comms-log.mjs');

function state(t) {
  const st = mkdtempSync(path.join(tmpdir(), 'conv-'));
  t.after(() => rmSync(st, { recursive: true, force: true }));
  const env = { ...hostEnv(), BEING_STATE_DIR: st, BEING_COMMS_LOG: path.join(st, 'comms.jsonl') };
  const node = (args, input) => spawnSync('node', [CL, ...args], { encoding: 'utf8', env, input });
  const lines = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { st, node, lines, conv: (n) => path.join(st, 'conversations', n + '.jsonl') };
}

test('each line goes to the global log and its own conversation file (0600); hive per mind; no chat = global only', (t) => {
  const { st, node, lines, conv } = state(t);
  node(['--append'], JSON.stringify({ dir: 'in', chatId: '19:abc_def@unq.gbl.spaces', messageId: '1', text: 'hi' }));
  node(['--append'], JSON.stringify({ dir: 'out', kind: 'ack-reply', chatId: '19:abc_def@unq.gbl.spaces', messageId: '2', text: 'yo' }));
  node(['--append'], JSON.stringify({ dir: 'in', chatId: '19:other', messageId: '3' }));
  node(['--append'], JSON.stringify({ channel: 'hive', dir: 'in', mind: 'nova-laptop', hiveId: 'h1' }));
  node(['--append'], JSON.stringify({ dir: 'draft', kind: 'skipped', draftId: 'D1' }));
  assert.equal(lines(path.join(st, 'comms.jsonl')).length, 5);
  const a = lines(conv('19_abc_def@unq.gbl.spaces'));
  assert.deepEqual(a.map((e) => e.messageId), ['1', '2']); assert.ok(a[0].loggedAt);
  assert.equal(lines(conv('19_other')).length, 1);
  assert.equal(lines(conv('hive-nova-laptop'))[0].hiveId, 'h1');
  assert.equal(statSync(conv('19_other')).mode & 0o777, 0o600);
});

test('backfill splits the old global log once, without repeating lines already written live', (t) => {
  const { st, node, lines, conv } = state(t);
  const old = [{ dir: 'in', chatId: '19:a', messageId: 'o1' }, { dir: 'out', chatId: '19:b', messageId: 'o2' }, { dir: 'draft', draftId: 'D1' }];
  writeFileSync(path.join(st, 'comms.jsonl'), old.map((e) => JSON.stringify(e)).join('\n') + '\n');
  node(['--append'], JSON.stringify({ dir: 'in', chatId: '19:a', messageId: 'live1' }));   // live, before the backfill
  assert.match(node(['--backfill']).stdout, /backfilled 2/);
  assert.deepEqual(lines(conv('19_a')).map((e) => e.messageId), ['o1', 'live1']);
  assert.deepEqual(lines(conv('19_b')).map((e) => e.messageId), ['o2']);
  assert.match(node(['--backfill']).stdout, /backfilled 0/);   // once only
  assert.equal(lines(conv('19_a')).length, 2);
});

test("being-handle's RECENT CHAT file rule matches safeName()", async () => {
  const { safeName } = await import(CL);
  const src = readFileSync(path.join(KIT, 'being-handle'), 'utf8');
  assert.match(src, /re\.sub\(r"\[\^A-Za-z0-9\._@-\]","_",chat\)\[:150\]/);
  assert.equal(safeName('19:x/y z@unq.gbl.spaces'), '19_x_y_z@unq.gbl.spaces');
});
