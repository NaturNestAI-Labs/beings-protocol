import { test } from 'node:test';
import assert from 'node:assert/strict';
import { routeFor, toOutlook, camelize, pascalize, pickOutlookToken, outlookCall, postText, channelLink } from './browser-route.mjs';
import { browserTarget } from './channel-lib.mjs';
import { draftsRoute, sharePointRoute, teamsWebAllowed, guardedGraph, OUTLOOK_API } from './guards.mjs';

test('route: default graph; section route; per-ability override; anything else is refused', () => {
  assert.equal(routeFor({}, 'shared_mailbox_drafts'), 'graph');
  assert.equal(routeFor({ shared_mailbox: { route: 'browser' } }, 'shared_mailbox_send'), 'browser');
  assert.equal(routeFor({ shared_mailbox: { route: 'browser' }, routes: { shared_mailbox_send: 'graph' } }, 'shared_mailbox_send'), 'graph');
  assert.equal(routeFor({ channel_posts: { route: 'browser' } }, 'channel_posts'), 'browser');
  assert.throws(() => routeFor({ channel_posts: { route: 'Browser' } }, 'channel_posts'), /must be "graph" or "browser"/);
  assert.throws(() => routeFor({}, 'owner_files'), /no browser route/);
});

test('Outlook REST mapping: same paths, PascalCase fields in queries and bodies, camelCase back', () => {
  const u = toOutlook("/users/a%40example.com/mailFolders/sentitems/messages?$select=subject,toRecipients&$orderby=sentDateTime desc&$filter=from/emailAddress/address eq 'x y'&$top=100&$skip=0");
  assert.ok(u.startsWith(`${OUTLOOK_API}/users/a%40example.com/mailFolders/sentitems/messages?`));
  const q = new URL(u).searchParams;
  assert.equal(q.get('$select'), 'Subject,ToRecipients');
  assert.equal(q.get('$orderby'), 'SentDateTime desc');
  assert.equal(q.get('$filter'), "From/EmailAddress/Address eq 'x y'");
  assert.equal(q.get('$top'), '100');
  assert.equal(toOutlook(`${OUTLOOK_API}/me`), `${OUTLOOK_API}/me`);
  const b = pascalize({ subject: 's', toRecipients: [{ emailAddress: { address: 'a@example.com' } }],
    attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name: 'f.pdf', contentBytes: 'AA==' }] });
  assert.deepEqual(b.ToRecipients, [{ EmailAddress: { Address: 'a@example.com' } }]);
  assert.equal(b.Attachments[0]['@odata.type'], '#Microsoft.OutlookServices.FileAttachment');
  assert.deepEqual(camelize({ Id: '1', IsDraft: true, From: { EmailAddress: { Address: 'x' } }, '@odata.nextLink': 'n' }),
    { id: '1', isDraft: true, from: { emailAddress: { address: 'x' } }, '@odata.nextLink': 'n' });
});

test('outlookCall keeps Graph shapes and still goes through the guard', async () => {
  const seen = [];
  const guarded = guardedGraph('t', (url, method) => draftsRoute('team@example.com', url, method, { base: OUTLOOK_API }),
    async (url, init) => { seen.push([url, init.method, init.body]); return new Response(JSON.stringify({ Id: 'N1', IsDraft: true })); }, OUTLOOK_API);
  const call = outlookCall(guarded);
  const r = await call('/users/team%40example.com/messages', { method: 'POST', body: { subject: 'Hi' } });
  assert.deepEqual(r, { id: 'N1', isDraft: true });
  assert.equal(JSON.parse(seen[0][2]).Subject, 'Hi');
  assert.equal((await call('/me')).id, 'N1');
  await assert.rejects(call('/users/team%40example.com/messages/N1', { method: 'DELETE' }), /allowlist/);
  await assert.rejects(call('/users/other%40example.com/messages', { method: 'POST', body: {} }), /allowlist/);
  await assert.rejects(call('/users/team%40example.com/messages/N1/send', { method: 'POST' }), /allowlist/);
  assert.equal(seen.length, 2);
});

