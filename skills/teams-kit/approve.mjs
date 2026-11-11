#!/usr/bin/env node
// The only path that sends as the owner. Proceeds only when Graph shows the owner typed the command in their 1:1
// and the prompt they saw carries the stored draft's fingerprint. Checks: GUARDRAILS.md "Sending as the owner".
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, need, stateDir, fail, strip } from './graph.mjs';
import { logComms } from './comms-log.mjs';
import { toHtml } from './fmt.mjs';
import { findSecrets } from './secrets.mjs';
import { MAX_AGE_H, chatLabel, checkCommand, checkPrompt, parseCommand, replyRecipients } from './approval.mjs';
import { mailCache, kitEnv, ownerDelegate } from './kit-env.mjs';
import { sendAsAccount } from './send-as.mjs';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i === -1 ? '' : (argv[i + 1] ?? ''); };
const [verb, id] = argv;
const MSG = opt('--msg'), CHAT = opt('--chat');
if (!['send', 'edit', 'skip', 'save'].includes(verb) || !/^D\d+$/.test(id || '') || (verb !== 'skip' && !(MSG && CHAT))) {
  fail('usage: approve.mjs send|edit|skip|save <Dn> --chat <owner 1:1 chatId> --msg <owner command messageId>', 2);
}
const file = path.join(stateDir(), 'drafts', `${id}.json`);
const USED = path.join(stateDir(), 'drafts', 'used-commands.txt');
const here = path.dirname(fileURLToPath(import.meta.url));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tell = (msg) => spawnSync('node', [path.join(here, 'teams-send-dm.mjs'), '--verbatim'], { input: `<p>${esc(msg)}</p>`, stdio: ['pipe', 'ignore', 'inherit'] });
const stop = (msg) => { tell(msg); process.exit(1); };

if (!existsSync(file)) stop(`I don't have a draft ${id}.`);
const d = JSON.parse(readFileSync(file, 'utf8'));
if (d.status === 'superseded') stop(`Draft ${id} was replaced by ${d.supersededBy}; nothing went out. Reply about ${d.supersededBy} instead.`);
if (d.status !== 'pending') stop(`Draft ${id} is already ${d.status}.`);
if (Date.now() - Date.parse(d.created) > MAX_AGE_H * 3600e3) stop(`Draft ${id} is older than ${MAX_AGE_H}h; ask me for a fresh one.`);
const save = (status, extra = {}) => writeFileSync(file, JSON.stringify({ ...d, ...extra, status, decided: new Date().toISOString() }, null, 2), { mode: 0o600 });
if (verb === 'skip') { save('skipped'); logComms({ dir: 'draft', kind: 'skipped', draftId: id }); tell(`Skipped ${id}.`); process.exit(0); }
const isMail = d.kind === 'mail';
if (verb === 'save' && !isMail) stop(`${id} is a Teams draft; only email drafts can be saved to Outlook.`);

