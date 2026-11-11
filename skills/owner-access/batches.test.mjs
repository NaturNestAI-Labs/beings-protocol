import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDraft, validateManifest, preflightProblems, matchOwn, draftKey } from './mailbox-lib.mjs';
import { validateChannelManifest, channelPlan, batchFingerprint, messageBody, etagGuid, safeName } from './channel-lib.mjs';
import { newOnly, slim } from './shared-inbox-monitor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('draft input rows: recipients checked, text bodies escaped', () => {
  const d = normalizeDraft({ to: 'A@example.com; b@example.com', subject: ' Hi ', body_text: '<b>x</b>\nline' });
  assert.deepEqual(d.to, ['a@example.com', 'b@example.com']);
  assert.equal(d.subject, 'Hi');
  assert.match(d.html, /&lt;b&gt;x&lt;\/b&gt;<br>line/);
  assert.throws(() => normalizeDraft({ to: 'not-an-address', subject: 's', body_text: 'x' }), /not an email/);
  assert.throws(() => normalizeDraft({ to: 'a@example.com', body_text: 'x' }), /subject/);
  assert.equal(draftKey('S', ['b@x.com', 'A@x.com']), draftKey('S', ['a@x.com', 'b@x.com']));
  assert.equal(matchOwn([{ id: '1', subject: 'S', to: ['a@x.com'] }, { id: '2', subject: 'S', to: ['b@x.com'] }], { subject: 'S', to: ['a@x.com'] }).length, 1);
});

test('mail manifest and preflight', () => {
  const row = { id: 'D1', to: ['a@example.com'], cc: ['c@example.com'], subject: 'S', attachment: 'deck.pdf' };
  const m = { batch: 'b1', mailbox: 'team@example.com', created: '2026-01-01T00:00:00Z', rows: [row] };
  assert.equal(validateManifest(m), m);
  assert.throws(() => validateManifest({ ...m, rows: [row, row] }), /duplicate/);
  assert.throws(() => validateManifest({ ...m, batch: 'a b' }), /batch/);
  const msg = { isDraft: true, parentFolderId: 'DR', from: { emailAddress: { address: 'team@example.com' } }, subject: 'S',
    toRecipients: [{ emailAddress: { address: 'a@example.com' } }], ccRecipients: [{ emailAddress: { address: 'c@example.com' } }] };
  assert.deepEqual(preflightProblems(row, msg, [{ name: 'deck.pdf' }], 'DR', 'team@example.com'), []);
  assert.deepEqual(preflightProblems(row, null, [], 'DR', 'team@example.com'), ['not in Drafts']);
  const p = preflightProblems(row, { ...msg, isDraft: false, ccRecipients: [] }, [], 'DR', 'team@example.com');
  assert.deepEqual(p, ['not a draft', 'CC missing', 'attachment deck.pdf missing']);
  assert.deepEqual(preflightProblems({ ...row, attachment: '' }, msg, [{ name: 'x', isInline: false }], 'DR', 'team@example.com'), ['has an attachment (manifest expects none)']);
});

test('channel manifest: allowed channel only, absolute unique files, safe names; fingerprint covers file bytes', () => {
  const m = { batch: 'docs', team: 'T1', channel: 'C1', created: '2026-01-01T00:00:00Z',
    posts: [{ title: 'One', body_text: 'hello', files: ['/x/a.pdf'] }, { title: 'Two', body_html: '<p>x</p>' }] };
  assert.throws(() => validateChannelManifest(m, []), /not in \[channel_posts\] allowed/);
  const v = validateChannelManifest(m, ['t1/c1']);
  assert.equal(v.folder, 'docs');
  assert.throws(() => validateChannelManifest({ ...m, posts: [{ title: 'A', body_text: 'x', files: ['rel.pdf'] }] }, ['T1/C1']), /absolute/);
  assert.throws(() => validateChannelManifest({ ...m, posts: [m.posts[0], { ...m.posts[0], title: 'B' }] }, ['T1/C1']), /used twice/);
  assert.throws(() => validateChannelManifest({ ...m, posts: [m.posts[0], { ...m.posts[0] }] }, ['T1/C1']), /duplicate title/);
  assert.throws(() => safeName('..'), /unsafe/);
  assert.equal(safeName('a/b:c.pdf'), 'a-b-c.pdf');
  const plan = channelPlan(v, { '/x/a.pdf': 'h1' });
  assert.deepEqual(plan.operations.map((o) => o.kind), ['file', 'post', 'post']);
  assert.notEqual(batchFingerprint(v, { '/x/a.pdf': 'h1' }), batchFingerprint(v, { '/x/a.pdf': 'h2' }));
  const body = messageBody(v.posts[0], [{ name: 'a.pdf', eTag: '"{0A1B2C3D-0000-1111-2222-333344445555},1"', webUrl: 'https://org.sharepoint.com/a.pdf' }]);
  assert.equal(body.attachments[0].id, '0A1B2C3D-0000-1111-2222-333344445555');
  assert.match(body.body.content, /<attachment id="0A1B2C3D-0000-1111-2222-333344445555"><\/attachment>$/);
  assert.equal(etagGuid('nope'), null);
});

test('inbox monitor: only unseen ids are new; bodies are trimmed to text', () => {
  assert.deepEqual(newOnly([{ id: 'a' }, { id: 'b' }], 'a\n').map((m) => m.id), ['b']);
  const s = slim({ id: 'x', from: { emailAddress: { address: 'A@Example.com' } }, body: { content: '<p>Hi<br>there</p><style>x</style>' } }, 'inbox');
  assert.equal(s.from, 'a@example.com');
  assert.equal(s.text, 'Hi\nthere');
});

test('verify-upload.py: same Office package passes, SharePoint metadata is allowed, real changes fail', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'oa-vu-'));
  const mk = `import sys, zipfile
def w(p, parts):
    with zipfile.ZipFile(p, 'w') as z:
        for k, v in parts.items(): z.writestr(k, v)
base = {'[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', 'word/document.xml': '<d>hello</d>'}
w(sys.argv[1] + '/a.docx', base)
w(sys.argv[1] + '/b.docx', {**base, 'customXml/item1.xml': '<x/>'})
w(sys.argv[1] + '/c.docx', {**base, 'word/document.xml': '<d>changed</d>'})
`;
  writeFileSync(path.join(d, 'mk.py'), mk);
  assert.equal(spawnSync('python3', ['-I', path.join(d, 'mk.py'), d]).status, 0);
  const run = (b) => spawnSync('python3', ['-I', path.join(HERE, 'verify-upload.py'), path.join(d, 'a.docx'), path.join(d, b)], { encoding: 'utf8' });
  assert.equal(run('b.docx').status, 0);
  const bad = run('c.docx');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /word\/document\.xml/);
});
