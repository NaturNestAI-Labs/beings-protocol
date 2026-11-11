import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planOf, parseLedger, withLedger, pendingOps, fingerprint } from './ledger.mjs';

const ops = [{ kind: 'mail', id: 'A', title: 'one' }, { kind: 'mail', id: 'B', title: 'two' }];

test('fingerprint is key-order independent and changes with any content', () => {
  assert.equal(fingerprint({ a: 1, b: [1, 2] }), fingerprint({ b: [1, 2], a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
  assert.match(fingerprint({}), /^[0-9a-f]{12}$/);
});

test('planOf: batch names and duplicate operations are checked; ids are stable', () => {
  assert.throws(() => planOf('bad name', ops), /batch name/);
  assert.throws(() => planOf('b', [...ops, ops[0]]), /duplicate/);
  const a = planOf('b', [{ kind: 'post', title: 'x' }]), b = planOf('b', [{ kind: 'post', title: 'x' }]);
  assert.equal(a.operations[0].id, b.operations[0].id);
  assert.notEqual(a.digest, planOf('c', [{ kind: 'post', title: 'x' }]).digest);
});

test('withLedger appends one fsynced row per step and a rerun sees them', async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'oa-led-')), 'l.jsonl'), plan = planOf('b', ops);
  await withLedger(f, plan, async (l) => { await l.put(plan.operations[0], 'started'); await l.put(plan.operations[0], 'done', { x: 1 }); });
  const rows = readFileSync(f, 'utf8').trim().split('\n').map((x) => JSON.parse(x));
  assert.deepEqual(rows.map((r) => r.state), ['started', 'done']);
  await withLedger(f, plan, async (l) => {
    assert.equal(l.records.get('A').x, 1);
    assert.deepEqual(pendingOps(plan, l.records).map((o) => o.id), ['B']);
  });
});

test('a started-but-unconfirmed step stops the run until reconciled', async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'oa-led-')), 'l.jsonl'), plan = planOf('b', ops);
  await withLedger(f, plan, (l) => l.put(plan.operations[1], 'started'));
  await withLedger(f, plan, async (l) => {
    assert.throws(() => pendingOps(plan, l.records), /unconfirmed/);
    assert.deepEqual(pendingOps(plan, l.records, { reconciled: new Set(['B']) }).map((o) => o.id), ['A', 'B']);
  });
});

test('ledger refuses another batch, a regression, a partial line and a second runner', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'oa-led-')), f = path.join(d, 'l.jsonl'), plan = planOf('b', ops);
  await withLedger(f, plan, (l) => l.put(plan.operations[0], 'done'));
  assert.throws(() => parseLedger(readFileSync(f, 'utf8'), planOf('other', ops)), /does not match/);
  const done = readFileSync(f, 'utf8');
  assert.throws(() => parseLedger(done + JSON.stringify({ plan: plan.digest, id: 'A', state: 'started' }) + '\n', plan), /backwards/);
  appendFileSync(f, '{"half":');
  await assert.rejects(withLedger(f, plan, async () => {}), /partial line/);
  writeFileSync(f, done); writeFileSync(`${f}.lock`, '');
  await assert.rejects(withLedger(f, plan, async () => {}), /lock exists/);
});
