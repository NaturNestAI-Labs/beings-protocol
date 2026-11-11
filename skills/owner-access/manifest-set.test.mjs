import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sealManifests, checkManifestSet, renderManifestSet, checkSetApproval } from './manifest-set.mjs';
import { checkGo, markUsed, usedGos, approvalAgeError } from './go-approval.mjs';

const address = (role) => [role, ['example', 'invalid'].join('.')].join(String.fromCharCode(64));
const now = Date.parse('2026-01-02T10:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'manifest-set-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const files = ['first', 'second', 'third'].map((batch) => {
    const f = path.join(dir, `${batch}.json`);
    writeFileSync(f, JSON.stringify({ batch, mailbox: address('shared'), created: '2026-01-02T08:00:00Z',
      rows: [{ id: batch, subject: batch, to: [address(batch)], cc: [address('copy')], attachment: '' }] }));
    return f;
  });
  const preview = { id: 'B1', ...sealManifests(files), approverId: 'approver', promptChatId: 'conversation' };
  const msg = { id: 'approval', from: { user: { id: 'approver' } }, body: { content: '<p>SEND</p>' }, createdDateTime: '2026-01-02T09:00:00Z' };
  const prompt = { from: { user: { id: 'being' } }, body: { content: renderManifestSet(preview) }, createdDateTime: '2026-01-02T08:30:00Z' };
  const args = { preview, prompt, msg, chat: { id: 'conversation', chatType: 'oneOnOne' },
    members: [{ userId: 'approver', email: address('approver') }, { userId: 'being', email: address('being') }],
    beingUpn: address('being'), approvers: new Set([address('approver')]), expect: 'SEND', notBefore: prompt.createdDateTime, now };
  const check = (a = args) => { const r = checkGo(a); if (r.error) throw new Error(r.error); checkSetApproval(a); return r; };
  return { dir, files, preview, args, check };
}

test('several manifests: one preview lists batches, counts, all recipients and total; SEND approves', (t) => {
  const { files, preview, check } = fixture(t);
  assert.equal(checkManifestSet(preview, [...files].reverse()).length, 3);
  const html = renderManifestSet(preview);
  assert.match(html, /3 batches, 3 mails total/);
  for (const e of preview.entries) {
    assert.ok(html.includes(`${e.manifest.batch}: 1 mails`));
    for (const r of e.manifest.rows) for (const a of [...r.to, ...r.cc]) assert.ok(html.includes(a));
  }
  assert.equal(check().approver, address('approver'));
});

test('tampered file bytes and changed, added or removed membership fail closed', (t) => {
  const { files, preview } = fixture(t);
  assert.throws(() => checkManifestSet(preview, files.slice(1)), /changed/);
  const extra = path.join(path.dirname(files[0]), 'extra.json');
  const m = structuredClone(preview.entries[0].manifest); m.batch = 'extra'; m.rows[0].id = 'extra';
  writeFileSync(extra, JSON.stringify(m));
  assert.throws(() => checkManifestSet(preview, [...files, extra]), /changed/);
  writeFileSync(files[0], JSON.stringify(preview.entries[0].manifest) + '\n');
  assert.throws(() => checkManifestSet(preview), /changed/);
});

for (const [name, mutate] of [
  ['wrong sender', (a) => { a.msg.from.user.id = 'stranger'; }],
  ['wrong chat', (a) => { a.chat.id = 'other'; }],
  ['group chat', (a) => { a.chat.chatType = 'group'; }],
  ['edited message', (a) => { a.msg.lastEditedDateTime = a.msg.createdDateTime; }],
  ['edited preview', (a) => { a.prompt.lastEditedDateTime = a.prompt.createdDateTime; }],
  ['modified preview', (a) => { a.prompt.body.content += ' extra'; }],
  ['lowercase send', (a) => { a.msg.body.content = 'send'; }],
  ['app sender', (a) => { a.msg.from.application = {}; }],
  ['replay', (a) => { a.used = new Set([a.msg.id]); }],
  ['expired at actual send time', (a) => { a.now += 24 * 3600e3; }],
  ['future approval', (a) => { a.now -= 2 * 3600e3; }],
]) test(name, (t) => {
  const { args, check } = fixture(t); mutate(args); assert.throws(() => check(args));
});

test('single use claim is atomic and also respects legacy consumed messages', (t) => {
  const { dir } = fixture(t);
  markUsed(dir, 'approval');
  assert.ok(usedGos(dir).has('approval'));
  assert.throws(() => markUsed(dir, 'approval'), /already used/);
});

test('scheduled send crossing 24h refuses, including at exactly the deadline', () => {
  const created = new Date(now).toISOString();
  assert.equal(approvalAgeError(created, now + 23 * 3600e3), null);
  assert.match(approvalAgeError(created, now + 24 * 3600e3), /actual send time.*fresh preview/);
  assert.match(approvalAgeError(created, now + 25 * 3600e3), /older than 24h/);
  assert.match(approvalAgeError('invalid', now), /invalid/);
});

test('legacy exact per-batch go remains supported', (t) => {
  const { args } = fixture(t);
  args.expect = 'go first 0123456789ab'; args.msg.body.content = args.expect;
  assert.equal(checkGo(args).approver, address('approver'));
  args.msg.body.content += ' extra'; assert.match(checkGo(args).error, /exactly/);
});

test('repointing a manifest symlink invalidates the seal even with identical bytes', (t) => {
  const { dir, files } = fixture(t);
  const link = path.join(dir, 'selected.json'), copy = path.join(dir, 'copy.json');
  symlinkSync(files[0], link);
  const preview = sealManifests([link]);
  writeFileSync(copy, JSON.stringify(preview.entries[0].manifest));
  unlinkSync(link); symlinkSync(copy, link);
  assert.throws(() => checkManifestSet(preview), /changed/);
});
