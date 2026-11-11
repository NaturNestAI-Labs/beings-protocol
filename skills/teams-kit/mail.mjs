#!/usr/bin/env node
// The Being's own mailbox (owner-mail reuses it read-only for the owner). Mail is never auto-answered.
// Usage: README.md "Script reference".
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import { connect, need, fail, strip, standby, beingSender } from './graph.mjs';
import { logComms } from './comms-log.mjs';
import { currentScope } from './scope.mjs';
import { mailCache, kitEnv } from './kit-env.mjs';
import { findSecrets, findSecretsInFiles } from './secrets.mjs';

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i === -1 ? null : (args[i + 1] ?? ''); };
const has = (f) => args.includes(f);
const UPN = need('BEING_UPN').toLowerCase();
// --mailbox <upn>: read a shared mailbox this sign-in has delegate access to. Read paths only, owner lane only,
// and only mailboxes listed in BEING_SHARED_MAILBOXES (kit .env on disk; empty = off).
const MBX = (opt('--mailbox') || '').toLowerCase();
if (has('--mailbox')) {
  if (!MBX) fail('--mailbox needs a mailbox address', 2);
  if (has('--send') || has('--detect')) fail('--mailbox is read-only (no --send or --detect)', 2);
  const listed = String(kitEnv().BEING_SHARED_MAILBOXES || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!listed.includes(MBX)) fail(`blocked: ${MBX} is not in BEING_SHARED_MAILBOXES`, 3);
  const { scope, why } = currentScope();
  if (why !== 'grant' || !(['full', 'owner-only'].includes(scope) || scope.startsWith('routine:'))) fail('blocked: only owner-lane runs may read a shared mailbox', 3);
}
const BOX = MBX ? `/users/${encodeURIComponent(MBX)}` : '/me';
if (has('--send') && standby()) fail('standby host: sending disabled', 3);
if (has('--send') && process.env.BEING_READ_ONLY) fail('read-only mailbox view', 2);
// owner-mail reuses this file read-only with the owner's cache; sending is the Being's only.
if (has('--send')) beingSender();
const { g } = await connect({ upn: UPN, sender: has('--send'), cache: mailCache('being', process.env) || need('BEING_CACHE'),
  scopes: has('--send') ? ['Mail.ReadWrite', 'Mail.Send', 'User.Read'] : MBX ? ['Mail.Read.Shared', 'User.Read'] : ['Mail.Read', 'User.Read'] });
const addr = (r) => r?.emailAddress?.address || '';
const SEL = '$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,isRead,bodyPreview,hasAttachments';
const top = parseInt(opt('--top') || '15', 10);

