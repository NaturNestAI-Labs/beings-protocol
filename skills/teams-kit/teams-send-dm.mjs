#!/usr/bin/env node
// Send a Teams message as the Being; body from stdin (markdown or HTML).
// Usage and send scopes: README.md "Script reference" and GUARDRAILS.md.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { connect, need, fail, standby, stateDir, beingSender } from './graph.mjs';
import { logComms } from './comms-log.mjs';
import { replyRef, autoReplyTarget } from './reply-ref.mjs';
import { ensureHtml } from './fmt.mjs';
import { currentScope, allowedChats } from './scope.mjs';
import { findSecrets, findSecretsInFiles, redactCodes } from './secrets.mjs';
import { PROMPT_MARK_RE } from './approval.mjs';
import { isOwnerDm, hasDocument, pinMessage } from './pin.mjs';
import { enabled as docsIndexOn, updateDocsIndex } from './docs-index.mjs';
import { sendAsAccount, checkSendAsDraft } from './send-as.mjs';
import { teamConfig, teamRecipient, teamChat } from './team-scope.mjs';

const args = process.argv.slice(2);
const take = (f) => { const i = args.indexOf(f); if (i === -1) return null; const v = args[i + 1] || ''; args.splice(i, 2); if (!v) fail(`${f} needs a value`, 2); return v; };
const flag = (f) => { const i = args.indexOf(f); if (i === -1) return false; args.splice(i, 1); return true; };
const CHAT_ID = take('--chat'), REPLY_TO = take('--reply-to'), ATTACH_URL = take('--attach-url'), ATTACH_NAME = take('--attach-name');
const IMAGE = take('--image'), GROUP = take('--group'), TOPIC = take('--topic'), AS = take('--as'), DRAFT = take('--draft');
const NO_QUOTE = flag('--no-quote'), VERBATIM = flag('--verbatim'), WHOAMI = flag('--whoami'), PIN = flag('--pin'), REDACT = flag('--redact-code');
const SENDER = beingSender();   // before any network call: never the owner's identity
if (standby() && !WHOAMI) fail('standby host: sending disabled', 3);
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// --as <upn> --draft <Dn>: an owner-approved draft, sent from that person's own named cache (send-as.mjs). Nothing else.
if (AS || DRAFT) {
  if (!AS || !DRAFT || !/^D\d+$/.test(DRAFT)) fail('--as needs --draft <Dn> (an owner-approved send-as draft), and --draft needs --as', 2);
  if (CHAT_ID || GROUP || IMAGE || ATTACH_URL || PIN || args.length) fail('--as sends only the approved draft: no other target, file or text', 2);
  const acct = sendAsAccount(AS);
  if (typeof acct === 'string') fail(`blocked: ${acct}; nothing sent`, 3);
  const file = path.join(stateDir(), 'drafts', `${DRAFT}.json`);
  const d = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const why = checkSendAsDraft(d, acct.upn);
  if (why) fail(`blocked: ${DRAFT}: ${why}; nothing sent`, 3);
  const leaked = findSecrets(d.text);
  if (leaked.length) fail(`blocked: draft looks like it contains secrets (${leaked.join(', ')}); nothing sent`, 3);
  // One approval, one send: the claim file is created once.
  try { writeFileSync(`${file}.sending`, new Date().toISOString(), { flag: 'wx', mode: 0o600 }); } catch { fail(`blocked: ${DRAFT} was already sent or is being sent`, 3); }
  const { g } = await connect({ upn: acct.upn, cache: acct.cache, sender: true, scopes: ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'] });
  const content = ensureHtml(d.text);
  const msg = await g(`/chats/${encodeURIComponent(d.chatId)}/messages`, { body: { body: { contentType: 'html', content } } }).catch((e) => fail(`send failed: ${e.message}`));
  writeFileSync(file, JSON.stringify({ ...d, status: 'sent', sentAs: acct.upn, sentMessageId: msg.id, decided: new Date().toISOString() }, null, 2), { mode: 0o600 });
  logComms({ dir: 'out', kind: 'as-other', as: acct.upn, draftId: DRAFT, chatId: d.chatId, to: d.target, messageId: msg.id, text: plain(content) });
  console.log(`sent ${DRAFT} as ${acct.upn} to ${d.chatId} as message ${msg.id}`);
  process.exit(0);
}

if (CHAT_ID && args.length) fail(`unexpected argument "${args[0].slice(0, 40)}"; pipe the message on stdin`, 2);
if (GROUP && (CHAT_ID || args.length || !TOPIC)) fail('--group needs --topic and no --chat or recipient', 2);
if (TOPIC && !GROUP) fail('--topic goes with --group', 2);
const GROUP_UPNS = GROUP ? [...new Set(GROUP.toLowerCase().split(',').map((x) => x.trim()).filter(Boolean))] : [];
if (GROUP && GROUP_UPNS.length < 2) fail('--group needs two or more UPNs besides the Being', 2);
// Inline image (Graph hostedContents): PNG, JPEG or GIF by content, up to 4 MB.
let IMG;
if (IMAGE) {
  if (!existsSync(IMAGE) || !statSync(IMAGE).isFile() || statSync(IMAGE).size > 4 * 1024 * 1024) fail(`image missing or over 4 MB: ${IMAGE}`, 2);
  const head = Buffer.alloc(8), fd = openSync(IMAGE, 'r'); readSync(fd, head, 0, 8, 0); closeSync(fd);
  const type = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png'
    : head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg' : head.subarray(0, 4).toString('latin1') === 'GIF8' ? 'image/gif' : null;
  if (!type) fail(`--image must be a PNG, JPEG or GIF: ${IMAGE}`, 2);
  const leak = findSecretsInFiles([IMAGE]);
  if (leak.length) fail(`blocked: the image looks like it contains secrets (${leak.join(', ')}); nothing sent`, 3);
  IMG = { type, bytes: readFileSync(IMAGE).toString('base64') };
}
const OWNER = need('OWNER_UPN').toLowerCase();
const RECIPIENT = (args[0] || OWNER).toLowerCase();

const { g, me, token, tokenFor } = await connect({ ...SENDER, sender: true, scopes: ['Chat.ReadWrite', 'ChatMessage.Send', 'Chat.Create', 'User.Read'] });
console.error(`sending as ${me.userPrincipalName} → ${CHAT_ID ? `chat ${CHAT_ID}` : GROUP ? `new group "${TOPIC}"` : RECIPIENT}`);
if (WHOAMI) { console.log(`verified sender: ${me.userPrincipalName}`); process.exit(0); }

// Scope comes from the handler's grant (BEING_SEND_TOKEN), never from a plain env var; no grant means owner-only, a bad one none.
const { scope: SCOPE, why: WHY } = currentScope();
if (SCOPE === 'none') fail(`blocked: this run's send grant is not valid (${WHY}); nothing sent`, 3);
const LIMITED = SCOPE !== 'full', ALLOWED = allowedChats(SCOPE);
// A teammate lane (chats:) may also reach internal teammates and Beings (team-scope.mjs); routine and owner-only may not.
const TEAM = SCOPE.startsWith('chats:') ? teamConfig() : { on: false };
if (LIMITED && GROUP) fail(`blocked: ${SCOPE.split(':')[0]} scope cannot create group chats`, 3);
if (LIMITED && !CHAT_ID && RECIPIENT !== OWNER && !teamRecipient(RECIPIENT, TEAM)) fail(`blocked: ${SCOPE.split(':')[0]} scope (recipient ${RECIPIENT})`, 3);

let content = readFileSync(0, 'utf8');
const member = (upn) => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': `https://graph.microsoft.com/v1.0/users('${upn}')` });
let chat, members = null;
try {
  if (GROUP) {
    chat = await g('/chats', { body: { chatType: 'group', topic: TOPIC, members: [...new Set([me.userPrincipalName.toLowerCase(), ...GROUP_UPNS])].map(member) } });
    console.log(`group chat id: ${chat.id}`);
    logComms({ dir: 'out', kind: 'group-created', chatId: chat.id, to: TOPIC, text: `members: ${GROUP_UPNS.join(', ')}` });
    if (!content.trim() && !ATTACH_URL && !IMG) process.exit(0);
  } else if (CHAT_ID) {
    chat = await g(`/chats/${CHAT_ID}`);   // fail loudly on a stale id before anything is posted
  } else {
    const cs = await g(`/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`);
    chat = cs.value.find((c) => c.members?.some((m) => (m.email || '').toLowerCase() === RECIPIENT));
    chat ??= await g('/chats', { body: { chatType: 'oneOnOne', members: [me.userPrincipalName, RECIPIENT].map(member) } });
  }
  const getMembers = async () => (members ??= chat.chatType === 'oneOnOne' ? (await g(`/chats/${chat.id}/members`)).value || [] : []);
  // Scoped runs may post only to their listed chats, the owner's 1:1 with the Being, or (teammate lane) internal chats.
  if (LIMITED && !ALLOWED.includes(chat.id)) {
    const ms = await getMembers();
    const ownerDm = isOwnerDm(chat, ms, OWNER) && ms.some((x) => x.userId === me.id);
    const internal = TEAM.on && teamChat(chat, chat.chatType === 'group' ? (await g(`/chats/${chat.id}/members`)).value || [] : ms, me, TEAM);
    if (!ownerDm && !internal) fail(`blocked: ${SCOPE.split(':')[0]} scope (target ${chat.id})`, 3);
  }
  if (docsIndexOn()) await getMembers().catch(() => (members = []));
} catch (e) { fail(`cannot resolve chat: ${e.message}`); }

if (!content.trim() && !ATTACH_URL && !IMG) fail('empty message body on stdin; nothing sent', 2);
if (content.trim()) content = ensureHtml(content);
// Approval prompts come only from draft-for-owner.mjs; nothing that reads like .env or a credential goes out.
if (PROMPT_MARK_RE.test(content.replace(/<[^>]+>/g, ' '))) fail('blocked: only draft-for-owner.mjs may post draft approval prompts', 3);
const leaked = findSecrets(content);
if (leaked.length) fail(`blocked: message looks like it contains secrets (${leaked.join(', ')}); nothing sent`, 3);
const payload = { body: { contentType: 'html', content } };
if (ATTACH_URL) {
  // Teams resolves a file card by the item's eTag GUID and its WebDAV URL.
  const share = 'u!' + Buffer.from(ATTACH_URL).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const r = await fetch(`https://graph.microsoft.com/v1.0/shares/${share}/driveItem?$select=name,eTag,webDavUrl`,
    { headers: { Authorization: `Bearer ${await tokenFor(['Files.ReadWrite'])}` } });
  if (!r.ok) fail(`cannot resolve attachment: ${r.status}; nothing sent`);
  const item = await r.json();
  const attId = (/\{?([0-9A-Fa-f-]{36})/.exec(item.eTag || '') || [])[1];
  if (!attId || !item.webDavUrl) fail('attachment has no eTag/webDavUrl; nothing sent');
  payload.attachments = [{ id: attId, contentType: 'reference', contentUrl: item.webDavUrl, name: ATTACH_NAME || item.name }];
  payload.body.content += `<attachment id="${attId}"></attachment>`;
}
if (IMG) {
  payload.hostedContents = [{ '@microsoft.graph.temporaryId': '1', contentBytes: IMG.bytes, contentType: IMG.type }];
  payload.body.content += '<div><img src="../hostedContents/1/$value" width="360" style="vertical-align:bottom"></div>';
}
const quoteId = NO_QUOTE ? null : (REPLY_TO || (CHAT_ID ? autoReplyTarget(chat.id) : null));
const ownerDm = isOwnerDm(chat, members, OWNER);
const DOCS = docsIndexOn() && ownerDm && hasDocument(content, { attachUrl: ATTACH_URL });

// Work runs queue their messages; the handler's voice pass words them and sends them back through here with --verbatim.
// Images, pins, groups and code-bearing messages go out directly (the queue carries text and file cards only).
if (process.env.BEING_VOICE === 'fast' && !VERBATIM && !IMG && !PIN && !GROUP && !REDACT) {
  const dir = path.join(stateDir(), 'outbox'); mkdirSync(dir, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, chatId: chat.id, html: content, quoteId,
    attachUrl: ATTACH_URL, attachName: ATTACH_NAME, scope: SCOPE, session: process.env.BEING_SESSION_NAME || "", created: new Date().toISOString() }));
  console.log(`queued ${id} for chat ${chat.id}; sent after the voice pass`);
  process.exit(0);
}
if (quoteId) {
  try {   // a quote that cannot be built must not block the reply
    const ref = await replyRef(g, chat.id, quoteId);
    payload.attachments = [...(payload.attachments || []), ref.attachment];
    payload.body.content = ref.tag + payload.body.content;
  } catch (e) { console.error(`quote ${quoteId} unavailable (${e.message}); sending without it`); }
}
let msg;
try { msg = await g(`/chats/${chat.id}/messages`, { body: payload }); } catch (e) {
  if (!quoteId) fail(`send failed: ${e.message}`);
  console.error(`quoted send rejected (${e.message}); sending without quote`);
  payload.body.content = payload.body.content.replace(`<attachment id="${quoteId}"></attachment>`, '');
  payload.attachments = (payload.attachments || []).filter((a) => a.contentType !== 'messageReference');
  if (!payload.attachments.length) delete payload.attachments;
  msg = await g(`/chats/${chat.id}/messages`, { body: payload }).catch((e2) => fail(`send failed: ${e2.message}`));
}
const logged = plain(content) + (IMG ? ` [image: ${path.basename(IMAGE)}]` : '');
logComms({ dir: 'out', kind: 'message', session: process.env.BEING_SESSION_NAME || undefined, chatId: chat.id, messageId: msg.id, replyTo: quoteId || undefined,
  to: CHAT_ID || GROUP ? (chat.topic || chat.chatType) : RECIPIENT, text: REDACT ? redactCodes(logged) : logged });
console.log(`sent to ${chat.id} as message ${msg.id}`);
// Pin and docs-index failures are reported, never fail the send.
if (PIN) {
  const p = await pinMessage(fetch, token, chat.id, msg.id);
  console.error(p.ok ? `pinned ${msg.id}` : `pin failed for ${msg.id} (${p.status || ''} ${p.error}); message was sent`);
  logComms({ dir: 'out', kind: 'pin', chatId: chat.id, messageId: msg.id, text: p.ok ? 'pinned' : `pin failed: ${p.error}` });
}
if (DOCS) {
  const u = await updateDocsIndex({ fetchFn: fetch, token, dir: stateDir(), chatId: chat.id, sourceId: msg.id, html: content, attachUrl: ATTACH_URL, attachName: ATTACH_NAME });
  const note = u.ok ? `docs index updated (+${u.added}${u.rolled ? `, ${u.rolled} archived` : ''})` : `docs index ${u.skipped ? 'skipped' : 'update failed'}: ${u.error}`;
  console.error(note);
  logComms({ dir: 'out', kind: 'docs-index', chatId: chat.id, messageId: msg.id, text: note });
}
