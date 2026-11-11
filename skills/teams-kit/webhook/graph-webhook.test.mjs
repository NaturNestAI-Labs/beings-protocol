// Graph webhook receiver: validation echo, POST-only routes, clientState check, ids-only queue, kick; subscribe plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHookServer, clientStateOk, accept } from './graph-webhook.mjs';
import { plan, RENEW_BELOW_MS } from './graph-subscribe.mjs';

const SECRET = 'k'.repeat(48);
const stateDir = (secret = SECRET) => {
  const d = mkdtempSync(path.join(tmpdir(), 'hook-'));
  writeFileSync(path.join(d, 'client-state'), secret + '\n');
  return d;
};
async function withServer(fn) {
  const state = stateDir();
  const srv = createHookServer({ state });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn(base, state); } finally { srv.close(); }
}
const note = (over = {}) => ({ clientState: SECRET, changeType: 'created', subscriptionId: 'sub-1',
  resource: "chats('19:abc')/messages('1700000000000')", resourceData: { id: '1700000000000', body: 'secret text' }, ...over });

test('clientState comparison accepts only the exact secret, any length', () => {
  assert.equal(clientStateOk(SECRET, SECRET), true);
  assert.equal(clientStateOk(SECRET + 'x', SECRET), false);
  assert.equal(clientStateOk(SECRET.slice(1), SECRET), false);
  assert.equal(clientStateOk('', SECRET), false);
  assert.equal(clientStateOk(undefined, SECRET), false);
  assert.equal(clientStateOk({ toString: () => SECRET }, SECRET), false);
});

test('a short client-state file refuses to start', () => {
  assert.throws(() => createHookServer({ state: stateDir('short') }), /at least 32/);
});

test('validation handshake echoes the decoded token as text/plain, on POST only', async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/graph/notify?validationToken=Validation%3A%20abc%2B1`, { method: 'POST' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /^text\/plain/);
    assert.equal(await r.text(), 'Validation: abc+1');
    assert.equal((await fetch(`${base}/graph/notify?validationToken=x`)).status, 404);
    assert.equal((await fetch(`${base}/graph/lifecycle?validationToken=${'a'.repeat(3000)}`, { method: 'POST' })).status, 400);
  });
});

test('only POST /graph/notify and /graph/lifecycle are served', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/graph/other`, { method: 'POST', body: '{}' })).status, 404);
    assert.equal((await fetch(`${base}/graph/notify`, { method: 'PUT', body: '{}' })).status, 404);
  });
});

test('good notifications queue ids only and kick; bad clientState is dropped', async () => {
  await withServer(async (base, state) => {
    const r = await fetch(`${base}/graph/notify`, { method: 'POST', body: JSON.stringify({ value: [note(), note({ clientState: 'wrong' })] }) });
    assert.equal(r.status, 202);
    const lines = readFileSync(path.join(state, 'queue.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'changeType', 'id', 'kind', 'resource', 'subscriptionId']);
    assert.equal(lines[0].id, '1700000000000');
    assert.ok(!readFileSync(path.join(state, 'queue.jsonl'), 'utf8').includes('secret text'));
    assert.ok(existsSync(path.join(state, 'kick')));
  });
});

test('a batch with only bad clientState neither queues nor kicks', () => {
  const state = stateDir();
  assert.equal(accept('notify', JSON.stringify({ value: [note({ clientState: 'nope' })] }), { state, secret: SECRET }), 202);
  assert.equal(existsSync(path.join(state, 'queue.jsonl')), false);
  assert.equal(existsSync(path.join(state, 'kick')), false);
});

test('lifecycle events go to lifecycle.jsonl; malformed and oversized bodies are refused', async () => {
  await withServer(async (base, state) => {
    const ok = await fetch(`${base}/graph/lifecycle`, { method: 'POST',
      body: JSON.stringify({ value: [{ clientState: SECRET, lifecycleEvent: 'reauthorizationRequired', subscriptionId: 'sub-1' }] }) });
    assert.equal(ok.status, 202);
    assert.equal(JSON.parse(readFileSync(path.join(state, 'lifecycle.jsonl'), 'utf8')).event, 'reauthorizationRequired');
    assert.equal((await fetch(`${base}/graph/notify`, { method: 'POST', body: 'not json' })).status, 400);
    assert.equal((await fetch(`${base}/graph/notify`, { method: 'POST', body: '{"value":1}' })).status, 400);
    const big = await fetch(`${base}/graph/notify`, { method: 'POST', body: 'x'.repeat((1 << 20) + 10) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
  });
});

test('subscribe plan: create when missing, renew when forced or under 36 h, else keep', () => {
  const now = Date.parse('2026-01-01T00:00:00Z');
  const sub = (h) => ({ status: 200, json: { expirationDateTime: new Date(now + h * 3600e3).toISOString() } });
  assert.equal(plan('ensure', null, now), 'create');
  assert.equal(plan('ensure', { status: 404, json: {} }, now), 'create');
  assert.equal(plan('ensure', sub(60), now), 'keep');
  assert.equal(plan('ensure', sub(RENEW_BELOW_MS / 3600e3 - 1), now), 'renew');
  assert.equal(plan('renew', sub(60), now), 'renew');
  assert.equal(plan('delete', sub(60), now), 'delete');
});