// Chunked upload of one large attachment to a draft; chunks are multiples of 320 KiB, read from disk one at a time.
async function uploadAttachment(msgId, f) {
  const size = statSync(f).size, CH = 10 * 327680, buf = Buffer.alloc(CH), fd = openSync(f, 'r');
  try {
    const { uploadUrl } = await g(`/me/messages/${msgId}/attachments/createUploadSession`,
      { body: { AttachmentItem: { attachmentType: 'file', name: path.basename(f), size } } });
    for (let at = 0; at < size; at += CH) {
      const n = readSync(fd, buf, 0, Math.min(CH, size - at), at);
      let r;
      for (let t = 1; ; t++) {   // transient 5xx/network errors are retried; anything else stops the send
        r = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes ${at}-${at + n - 1}/${size}`, 'Content-Length': String(n) }, body: buf.subarray(0, n) })
          .catch((e) => ({ ok: false, status: 0, text: async () => String(e.message) }));
        if (r.ok || (r.status && r.status < 500) || t === 4) break;
        await new Promise((res) => setTimeout(res, 2000 * t));
      }
      if (!r.ok) throw new Error(`upload of ${path.basename(f)} failed: ${r.status} ${(await r.text()).slice(0, 160)}`);
    }
  } finally { closeSync(fd); }
}

try {
  if (has('--list')) {
    const r = await g(`${BOX}/mailFolders/inbox/messages?$top=${top}&$orderby=receivedDateTime desc&${SEL}${has('--unread') ? '&$filter=isRead eq false' : ''}`);
    for (const m of r.value) console.log(`${m.receivedDateTime}  ${m.isRead ? ' ' : '●'} ${addr(m.from).padEnd(34)} ${m.subject}\n    ${m.id}`);
  } else if (opt('--search')) {
    const r = await g(`${BOX}/messages?$search=${encodeURIComponent('"' + opt('--search').replace(/"/g, '') + '"')}&$top=${top}&${SEL}`);
    for (const m of r.value) console.log(`${m.receivedDateTime}  ${addr(m.from).padEnd(34)} ${m.subject}\n    ${m.id}`);
  } else if (opt('--read')) {
    const m = await g(`${BOX}/messages/${encodeURIComponent(opt('--read'))}?${SEL},body`);
    console.log(`From: ${addr(m.from)}\nTo: ${m.toRecipients.map(addr).join(', ')}\nDate: ${m.receivedDateTime}\nSubject: ${m.subject}\n\n${strip(m.body?.content)}`);
  } else if (opt('--attachments')) {
    const id = encodeURIComponent(opt('--attachments')), dir = opt('--save');
    for (const a of (await g(`${BOX}/messages/${id}/attachments?$select=id,name,size,contentType`)).value || []) {
      console.log(`${a.name}  ${a.size} B  ${a.contentType || ''}`);
      if (dir && a['@odata.type'] === '#microsoft.graph.fileAttachment') {
        const full = await g(`${BOX}/messages/${id}/attachments/${encodeURIComponent(a.id)}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, path.basename(a.name)), Buffer.from(full.contentBytes, 'base64'));
      }
    }
  } else if (opt('--detect')) {
    const since = opt('--detect');
    const r = await g(`/me/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc&$filter=receivedDateTime gt ${since}&${SEL},body`);
    const hits = r.value.filter((m) => addr(m.from).toLowerCase() !== UPN).reverse();
    if (!hits.length) process.exit(0);
    for (const m of hits) logComms({ channel: 'mail', dir: 'in', messageId: m.id, from: addr(m.from), at: m.receivedDateTime,
      to: m.toRecipients.map(addr), subject: m.subject, text: strip(m.body?.content), hasAttachments: m.hasAttachments });
    console.log(JSON.stringify({ since, count: hits.length, messages: hits.map((m) => ({ at: m.receivedDateTime, from: addr(m.from), subject: m.subject, preview: m.bodyPreview })) }, null, 2));
    process.exit(10);
  } else if (has('--send')) {
    const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
    const to = list(opt('--to')), cc = list(opt('--cc')), subject = opt('--subject') || '';
    if (!to.length || !subject) fail('--send needs --to and --subject', 2);
    // Only a full-scope grant may mail anyone but the owner.
    const owner = (process.env.OWNER_UPN || '').toLowerCase();
    const { scope, why } = currentScope();
    if (scope === 'none') fail(`blocked: this run's send grant is not valid (${why}); nothing sent`, 3);
    if (scope !== 'full' && [...to, ...cc].some((x) => x.toLowerCase() !== owner)) fail(`blocked: ${scope.split(':')[0]} scope may only mail the owner`, 3);
    // Files under 3 MB go inline; larger ones (up to 150 MB) through a draft and an upload session, then the draft is sent.
    const files = list(opt('--attach')), SMALL = 3 * 1024 * 1024, MAX = 150 * 1024 * 1024;
    for (const f of files) if (!existsSync(f) || !statSync(f).isFile() || statSync(f).size >= MAX) fail(`attachment missing or >= 150 MB: ${f}`, 2);
    const large = files.filter((f) => statSync(f).size >= SMALL);
    const attachments = files.filter((f) => statSync(f).size < SMALL)
      .map((f) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: path.basename(f), contentBytes: readFileSync(f).toString('base64') }));
    // --inline path=cid[,path=cid]: images referenced in the HTML as src="cid:<cid>" (signature logo).
    const inline = list(opt('--inline')).map((spec) => {
      const eq = spec.lastIndexOf('='), f = spec.slice(0, eq), cid = spec.slice(eq + 1);
      if (eq < 1 || !cid || !existsSync(f) || statSync(f).size >= 1024 * 1024) fail(`inline image missing, too big or not path=cid: ${spec}`, 2);
      return [f, cid];
    });
    const fileLeaks = findSecretsInFiles([...files, ...inline.map(([f]) => f)]);
    if (fileLeaks.length) fail(`blocked: an attachment looks like it contains secrets (${fileLeaks.join(', ')}); nothing sent`, 3);
    for (const [f, cid] of inline) {
      attachments.push({ '@odata.type': '#microsoft.graph.fileAttachment', name: path.basename(f), contentId: cid, isInline: true, contentBytes: readFileSync(f).toString('base64') });
    }
    const rcpt = (a) => ({ emailAddress: { address: a } });
    const content = readFileSync(0, 'utf8');
    const leaked = findSecrets(`${subject}\n${content}`);
    if (leaked.length) fail(`blocked: message looks like it contains secrets (${leaked.join(', ')}); nothing sent`, 3);
    const message = { subject, body: { contentType: 'html', content }, toRecipients: to.map(rcpt), ccRecipients: cc.map(rcpt), ...(attachments.length && { attachments }) };
    if (!large.length) await g('/me/sendMail', { body: { message, saveToSentItems: true } });
    else {
      const draft = await g('/me/messages', { body: message });
      try {
        for (const f of large) await uploadAttachment(draft.id, f);
      } catch (e) {   // an unsent draft with a partial attachment must not linger
        await g(`/me/messages/${draft.id}`, { method: 'DELETE' }).catch(() => {});
        throw e;
      }
      await g(`/me/messages/${draft.id}/send`, { body: {} });
    }
    logComms({ channel: 'mail', dir: 'out', to, cc, subject, text: strip(content) + (files.length ? ` [attached: ${files.map((f) => path.basename(f)).join(', ')}]` : '') });
    console.log('sent');
  } else {
    fail('usage: mail.mjs [--mailbox <shared>] --list | --search <t> | --read <id> | --attachments <id> [--save dir] | --detect <iso> | --send --to a,b --subject S [--cc c] [--attach f] < body.html', 2);
  }
} catch (e) { fail(`mail: ${e.message}`); }
