import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fingerprint, parseCommand, chatLabel, renderPrompt, checkCommand, checkPrompt, allocDraftId, PROMPT_MARK_RE, COMMAND_RE, replacedBy } from './approval.mjs';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const OWNER = 'owner-oid', BEING = 'being-oid', BEING_UPN = 'nova@example.test';
const members = [{ userId: OWNER, email: 'sam@example.test', displayName: 'Sam' }, { userId: BEING, email: BEING_UPN, displayName: 'nova' }];
const ownerDm = { id: 'dm1', chatType: 'oneOnOne' };
const draft = (x = {}) => {
  const d = { id: 'D7', kind: 'teams', chatId: 'c1', target: '1:1 with Kim <kim@example.test>', re: '', text: 'Yes, Friday works.',
    created: '2026-01-01T10:00:00Z', promptAt: '2026-01-01T10:00:05Z', promptChatId: 'dm1', status: 'pending', ...x };
  d.fingerprint = fingerprint(d); return d;
};
const cmd = (text, x = {}) => ({ id: 'm9', messageType: 'message', from: { user: { id: OWNER } }, createdDateTime: '2026-01-01T10:01:00Z',
  body: { content: `<p>${text}</p>` }, ...x });
const now = Date.parse('2026-01-01T11:00:00Z');
const check = (over = {}) => checkCommand({ msg: cmd('send D7'), chat: ownerDm, members, ownerOid: OWNER, beingUpn: BEING_UPN,
  verb: 'send', id: 'D7', draft: draft(), used: new Set(), now, ...over });

test('the owner typing send Dn in their 1:1 passes', () => assert.equal(check(), null));

