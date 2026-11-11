#!/usr/bin/env node
// Read-only shared inbox monitor: lists mail since a date through the owner's session (GET only, never marks read),
// and diffs it against the ids already seen. Usage: README.md "Shared inbox monitor".
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const plain = (html) => String(html || '').replace(/<(style|head|script)\b[\s\S]*?<\/\1>/gi, '')
  .replace(/<br\s*\/?>|<\/(p|div|tr)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n\s*\n+/g, '\n').trim();
// Keeps what a classifier needs; body capped so files stay small.
export const slim = (m, folder) => ({
  id: m.id, folder, received: m.receivedDateTime, from: String(m.from?.emailAddress?.address || '').toLowerCase(),
  fromName: m.from?.emailAddress?.name || '', to: (m.toRecipients || []).map((r) => String(r.emailAddress?.address || '').toLowerCase()),
  subject: m.subject || '', conversationId: m.conversationId, text: plain(m.body?.content).slice(0, 4000),
});
export const newOnly = (scan, seenText) => { const seen = new Set(String(seenText).split(/\s+/).filter(Boolean)); return scan.filter((m) => !seen.has(m.id)); };

async function main() {
  const { positionals: [cmd], values: o } = parseArgs({ allowPositionals: true, options: {
    since: { type: 'string' }, out: { type: 'string' }, folders: { type: 'string' }, scan: { type: 'string' }, seen: { type: 'string' }, new: { type: 'string' } } });
  if (cmd === 'diff') {   // local only: no sign-in
    if (!o.scan || !o.seen || !o.new) throw new Error('diff needs --scan --seen --new');
    const fresh = newOnly(JSON.parse(readFileSync(o.scan, 'utf8')), existsSync(o.seen) ? readFileSync(o.seen, 'utf8') : '');
    writeFileSync(o.new, JSON.stringify(fresh, null, 1), { mode: 0o600 });
    console.log(fresh.length);
    return;
  }
  if (cmd === 'mark') {
    if (!o.new || !o.seen) throw new Error('mark needs --new --seen');
    const ids = JSON.parse(readFileSync(o.new, 'utf8')).map((m) => m.id);
    if (ids.length) appendFileSync(o.seen, ids.join('\n') + '\n', { mode: 0o600 });
    return;
  }
  if (cmd !== 'scan') throw new Error('usage: shared-inbox-monitor.mjs scan --since <iso> --out f.json [--folders inbox,junkemail] | diff --scan f --seen seen.txt --new new.json | mark --new new.json --seen seen.txt');
  const since = new Date(o.since || '');
  if (Number.isNaN(since.getTime()) || !o.out) throw new Error('scan needs --since <iso> and --out');
  await import('./oa-env.mjs');
  const { openOwnerAccess } = await import('./owner-session.mjs');
  const { inboxReadRoute, guardedGraph } = await import('./guards.mjs');
  const { s, owner } = await openOwnerAccess('shared_mailbox_read', { services: ['outlook'], ownerScopes: { outlook: ['Mail.Read.Shared'] } });
  const box = s.cfg.shared_mailbox || {};
  const mailbox = String(box.address || '').toLowerCase();
  if (!mailbox) throw new Error('set [shared_mailbox] address in owner-access.toml');
  const folders = (o.folders ? o.folders.split(',') : box.folders || ['inbox', 'junkemail']).map((f) => f.trim()).filter(Boolean);
  const g = guardedGraph(owner.outlook.token, (url, method) => inboxReadRoute(mailbox, url, method, folders));
  const out = [];
  for (const f of folders) {
    const q = new URLSearchParams({ $filter: `receivedDateTime ge ${since.toISOString()}`, $orderby: 'receivedDateTime asc', $top: '50',
      $select: 'id,receivedDateTime,from,toRecipients,subject,conversationId,body' });
    let url = `/users/${encodeURIComponent(mailbox)}/mailFolders/${encodeURIComponent(f)}/messages?${q}`;
    while (url) { const p = await g(url, { headers: { Prefer: 'IdType="ImmutableId"' } }); out.push(...(p.value || []).map((m) => slim(m, f))); url = p['@odata.nextLink']; }
  }
  writeFileSync(o.out, JSON.stringify(out, null, 1), { mode: 0o600 });
  console.log(`messages=${out.length}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(`shared-inbox-monitor: ${e.message}`); process.exit(1); });
}
