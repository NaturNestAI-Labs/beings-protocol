// Send-as (another account that granted it): off by default, listed accounts only, own cache, owner-approved draft only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sendAsAccount, sendAsCache, checkSendAsDraft } from './send-as.mjs';
import { fingerprint, renderPrompt } from './approval.mjs';

const setup = (t, extra = {}) => {
  const st = mkdtempSync(path.join(tmpdir(), 'sendas-'));
  const env = { BEING_STATE_DIR: st, BEING_UPN: 'nova@example.test', BEING_CACHE: path.join(st, 'token-cache.json'), OWNER_UPN: 'sam@example.test',
    OWNER_CACHE: path.join(st, 'owner-cache.json'), BEING_ALLOW_SEND_AS: '1', BEING_SEND_AS_UPNS: 'kim@example.test, lee@example.test', ...extra };
  mkdirSync(path.join(st, 'send-as'), { mode: 0o700 });
  const cache = sendAsCache('kim@example.test', env);
  writeFileSync(cache, '{}', { mode: 0o600 });
  return { env, cache, st };
};

test('allowed only when switched on, listed, signed in to its own 0600 cache, not paused', (t) => {
  const { env, cache, st } = setup(t);
  assert.deepEqual(sendAsAccount('Kim@example.test', env), { upn: 'kim@example.test', cache });
  assert.match(sendAsAccount('kim@example.test', { ...env, BEING_ALLOW_SEND_AS: '0' }), /off/);
  assert.match(sendAsAccount('kim@example.test', { ...env, BEING_ALLOW_SEND_AS: undefined }), /off/);
  assert.match(sendAsAccount('pat@example.test', env), /not in BEING_SEND_AS_UPNS/);
  assert.match(sendAsAccount('lee@example.test', env), /no sign-in/);
  assert.match(sendAsAccount('sam@example.test', { ...env, BEING_SEND_AS_UPNS: 'sam@example.test' }), /owner/);
  assert.match(sendAsAccount('nova@example.test', { ...env, BEING_SEND_AS_UPNS: 'nova@example.test' }), /Being itself/);
  chmodSync(cache, 0o644); assert.match(sendAsAccount('kim@example.test', env), /mode 600/); chmodSync(cache, 0o600);
  assert.match(sendAsAccount('kim@example.test', { ...env, BEING_CACHE: cache }), /its own file/);
  writeFileSync(path.join(st, 'send-as.stop'), '');
  assert.match(sendAsAccount('kim@example.test', env), /paused/);
});

test('a send-as draft goes out only while approved, unchanged and fresh', () => {
  const now = Date.parse('2026-01-01T10:05:00Z');
  const d = { id: 'D3', kind: 'teams', chatId: 'c1', target: 'group chat "Ops"', re: '', text: 'Done.', as: 'kim@example.test',
    status: 'approved-as', approvedAt: '2026-01-01T10:00:00Z' };
  d.fingerprint = fingerprint(d);
  assert.equal(checkSendAsDraft(d, 'kim@example.test', now), null);
  assert.match(checkSendAsDraft({ ...d, status: 'pending' }, 'kim@example.test', now), /pending/);
  assert.match(checkSendAsDraft({ ...d, status: 'sent' }, 'kim@example.test', now), /sent/);
  assert.match(checkSendAsDraft(d, 'lee@example.test', now), /not for this account/);
  assert.match(checkSendAsDraft({ ...d, text: 'Done!' }, 'kim@example.test', now), /changed/);
  assert.match(checkSendAsDraft({ ...d, as: 'lee@example.test', fingerprint: d.fingerprint }, 'lee@example.test', now), /changed/);
  assert.match(checkSendAsDraft(d, 'kim@example.test', now + 11 * 60e3), /older than 10 minutes/);
  assert.match(checkSendAsDraft({ ...d, kind: 'mail' }, 'kim@example.test', now), /not a Teams draft/);
  assert.match(checkSendAsDraft(null, 'kim@example.test', now), /not a Teams draft/);
});

test('the account is part of the fingerprint and shown in the owner\'s prompt; plain drafts keep their fingerprint', () => {
  const base = { id: 'D3', kind: 'teams', chatId: 'c1', target: 't', re: '', text: 'x' };
  assert.notEqual(fingerprint({ ...base, as: 'kim@example.test' }), fingerprint(base));
  assert.equal(fingerprint({ ...base, as: '' }), fingerprint(base));
  const d = { ...base, as: 'kim@example.test' }; d.fingerprint = fingerprint(d);
  assert.match(renderPrompt(d, '<p>x</p>'), /reply as <b>kim@example\.test<\/b> \(not you\)/);
  assert.match(renderPrompt({ ...base, fingerprint: 'f' }, '<p>x</p>'), /reply as you/);
});