test('Outlook web token: newest unexpired token for outlook with the scope; others ignored', () => {
  const now = 1_700_000_000_000, exp = (m) => String(Math.floor(now / 1000) + m * 60);
  const e = (target, secret, m = 30) => ['x-accesstoken-y', JSON.stringify({ target, secret, expiresOn: exp(m) })];
  const entries = [
    e('https://graph.microsoft.com/Mail.ReadWrite.Shared', 'graph'),
    e('https://outlook.office.com/Mail.Read', 'narrow'),
    e('https://outlook.office.com/Mail.ReadWrite.Shared https://outlook.office.com/User.Read', 'old', 10),
    e('https://outlook.office.com/Mail.ReadWrite.Shared', 'new', 50),
    e('https://outlook.office.com/Mail.ReadWrite.Shared', 'expired', -5),
    ['refreshtoken', '{"secret":"r"}'], ['x-accesstoken-z', 'not json'],
  ];
  assert.equal(pickOutlookToken(entries, 'Mail.ReadWrite.Shared', now), 'new');
  assert.equal(pickOutlookToken(entries.slice(0, 2), 'Mail.ReadWrite.Shared', now), null);
});

test('browser drafts allowlist (Outlook REST): own drafts, approved sends, who-am-I; no delete, move or other mailbox', () => {
  const R = `${OUTLOOK_API}/users/team%40example.com`, o = { base: OUTLOOK_API, own: new Set(['A']), sendIds: new Set(['A']) };
  assert.ok(draftsRoute('team@example.com', `${R}/messages`, 'POST', o));
  assert.ok(draftsRoute('team@example.com', `${R}/messages/A/send`, 'POST', o));
  assert.ok(draftsRoute('team@example.com', `${OUTLOOK_API}/me`, 'GET', o));
  assert.ok(!draftsRoute('team@example.com', `${R}/messages/A`, 'DELETE', o));
  assert.ok(!draftsRoute('team@example.com', `${R}/messages/A/move`, 'POST', o));
  assert.ok(!draftsRoute('team@example.com', `${R}/messages/B/send`, 'POST', o));
  assert.ok(!draftsRoute('team@example.com', `https://graph.microsoft.com/v1.0/users/team%40example.com/messages`, 'POST', o));
  assert.ok(!draftsRoute('team@example.com', `${R}/messages`, 'POST', { own: o.own }), 'Outlook URL with the Graph allowlist');
});

