import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBatchCommand, parseDraftRange, dedupeRows, batchFingerprint, renderBatchPrompt, checkBatchCommand, checkBatchPrompt,
  parseCsv, fillTemplate, runBatch, summaryText } from './batch-lib.mjs';
import { PROMPT_MARK_RE, parseCommand } from './approval.mjs';

const OWNER = 'owner-oid', BEING = 'being-oid', BEING_UPN = 'nova@example.test';
const members = [{ userId: OWNER, email: 'sam@example.test' }, { userId: BEING, email: BEING_UPN }];
const dm = { id: 'dm1', chatType: 'oneOnOne' };
const row = (k, to, x = {}) => ({ key: k, draft: k, draftFp: `fp${k}`, to, cc: [], subject: 'RFQ follow-up', text: `hello ${k}`, attach: [], ...x });
const batch = (x = {}) => {
  const b = { id: 'B3', created: '2026-01-01T10:00:00Z', promptAt: '2026-01-01T10:00:05Z', promptChatId: 'dm1', status: 'open',
    rows: [row('D45', ['a@v.test']), row('D46', ['b@v.test'])], ...x };
  b.fingerprint = batchFingerprint(b); return b;
};
const cmd = (text, x = {}) => ({ id: 'm9', messageType: 'message', from: { user: { id: OWNER } }, createdDateTime: '2026-01-01T10:01:00Z', body: { content: `<p>${text}</p>` }, ...x });
const now = Date.parse('2026-01-01T11:00:00Z');
const check = (o = {}) => checkBatchCommand({ msg: cmd('SEND B3'), chat: dm, members, ownerOid: OWNER, beingUpn: BEING_UPN, verb: 'send',
  batch: batch(), used: new Set(), openIds: ['B3'], now, ...o });

test('commands: uppercase SEND only, optional batch id; skip needs the id; never clashes with send Dn', () => {
  assert.deepEqual(parseBatchCommand('SEND B3'), { verb: 'send', id: 'B3' });
  assert.deepEqual(parseBatchCommand(' SEND '), { verb: 'send', id: '' });
  assert.deepEqual(parseBatchCommand('skip B3'), { verb: 'skip', id: 'B3' });
  for (const t of ['send B3', 'Send', 'SEND all', 'SEND B3 now', 'skip', 'please SEND B3', 'SEND D45']) assert.equal(parseBatchCommand(t), null, t);
  assert.equal(parseCommand('SEND B3'), null);
});

test('draft ranges', () => {
  assert.deepEqual(parseDraftRange('D45-D47,D50 D45'), ['D45', 'D46', 'D47', 'D50']);
  assert.deepEqual(parseDraftRange('d3-5'), ['D3', 'D4', 'D5']);
  assert.throws(() => parseDraftRange('D9-D3'));
  assert.throws(() => parseDraftRange('X1'));
  assert.throws(() => parseDraftRange(''));
});

test('dedupe: nobody twice in a batch, not again after the same subject, bad addresses out', () => {
  const { rows, left } = dedupeRows([
    row('D1', ['A@v.test']), row('D2', ['b@v.test'], { cc: ['a@v.test'] }), row('D3', ['c@v.test']), row('D4', ['bad']), row('D5', []),
  ], new Set(['c@v.test\nrfq follow-up']));
  assert.deepEqual(rows.map((r) => r.key), ['D1']);
  assert.deepEqual(rows[0].to, ['a@v.test']);
  assert.deepEqual(left.map((l) => l.row.key), ['D2', 'D3', 'D4', 'D5']);
  assert.match(left[0].why, /already in D1/);
  assert.match(left[1].why, /already got this subject/);
});

test('the preview shows count, every recipient, the go command and a fingerprint only the kit posts', () => {
  const b = batch();
  const h = renderBatchPrompt(b, '<p>hello</p>', { gapSec: 20 });
  assert.match(h, /Batch B3/); assert.match(h, /2 emails as you/); assert.match(h, /a@v\.test/); assert.match(h, /b@v\.test/);
  assert.match(h, /SEND B3/); assert.ok(PROMPT_MARK_RE.test(h));
});

test('fingerprint changes with any recipient or text change', () => {
  const b = batch();
  assert.notEqual(batchFingerprint({ ...b, rows: [row('D45', ['x@v.test']), b.rows[1]] }), b.fingerprint);
  assert.notEqual(batchFingerprint({ ...b, rows: [{ ...b.rows[0], text: 'changed' }, b.rows[1]] }), b.fingerprint);
  assert.equal(batchFingerprint({ ...b, status: 'sending' }), b.fingerprint);
});

test('only the owner\'s own typed SEND in their 1:1, after the preview, used once', () => {
  assert.equal(check(), null);
  assert.equal(check({ msg: cmd('SEND') }), null);
  assert.match(check({ msg: cmd('SEND'), openIds: ['B2', 'B3'] }), /more than one batch/);
  assert.match(check({ msg: cmd('SEND B4') }), /another batch/);
  assert.match(check({ msg: cmd('send B3') }), /does not match/);
  assert.match(check({ msg: cmd('SEND B3', { from: { user: { id: BEING } } }) }), /not written by the owner/);
  assert.match(check({ msg: cmd('SEND B3', { from: { application: { id: 'x' } } }) }), /app/);
  assert.match(check({ kitSent: new Set(['m9']) }), /posted by the kit/);
  assert.match(check({ used: new Set(['m9']) }), /already used/);
  assert.match(check({ chat: { id: 'g', chatType: 'group' } }), /not in a 1:1/);
  assert.match(check({ chat: { id: 'dm2', chatType: 'oneOnOne' } }), /chat the batch was offered in/);
  assert.match(check({ msg: cmd('SEND B3', { createdDateTime: '2026-01-01T09:00:00Z' }) }), /older than the batch/);
  assert.match(check({ msg: cmd('SEND B3', { lastEditedDateTime: '2026-01-01T10:02:00Z' }) }), /edited/);
  assert.match(check({ now: Date.parse('2026-01-03T00:00:00Z') }), /older than 24h/);
  assert.match(check({ verb: 'skip', msg: cmd('SEND B3') }), /does not match/);
});

