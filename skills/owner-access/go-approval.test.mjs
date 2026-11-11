import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkGo } from './go-approval.mjs';

const now = Date.parse('2026-01-02T10:00:00Z');
const base = () => ({
  msg: { id: 'm1', messageType: 'message', from: { user: { id: 'u-owner' } }, body: { content: '<p>go spring 1a2b3c4d5e6f</p>' }, createdDateTime: '2026-01-02T09:00:00Z' },
  chat: { id: 'c1', chatType: 'oneOnOne' },
  members: [{ userId: 'u-owner', email: 'owner@example.com' }, { userId: 'u-being', email: 'being@example.com' }],
  beingUpn: 'being@example.com', approvers: new Set(['owner@example.com']), expect: 'go spring 1a2b3c4d5e6f',
  notBefore: '2026-01-02T08:00:00Z', now,
});

test('a go typed by an approver, in their 1:1 with the Being, with the exact text, passes once', () => {
  assert.deepEqual(checkGo(base()), { approver: 'owner@example.com' });
  assert.match(checkGo({ ...base(), used: new Set(['m1']) }).error, /already used/);
});

test('refused: wrong text, wrong person, app, group chat, edited, too old, older than the batch', () => {
  const b = base();
  assert.match(checkGo({ ...b, expect: 'go spring 000000000000' }).error, /exactly/);
  assert.match(checkGo({ ...b, approvers: new Set(['someone@example.com']) }).error, /not an approver/);
  assert.match(checkGo({ ...b, msg: { ...b.msg, from: { application: { id: 'x' } } } }).error, /typed by a person/);
  assert.match(checkGo({ ...b, chat: { ...b.chat, chatType: 'group' } }).error, /1:1/);
  assert.match(checkGo({ ...b, msg: { ...b.msg, lastEditedDateTime: '2026-01-02T09:01:00Z' } }).error, /edited/);
  assert.match(checkGo({ ...b, now: now + 30 * 3600e3 }).error, /older than 24h/);
  assert.match(checkGo({ ...b, notBefore: '2026-01-02T09:30:00Z' }).error, /older than the batch/);
  assert.match(checkGo({ ...b, msg: { ...b.msg, from: { user: { id: 'u-being' } } } }).error, /posted by the Being/);
  assert.match(checkGo({ ...b, members: [b.members[0], { userId: 'u-x', email: 'x@example.com' }] }).error, /chat with the Being/);
});

test('a named area approver counts when listed', () => {
  const b = base();
  const r = checkGo({ ...b, members: [{ userId: 'u-l', email: 'lead@example.com' }, b.members[1]],
    msg: { ...b.msg, from: { user: { id: 'u-l' } } }, approvers: new Set(['owner@example.com', 'lead@example.com']) });
  assert.deepEqual(r, { approver: 'lead@example.com' });
});