// Owner identity and sign-in come from the on-disk .env; the delegate sign-in is opt-in (BEING_OWNER_DELEGATE=1).
const kenv = kitEnv();
const OWNER = kenv.OWNER_UPN || need('OWNER_UPN');
const OWNER_OID = kenv.OWNER_OID || need('OWNER_OID');
// A send-as draft (d.as) goes out from that person's own named cache; the owner's command is verified with the Being's
// sign-in (it is in the owner's 1:1), so no owner sign-in is needed for it.
const AS = d.as ? String(d.as).toLowerCase() : '';
let asAccount;
if (AS) {
  if (isMail || verb !== 'send') stop(`${id} is a send-as draft: only "send ${id}" works for it (ask for a new draft to change it).`);
  asAccount = sendAsAccount(AS, kenv);
  if (typeof asAccount === 'string') stop(`Did not send ${id} as ${AS}: ${asAccount}. Nothing went out.`);
} else if (!ownerDelegate(kenv)) stop(`No owner sign-in on this host, so I cannot send ${id} as you; copy it from the prompt and send it yourself.`);
const { g, me } = AS
  ? await connect({ upn: need('BEING_UPN'), scopes: ['Chat.ReadWrite', 'User.Read'] })
  : await connect({ upn: OWNER, cache: isMail ? (mailCache('owner', kenv) || kenv.OWNER_CACHE) : kenv.OWNER_CACHE,
    scopes: isMail ? ['Mail.Send', 'Mail.ReadWrite', 'Chat.ReadWrite', 'User.Read'] : ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'] });
if (!AS && me.id !== OWNER_OID) stop(`Owner sign-in does not match OWNER_OID; nothing sent.`);

// 1) The command must be the owner's own message, in their 1:1 with the Being, used once.
const used = new Set(existsSync(USED) ? readFileSync(USED, 'utf8').split('\n').filter(Boolean) : []);
// Messages the kit posted itself (comms log): a kit-authored "send Dn" is never an owner command.
const COMMS = process.env.BEING_COMMS_LOG || path.join(stateDir(), 'comms.jsonl');
const kitSent = new Set();
if (existsSync(COMMS)) for (const l of readFileSync(COMMS, 'utf8').split('\n')) {
  try { const e = JSON.parse(l); if (e.dir === 'out' && e.messageId) kitSent.add(e.messageId); } catch {}
}
let refusal, cmd, beingId;
try {
  const chat = await g(`/chats/${encodeURIComponent(CHAT)}?$expand=members`);
  cmd = await g(`/chats/${encodeURIComponent(CHAT)}/messages/${encodeURIComponent(MSG)}`);
  beingId = (chat.members || []).find((m) => (m.email || '').toLowerCase() === need('BEING_UPN').toLowerCase())?.userId;
  refusal = checkCommand({ msg: cmd, chat, members: chat.members, ownerOid: OWNER_OID, beingUpn: need('BEING_UPN'), verb, id, draft: d, used, kitSent });
  // 2) The prompt the owner saw must be the Being's and carry this draft's fingerprint.
  if (!refusal) {
    const prompt = await g(`/chats/${encodeURIComponent(d.promptChatId)}/messages/${encodeURIComponent(d.promptMessageId)}`);
    refusal = checkPrompt({ promptMsg: prompt, beingId, draft: d, cmdAt: Date.parse(cmd.createdDateTime) });
  }
  // 3) A Teams target must still resolve to the chat the prompt named.
  if (!refusal && !isMail && !AS) {
    const t = await g(`/chats/${encodeURIComponent(d.chatId)}?$expand=members`);
    if (chatLabel(t, t.members, { exclude: [me.id, OWNER] }) !== d.target) refusal = 'the target chat no longer matches the prompt';
  }
  if (!refusal && AS) {   // resolved as the send-as account, the way draft-for-owner.mjs labelled it
    const { g: ag, me: am } = await connect({ upn: AS, cache: asAccount.cache, sender: true, scopes: ['Chat.ReadWrite', 'User.Read'] });
    const t = await ag(`/chats/${encodeURIComponent(d.chatId)}?$expand=members`);
    if (chatLabel(t, t.members, { exclude: [am.id, AS] }) !== d.target) refusal = 'the target chat no longer matches the prompt';
  }
} catch (e) { refusal = `could not verify (${e.message.slice(0, 100)})`; }
if (refusal) {
  logComms({ dir: 'draft', kind: 'approval-refused', draftId: id, error: refusal });
  stop(`Did not act on ${id}: ${refusal}. Nothing went out.`);
}
appendFileSync(USED, `${MSG}\n`);

const text = verb === 'edit' ? parseCommand(strip(cmd.body?.content)).rest : d.text;
if (!text) stop(`Edit for ${id} was empty; nothing sent.`);
const leaked = findSecrets(text);
if (leaked.length) stop(`Edit for ${id} looks like it contains secrets (${leaked.join(', ')}); nothing sent.`);

try {
  if (AS) {   // teams-send-dm.mjs re-checks this approval, claims it once and sends from the named cache
    save('approved-as', { approvedAt: new Date().toISOString(), approvedCommand: MSG });
    const r = spawnSync('node', [path.join(here, 'teams-send-dm.mjs'), '--as', AS, '--draft', id], { input: '', stdio: ['pipe', 'pipe', 'inherit'], encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`send as ${AS} refused or failed (exit ${r.status})`);
    tell(`Sent ${id} as ${AS} in ${d.target}.`);
    process.exit(0);
  }
  if (isMail) {
    const rcpt = (a) => ({ emailAddress: { address: a } });
    const attachments = (d.attach || []).map((a) => {
      const buf = existsSync(a.path) ? readFileSync(a.path) : null;
      if (!buf || createHash('sha256').update(buf).digest('hex') !== a.sha256) throw new Error(`attachment ${a.name} is missing or changed since the draft`);
      return { '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentBytes: buf.toString('base64') };
    });
    const html = toHtml(text);
    let recipients = { ...(d.to?.length ? { toRecipients: d.to.map(rcpt) } : {}), ...(d.cc?.length ? { ccRecipients: d.cc.map(rcpt) } : {}) };
    let msgId;
    if (d.replyTo) {   // reply in the original thread: keeps history and, unless overridden, recipients
      // A reply to the owner's own sent mail goes to that mail's recipients, not back to the owner.
      const orig = await g(`/me/messages/${encodeURIComponent(d.replyTo)}?$select=from,toRecipients,ccRecipients`).catch(() => null);
      recipients = { ...replyRecipients(orig, OWNER, d), ...recipients };
      const r = await g(`/me/messages/${encodeURIComponent(d.replyTo)}/createReply`, { body: {} });
      await g(`/me/messages/${r.id}`, { method: 'PATCH', body: { body: { contentType: 'html', content: html + (r.body?.content || '') },
        ...(d.subject ? { subject: d.subject } : {}), ...recipients } });
      msgId = r.id;
    } else {
      msgId = (await g('/me/messages', { body: { subject: d.subject, body: { contentType: 'html', content: html }, ...recipients } })).id;
    }
    for (const a of attachments) await g(`/me/messages/${msgId}/attachments`, { body: a });
    if (verb === 'save') {
      save('saved-draft', { savedMessageId: msgId });
      logComms({ channel: 'mail', dir: 'draft', kind: 'saved-in-owner-drafts', draftId: id, to: d.to, cc: d.cc, subject: d.subject });
      tell(`Saved ${id} in your Outlook Drafts (not sent).`);
      process.exit(0);
    }
    await g(`/me/messages/${msgId}/send`, { body: {} });
    save('sent', { sentText: text });
    logComms({ channel: 'mail', dir: 'out', kind: 'as-owner', draftId: id, to: d.to, cc: d.cc, subject: d.subject, replyTo: d.replyTo, text });
    const sentTo = (recipients.toRecipients || []).map((x) => x.emailAddress?.address).filter(Boolean);
    tell(`Emailed ${id} as you${sentTo.length ? ` to ${sentTo.join(', ')}` : ''}.`);
  } else {
    const sent = await g(`/chats/${d.chatId}/messages`, { body: { body: { contentType: 'html', content: toHtml(text) } } });
    save('sent', { sentText: text, sentMessageId: sent.id });
    logComms({ dir: 'out', kind: 'as-owner', draftId: id, chatId: d.chatId, to: d.target, messageId: sent.id, text });
    tell(`Sent ${id} as you in ${d.target}.`);
  }
} catch (e) {
  logComms({ dir: 'out', kind: 'as-owner-error', draftId: id, error: e.message });
  stop(`Sending ${id} failed: ${e.message.slice(0, 120)}. Nothing went out.`);
}
