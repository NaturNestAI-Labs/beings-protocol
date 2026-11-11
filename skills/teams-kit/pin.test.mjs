// Pinning and document detection (Graph mocked): a pin failure is reported, never thrown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hasDocument, isOwnerDm, missingPinScope, pinMessage, pinnedIds } from './pin.mjs';

const jwt = (scp) => ['e30', Buffer.from(JSON.stringify({ scp })).toString('base64url'), 'sig'].join('.');
const TOK = jwt('Chat.ReadWrite ChatMessage.Send User.Read');
const CHAT = '19:a_b@unq.gbl.spaces';

test('document links and attachments are detected; ordinary updates are not', () => {
  for (const h of ['<a href="https://example-my.sharepoint.com/:b:/g/personal/x/EaBc?e=1">Plan</a>', '<a href="https://onedrive.live.com/?id=1">file</a>',
    '<a href="https://www.notion.so/Setup-guide-27f1abc">guide</a>', 'attached: budget-2026.xlsx', '<code>out/report.pdf</code>', 'see spec.docx.'])
    assert.ok(hasDocument(h), h);
  assert.ok(hasDocument('<p>here</p>', { attachUrl: 'https://x/y' }));
  for (const h of ['<p>Deployed #232; 14/14 tests pass.</p>', 'PR: <a href="https://github.com/o/r/pull/149">#149</a>', 'docs in README.md', 'the .pdfx thing'])
    assert.ok(!hasDocument(h), h);
});

test('only the owner\'s 1:1 counts as the owner DM', () => {
  const m = [{ email: 'Owner@example.test' }, { email: 'being@example.test' }];
  assert.ok(isOwnerDm({ chatType: 'oneOnOne' }, m, 'owner@example.test'));
  assert.ok(!isOwnerDm({ chatType: 'group' }, m, 'owner@example.test'));
  assert.ok(!isOwnerDm({ chatType: 'oneOnOne' }, m, ''));
});

test('pin posts the message bind; failures and missing scopes come back as results', async () => {
  let call;
  assert.deepEqual(await pinMessage(async (url, opts) => { call = { url, opts }; return { ok: true, status: 201, text: async () => '' }; }, TOK, CHAT, '1791'), { ok: true, status: 201 });
  assert.equal(call.url, `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(CHAT)}/pinnedMessages`);
  assert.deepEqual(JSON.parse(call.opts.body), { 'message@odata.bind': `https://graph.microsoft.com/v1.0/chats/${CHAT}/messages/1791` });
  assert.equal((await pinMessage(async () => ({ ok: false, status: 403, text: async () => 'Forbidden' }), TOK, CHAT, '1')).status, 403);
  assert.match((await pinMessage(async () => { throw new Error('ECONNRESET'); }, TOK, CHAT, '1')).error, /ECONNRESET/);
  let called = false;
  assert.match((await pinMessage(async () => { called = true; }, jwt('User.Read'), CHAT, '1')).error, /ChatMessage\.Send or Chat\.ReadWrite/);
  assert.equal(called, false);
  assert.equal(missingPinScope('opaque'), null);
});

test('pinnedIds lists pinned message ids, null when unreadable', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ value: [{ message: { id: 'a' } }, { message: {} }] }) });
  assert.deepEqual(await pinnedIds(ok, TOK, CHAT), ['a']);
  assert.equal(await pinnedIds(async () => ({ ok: false }), TOK, CHAT), null);
  assert.equal(await pinnedIds(async () => { throw new Error('x'); }, TOK, CHAT), null);
});