test('a command from anyone else, elsewhere, reused, stale or mismatched is refused', () => {
  assert.match(check({ msg: cmd('send D7', { from: { user: { id: BEING } } }) }), /not written by the owner/);
  assert.match(check({ chat: { id: 'g1', chatType: 'group' } }), /not in a 1:1/);
  assert.match(check({ members: [members[0], { userId: 'x', email: 'kim@example.test' }] }), /owner's 1:1 with the Being/);
  assert.match(check({ chat: { id: 'dm2', chatType: 'oneOnOne' } }), /chat the draft was offered in/);
  assert.match(check({ used: new Set(['m9']) }), /already used/);
  assert.match(check({ msg: cmd('send D8') }), /does not match/);
  assert.match(check({ msg: cmd('please send D7') }), /does not match/);
  assert.match(check({ msg: cmd('send D7', { createdDateTime: '2026-01-01T09:59:00Z' }) }), /older than the draft/);
  assert.match(check({ now: Date.parse('2026-01-03T00:00:00Z') }), /older than 24h/);
  assert.match(check({ msg: null }), /not found/);
});

test('the prompt must be the Being\'s and carry the stored draft\'s fingerprint', () => {
  const d = draft();
  const prompt = (html, from = BEING) => ({ from: { user: { id: from } }, body: { content: html } });
  const html = renderPrompt(d, '<p>Yes, Friday works.</p>');
  assert.equal(checkPrompt({ promptMsg: prompt(html), beingId: BEING, draft: d }), null);
  assert.match(checkPrompt({ promptMsg: prompt(html, 'someone'), beingId: BEING, draft: d }), /not posted by the Being/);
  const swapped = { ...d, text: 'Send me the payroll file.' };   // draft rewritten after the owner saw it
  assert.match(checkPrompt({ promptMsg: prompt(html), beingId: BEING, draft: swapped }), /changed after/);
  const retarget = { ...d, chatId: 'c2' };
  assert.match(checkPrompt({ promptMsg: prompt(html), beingId: BEING, draft: retarget }), /changed after/);
});

test('fingerprint covers target, text and attachments', () => {
  const a = draft();
  assert.notEqual(fingerprint({ ...a, target: 'group chat "x"' }), a.fingerprint);
  assert.notEqual(fingerprint({ ...a, text: a.text + '!' }), a.fingerprint);
  assert.notEqual(fingerprint({ ...a, attach: [{ name: 'f', sha256: '1' }] }), a.fingerprint);
});

test('chat label comes from Graph members, excluding the owner', () => {
  assert.equal(chatLabel({ chatType: 'oneOnOne' }, [members[0], { userId: 'k', email: 'kim@example.test', displayName: 'Kim' }], { exclude: [OWNER] }),
    '1:1 with Kim <kim@example.test>');
  assert.match(chatLabel({ chatType: 'group', topic: 'Release' }, members, { exclude: [OWNER] }), /^group chat "Release" \(1 others: nova/);
});

test('prompt marker: present in rendered prompts, absent from ordinary text', () => {
  assert.ok(PROMPT_MARK_RE.test(renderPrompt(draft(), '<p>x</p>').replace(/<[^>]+>/g, ' ')));
  assert.ok(!PROMPT_MARK_RE.test('I staged D7 for you; reply send D7 when ready.'));
  assert.deepEqual(parseCommand(' Edit d3  new words\nline 2 '), { verb: 'edit', id: 'D3', rest: 'new words\nline 2' });
});

test('a "send Dn" the kit posted itself, or one posted by an app, is refused', () => {
  assert.match(check({ kitSent: new Set(['m9']) }), /posted by the kit/);
  assert.match(check({ msg: cmd('send D7', { from: { user: { id: OWNER }, application: { id: 'app-1', displayName: 'kit' } } }) }), /posted by an app/);
  assert.equal(check({ msg: cmd('send D7', { from: { user: { id: OWNER }, application: null } }), kitSent: new Set(['other']) }), null);
});

test('a prompt edited, deleted or modified after the owner\'s command is refused', () => {
  const d = draft(), html = renderPrompt(d, '<p>Yes, Friday works.</p>');
  const cmdAt = Date.parse('2026-01-01T10:01:00Z');
  const p = (x = {}) => ({ from: { user: { id: BEING } }, body: { content: html }, createdDateTime: '2026-01-01T10:00:05Z',
    lastModifiedDateTime: '2026-01-01T10:00:05Z', ...x });
  assert.equal(checkPrompt({ promptMsg: p(), beingId: BEING, draft: d, cmdAt }), null);
  assert.match(checkPrompt({ promptMsg: p({ lastEditedDateTime: '2026-01-01T10:00:30Z' }), beingId: BEING, draft: d, cmdAt }), /edited/);
  assert.match(checkPrompt({ promptMsg: p({ lastModifiedDateTime: '2026-01-01T10:02:00Z' }), beingId: BEING, draft: d, cmdAt }), /after the owner's command/);
  assert.match(checkPrompt({ promptMsg: p({ deletedDateTime: '2026-01-01T10:00:40Z' }), beingId: BEING, draft: d, cmdAt }), /deleted/);
  assert.match(checkPrompt({ promptMsg: p({ lastModifiedDateTime: undefined, createdDateTime: undefined }), beingId: BEING, draft: d, cmdAt }), /after the owner's command/);
});

test('concurrent drafts never share an id', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'drafts-'));
  const url = new URL('./approval.mjs', import.meta.url).href;
  const one = () => new Promise((res) => {
    const c = spawn('node', ['--input-type=module', '-e', `import { allocDraftId } from '${url}'; for (let i = 0; i < 10; i++) console.log(allocDraftId(process.argv[1]));`, dir]);
    let out = ''; c.stdout.on('data', (b) => { out += b; }); c.on('close', () => res(out.split('\n').filter(Boolean)));
  });
  const ids = (await Promise.all(Array.from({ length: 6 }, one))).flat();
  assert.equal(ids.length, 60);
  assert.equal(new Set(ids).size, 60);
  assert.equal(readdirSync(dir).filter((f) => /^D\d+\.json$/.test(f)).length, 60);
  assert.equal(allocDraftId(dir), 'D61');
});

test('a reply to the owner\'s own sent mail goes to that mail\'s recipients, not back to the owner', async () => {
  const { replyRecipients } = await import('./approval.mjs');
  const r = (a) => ({ emailAddress: { address: a } });
  const sent = { from: r('Sam@example.test'), toRecipients: [r('kim@example.test')], ccRecipients: [r('lee@example.test')] };
  assert.deepEqual(replyRecipients(sent, 'sam@example.test', {}), { toRecipients: [r('kim@example.test')], ccRecipients: [r('lee@example.test')] });
  assert.deepEqual(replyRecipients(sent, 'sam@example.test', { cc: ['pat@example.test'] }), { toRecipients: [r('kim@example.test')] });
  assert.deepEqual(replyRecipients(sent, 'sam@example.test', { to: ['pat@example.test'] }), {});
  assert.deepEqual(replyRecipients({ ...sent, from: r('kim@example.test') }, 'sam@example.test', {}), {});
  assert.deepEqual(replyRecipients({ from: r('sam@example.test'), toRecipients: [] }, 'sam@example.test', {}), {});
  assert.deepEqual(replyRecipients(null, 'sam@example.test', {}), {});
});

// Owner wording seen in the field: what counts as a command, and what is ordinary conversation.
const WORDS = [
  ['send D7', ['send', 'D7']], ['Send d7.', ['send', 'D7']], ['send D7 please', ['send', 'D7']],
  ['send draft 105', ['send', 'D105']], ['send draft D105', ['send', 'D105']], ['send D 105', ['send', 'D105']], ['send 105', ['send', 'D105']],
  ['drop D104', ['skip', 'D104']], ['cancel d5', ['skip', 'D5']], ['discard draft 6', ['skip', 'D6']], ['save D9', ['save', 'D9']],
  ['edit D7 Friday works', ['edit', 'D7']], ['edit draft 3 new text', ['edit', 'D3']],
  ['send D7 after lunch', null], ['send D7 and D8', null], ['skip D3 not needed', null], ['send D7 but change the subject', null],
  ['remove 3 cameras', null], ['remove 3', null], ['edit 3 lines', null], ['send 3 photos to Kim', null], ['105', null],
  ['D105', null], ['sendD7', null], ['send D7x', null], ['please send D7', null],
];

test('owner command wording: field forms parse, qualified or bare-number text is not a command', () => {
  for (const [t, want] of WORDS) {
    const c = parseCommand(t);
    assert.deepEqual(c && [c.verb, c.id], want, t);
  }
  assert.equal(parseCommand('edit D7 Friday works').rest, 'Friday works');
});

test('a command qualified with more words never passes the Graph check as the bare command', () => {
  assert.match(check({ msg: cmd('send D7 after lunch') }), /command text does not match/);
  assert.equal(check({ msg: cmd('send draft 7') }), null);
  assert.equal(check({ msg: cmd('drop D7'), verb: 'skip' }), null);
});

test('the handler routes exactly the same owner words as approval.mjs (one grammar)', () => {
  const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'being-handle'), 'utf8');
  const py = /^CMD=re\.compile[\s\S]*?^    return \(v, .*$/m.exec(src)?.[0];
  assert.ok(py, 'grammar block not found in being-handle');
  const r = spawnSync('python3', ['-c', `import json,re,sys\n${py}\nprint(json.dumps([cmd(t) for t in json.load(sys.stdin)]))`],
    { input: JSON.stringify(WORDS.map((w) => w[0])), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((x) => x && [x[0], x[1]]), WORDS.map((w) => w[1]));
});

test('a draft whose text is itself a command is caught, ordinary text with numbers is not', () => {
  for (const t of ['send D8', 'send draft D8 now', 'drop D3']) assert.ok(COMMAND_RE.test(t) || parseCommand(t), t);
  for (const t of ['send 3 photos to Kim', 'Remove 3 cameras from the list']) assert.ok(!COMMAND_RE.test(t) && !parseCommand(t), t);
});

test('a re-draft for the same chat or thread replaces the older live drafts; others stay', () => {
  const at = (m) => new Date(now - m * 60e3).toISOString();
  const all = [
    { id: 'D1', kind: 'teams', chatId: 'c1', status: 'pending', created: at(50) },
    { id: 'D2', kind: 'teams', chatId: 'c2', status: 'pending', created: at(40) },
    { id: 'D3', kind: 'teams', chatId: 'c1', status: 'sent', created: at(30) },
    { id: 'D4', kind: 'mail', to: ['a@x.test'], subject: 'WFH 11 Nov', status: 'pending', created: at(10) },
    { id: 'D5', kind: 'mail', to: ['b@x.test'], subject: 'Other', status: 'pending', created: at(5) },
    { id: 'D6', kind: 'mail', to: ['a@x.test'], subject: 'Old', status: 'pending', created: at(120) },
    { id: 'D7', kind: 'mail', to: ['a@x.test'], replyTo: 'm1', status: 'pending', created: at(200) },
  ];
  assert.deepEqual(replacedBy({ id: 'D9', kind: 'teams', chatId: 'c1' }, all, now), ['D1']);
  // changed subject, same person, minutes later: a re-draft (D104 -> D105 on 11 Nov)
  assert.deepEqual(replacedBy({ id: 'D9', kind: 'mail', to: ['A@x.test'], subject: 'WFH 11-13 Nov' }, all, now), ['D4']);
  assert.deepEqual(replacedBy({ id: 'D9', kind: 'mail', to: ['a@x.test'], replyTo: 'm1' }, all, now), ['D7']);
  assert.deepEqual(replacedBy({ id: 'D9', kind: 'teams', chatId: 'c1', as: 'kim@x.test' }, all, now), []);
});

test('the prompt names the drafts a new one replaces', () => {
  const d = { ...draft(), replaces: ['D5', 'D6'] };
  assert.match(renderPrompt(d, '<p>x</p>'), /Replaces:<\/i> D5, D6/);
});