test('SharePoint allowlist (browser channel route): the allowed folder only', () => {
  const t = { site: 'https://org.sharepoint.com/sites/team', folder: '/sites/team/Shared Documents/General' };
  const A = `${t.site}/_api/`, q = (p) => encodeURIComponent(`'${p}'`);
  const sub = '/sites/team/Shared Documents/General/batch';
  assert.ok(sharePointRoute(t, `${A}contextinfo`, 'POST'));
  assert.ok(sharePointRoute(t, `${A}web/currentuser?$select=Email`, 'GET'));
  assert.ok(sharePointRoute(t, `${A}web/GetFolderByServerRelativeUrl(${q(sub)})/Files/add(url=${q('a.pdf')},overwrite=false)`, 'POST'));
  assert.ok(!sharePointRoute(t, `${A}web/GetFolderByServerRelativeUrl(${q(sub)})/Files/add(url=${q('a.pdf')},overwrite=true)`, 'POST'));
  assert.ok(!sharePointRoute(t, `${A}web/GetFolderByServerRelativeUrl(${q('/sites/team/Shared Documents/Other')})/Files/add(url=${q('a.pdf')},overwrite=false)`, 'POST'));
  assert.ok(!sharePointRoute(t, `${A}web/GetFolderByServerRelativeUrl(${q(`${sub}/../../Other`)})/Files/add(url=${q('a.pdf')},overwrite=false)`, 'POST'));
  assert.ok(!sharePointRoute(t, `${A}web/GetFolderByServerRelativeUrl(${q(sub)})/Files/add(url=${q('../a.pdf')},overwrite=false)`, 'POST'));
  assert.ok(sharePointRoute(t, `${A}web/GetFileByServerRelativeUrl(${q(`${sub}/a.pdf`)})/$value`, 'GET'));
  assert.ok(!sharePointRoute(t, `${A}web/GetFileByServerRelativeUrl(${q(`${sub}/a.pdf`)})/recycle`, 'POST'));
  assert.ok(!sharePointRoute(t, `${A}web/GetFileByServerRelativeUrl(${q(`${sub}/a.pdf`)})`, 'DELETE'));
  assert.ok(!sharePointRoute(t, `${A}web/GetFileByServerRelativeUrl(${q('/sites/team/Shared Documents/x.pdf')})/$value`, 'GET'));
  assert.ok(sharePointRoute(t, `${A}web/folders`, 'POST', JSON.stringify({ ServerRelativeUrl: sub })));
  assert.ok(!sharePointRoute(t, `${A}web/folders`, 'POST', JSON.stringify({ ServerRelativeUrl: '/sites/team/Other' })));
  assert.ok(!sharePointRoute(t, `https://org.sharepoint.com/sites/other/_api/contextinfo`, 'POST'));
  assert.ok(!sharePointRoute(t, `${A}web/lists`, 'GET'));
});

test('Teams web allowlist: posts only into the batch channel; no deletes or edits; mail actions refused', () => {
  const ch = '19:abc@thread.tacv2', o = { channel: ch };
  const conv = (id) => `https://teams.microsoft.com/api/chatsvc/emea/v1/users/ME/conversations/${encodeURIComponent(id)}/messages`;
  assert.ok(teamsWebAllowed('GET', 'https://teams.microsoft.com/v2/', o));
  assert.ok(teamsWebAllowed('POST', conv(ch), o));
  assert.ok(!teamsWebAllowed('POST', conv('19:other@thread.v2'), o));
  assert.ok(!teamsWebAllowed('PUT', `${conv(ch)}/123`, o));
  assert.ok(!teamsWebAllowed('DELETE', `${conv(ch)}/123`, o));
  assert.ok(!teamsWebAllowed('PATCH', 'https://teams.microsoft.com/x', o));
  assert.ok(!teamsWebAllowed('POST', 'https://outlook.office.com/owa/service.svc?action=SendItem', o));
});

test('channel browser target and post text', () => {
  const allowed = ['https://org.sharepoint.com/sites/team/Shared Documents/General'];
  assert.deepEqual(browserTarget({ browser_folder: `${allowed[0]}/` }, allowed), { site: 'https://org.sharepoint.com/sites/team', folder: '/sites/team/Shared Documents/General' });
  assert.throws(() => browserTarget({}, allowed), /needs browser_folder/);
  assert.throws(() => browserTarget({ browser_folder: 'https://org.sharepoint.com/sites/team/Shared Documents/Other' }, allowed), /not in/);
  assert.throws(() => browserTarget({ browser_folder: 'https://org.sharepoint.com/sites/team' }, ['https://org.sharepoint.com/sites/team']), /inside the site/);
  assert.equal(postText({ body_html: '<p>Hello &amp; welcome</p><p>Two</p>' }, [{ name: 'a.pdf', url: 'https://org.sharepoint.com/a.pdf' }]),
    'Hello & welcome\nTwo\n\nFiles:\na.pdf: https://org.sharepoint.com/a.pdf');
  assert.match(channelLink('T1', '19:abc@thread.tacv2'), /^https:\/\/teams\.microsoft\.com\/l\/channel\/19%3Aabc%40thread\.tacv2\/channel\?groupId=T1$/);
});