test('the preview must be the Being\'s, unedited and carry the current fingerprint', () => {
  const b = batch();
  const p = (x = {}) => ({ from: { user: { id: BEING } }, createdDateTime: '2026-01-01T10:00:05Z', body: { content: renderBatchPrompt(b, 'x') }, ...x });
  const cmdAt = Date.parse('2026-01-01T10:01:00Z');
  assert.equal(checkBatchPrompt({ promptMsg: p(), beingId: BEING, batch: b, cmdAt }), null);
  assert.match(checkBatchPrompt({ promptMsg: p({ from: { user: { id: OWNER } } }), beingId: BEING, batch: b, cmdAt }), /not posted by the Being/);
  assert.match(checkBatchPrompt({ promptMsg: p({ lastEditedDateTime: 'x' }), beingId: BEING, batch: b, cmdAt }), /edited/);
  const changed = { ...b, rows: [{ ...b.rows[0], to: ['evil@x.test'] }, b.rows[1]] };
  assert.match(checkBatchPrompt({ promptMsg: p(), beingId: BEING, batch: changed, cmdAt }), /changed after the owner saw it/);
});

test('template mode: csv and placeholders; a missing value is an error', () => {
  const rows = parseCsv('email,name,company\n a@v.test , Ravi,"Acme, Ltd"\n');
  assert.deepEqual(rows, [{ email: 'a@v.test', name: 'Ravi', company: 'Acme, Ltd' }]);
  assert.equal(fillTemplate('Dear {{name}} of {{ Company }}', rows[0]), 'Dear Ravi of Acme, Ltd');
  assert.throws(() => fillTemplate('Hi {{phone}}', rows[0]), /no value/);
  assert.throws(() => parseCsv('name\nx'), /email/);
});

const mkLedger = (init = {}) => { const m = new Map(Object.entries(init)); return { m, state: (k) => m.get(k), put: async (k, s) => m.set(k, s) }; };

test('runBatch: rate gap between sends, ledger stops repeats, rechecks skip, failures summarised', async () => {
  const rows = [row('D1', ['a@v.test']), row('D2', ['b@v.test']), row('D3', ['c@v.test']), row('D4', ['d@v.test'])];
  const sent = [], sleeps = [];
  const ledger = mkLedger({ D1: 'done' });
  const res = await runBatch(rows, { ledger, gapMs: 20000, sleep: async (ms) => sleeps.push(ms),
    recheck: (r) => (r.key === 'D3' ? 'draft D3 is sent' : null),
    send: async (r) => { if (r.key === 'D4') throw new Error('429 throttled'); sent.push(r.key); } });
  assert.deepEqual(sent, ['D2']);
  assert.deepEqual(sleeps, [20000]);
  assert.deepEqual(res.skipped.map((s) => s.row.key), ['D1', 'D3']);
  assert.deepEqual(res.failed.map((f) => f.row.key), ['D4']);
  assert.equal(ledger.m.get('D2'), 'done'); assert.equal(ledger.m.get('D4'), 'failed');
  const again = await runBatch(rows, { ledger, sleep: async () => {}, send: async (r) => sent.push(r.key) });
  assert.deepEqual(sent, ['D2', 'D3', 'D4']);
  assert.equal(again.sent.length, 2);
  const s = summaryText({ id: 'B3', rows }, res);
  assert.match(s, /sent 1 of 4/); assert.match(s, /D4 d@v\.test: 429/); assert.match(s, /SEND B3 again/);
});

test('runBatch: an uncertain send is never retried blind; three failures in a row stop the run; STOP halts', async () => {
  const rows = ['D1', 'D2', 'D3', 'D4', 'D5'].map((k, i) => row(k, [`${i}@v.test`]));
  const ledger = mkLedger();
  const res = await runBatch(rows, { ledger, sleep: async () => {}, send: async (r) => { const e = new Error('timeout'); if (r.key === 'D1') e.uncertain = true; throw e; } });
  assert.equal(ledger.m.get('D1'), 'started');
  assert.deepEqual(res.failed.map((f) => f.row.key), ['D1', 'D2', 'D3']);
  assert.deepEqual(res.skipped.map((f) => f.row.key), ['D4', 'D5']);
  const sent = [];
  const res2 = await runBatch(rows, { ledger, sleep: async () => {}, send: async (r) => sent.push(r.key) });
  assert.ok(!sent.includes('D1'));
  assert.match(res2.failed[0].why, /check Sent Items/);
  let n = 0;
  const res3 = await runBatch(rows, { ledger: mkLedger(), sleep: async () => {}, stopped: () => n >= 2, send: async () => { n++; } });
  assert.equal(res3.sent.length, 2); assert.ok(res3.stopped);
});
