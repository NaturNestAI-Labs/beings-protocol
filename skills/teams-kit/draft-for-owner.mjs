#!/usr/bin/env node
// Stage a draft written on the owner's behalf and post its approval prompt to the owner (approve.mjs sends).
// Usage: README.md "Script reference". The prompt shows the target as resolved from Graph, plus a fingerprint.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { connect, need, stateDir, standby, fail, beingSender } from './graph.mjs';
import { kitEnv, ownerDelegate } from './kit-env.mjs';
import { logComms } from './comms-log.mjs';
import { toHtml } from './fmt.mjs';
import { findSecrets, findSecretsInFiles } from './secrets.mjs';
import { chatLabel, fingerprint, renderPrompt, allocDraftId, COMMAND_RE, parseCommand, replacedBy, loadDrafts } from './approval.mjs';
import { sendAsAccount } from './send-as.mjs';

const SENDER = beingSender();   // the prompt is posted as the Being, never as the owner
const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i === -1 ? '' : (args[i + 1] ?? ''); };
const isMail = args.includes('--mail');
const chatId = opt('--chat'), to = opt('--to'), re = opt('--re'), cc = opt('--cc'), subject = opt('--subject'), replyTo = opt('--reply-to');
const as = opt('--as').toLowerCase();   // Teams only: send from another account that granted it (send-as.mjs)
const attach = opt('--attach').split(',').map((x) => x.trim()).filter(Boolean).map((f) => {
  if (!path.isAbsolute(f) || !existsSync(f) || statSync(f).size >= 3 * 1024 * 1024) fail(`attachment missing, relative or >= 3 MB: ${f}`, 2);
  return { path: f, name: path.basename(f), size: statSync(f).size, sha256: createHash('sha256').update(readFileSync(f)).digest('hex') };
});
const text = readFileSync(0, 'utf8').trim();
if (!text || (isMail ? !(to || replyTo) || (!subject && !replyTo) : !chatId)) {
  fail('usage: --chat <chatId> [--re <msg>] [--as <upn>] < draft.md | --mail --to a,b [--cc c] --subject S [--reply-to <id>] [--attach /abs/f] < draft.md', 2);
}
if (standby()) fail('standby host: drafts disabled', 3);
const leaked = [...findSecrets(`${subject}\n${re}\n${text}`), ...findSecretsInFiles(attach.map((a) => a.path))];
if (leaked.length) fail(`blocked: draft looks like it contains secrets (${leaked.join(', ')}); not staged`, 3);
// A draft that is itself a command ("send D8") would approve another draft once sent as the owner.
if (COMMAND_RE.test(text) || parseCommand(text)) fail('blocked: a draft cannot be an approval command; not staged', 3);
const OWNER = need('OWNER_UPN').toLowerCase();

// The target label comes from Graph with the owner's sign-in, never from the caller.
let target = '';
const kenv = kitEnv();
if (as) {
  if (isMail) fail('blocked: --as is for Teams drafts only', 2);
  const acct = sendAsAccount(as, kenv);
  if (typeof acct === 'string') fail(`blocked: ${acct}; not staged`, 3);
  const { g: ag, me: am } = await connect({ upn: as, cache: acct.cache, sender: true, scopes: ['Chat.ReadWrite', 'User.Read'] });
  const chat = await ag(`/chats/${encodeURIComponent(chatId)}?$expand=members`).catch((e) => fail(`cannot resolve chat ${chatId} as ${as}: ${e.message}`));
  target = chatLabel(chat, chat.members, { exclude: [am.id, as] });
} else if (!isMail && !ownerDelegate(kenv)) target = 'a chat not verified (no owner sign-in on this host: copy the text and send it yourself)';
else if (!isMail) {
  const { g: og, me: owner } = await connect({ upn: OWNER, cache: kenv.OWNER_CACHE, scopes: ['Chat.ReadWrite', 'User.Read'] });
  const chat = await og(`/chats/${encodeURIComponent(chatId)}?$expand=members`).catch((e) => fail(`cannot resolve chat ${chatId}: ${e.message}`));
  if (chat.chatType === 'oneOnOne' && (chat.members || []).some((m) => (m.email || '').toLowerCase() === SENDER.upn.toLowerCase())) {
    fail('blocked: drafts cannot target the owner\'s 1:1 with the Being', 3);
  }
  target = chatLabel(chat, chat.members, { exclude: [owner.id, OWNER] });
}

const DIR = path.join(stateDir(), 'drafts');
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const id = allocDraftId(DIR);
const list = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const draft = isMail ? { id, kind: 'mail', to: list(to), cc: list(cc), subject, replyTo, re, text, attach }
  : { id, kind: 'teams', chatId, target, re, text, ...(as ? { as } : {}) };
draft.fingerprint = fingerprint(draft);
const replaces = replacedBy({ ...draft, created: new Date().toISOString() }, loadDrafts(DIR));
if (replaces.length) draft.replaces = replaces;
const file = path.join(DIR, `${id}.json`);
const store = (extra) => writeFileSync(file, JSON.stringify({ ...draft, status: 'pending', created: new Date().toISOString(), ...extra }, null, 2), { mode: 0o600 });
store({});

// Posted in-process: the CLI sender refuses fingerprinted prompts, so only this script can offer a draft.
const { g, me } = await connect({ ...SENDER, sender: true, scopes: ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'] });
try {
  const cs = await g(`/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`);
  const chat = cs.value.find((c) => c.members?.some((m) => (m.email || '').toLowerCase() === OWNER));
  if (!chat) throw new Error('no 1:1 chat with the owner yet; send them any message first');
  const sent = await g(`/chats/${chat.id}/messages`, { body: { body: { contentType: 'html', content: renderPrompt(draft, toHtml(text)) } } });
  store({ promptChatId: chat.id, promptMessageId: sent.id, promptAt: sent.createdDateTime || new Date().toISOString(), by: me.userPrincipalName });
} catch (e) { fail(`draft ${id} stored but not delivered to the owner: ${e.message}`); }
// Offered: the drafts it replaces can no longer be approved (approve.mjs names the replacement).
for (const old of replaces) {
  const f = path.join(DIR, `${old}.json`);
  try { const o = JSON.parse(readFileSync(f, 'utf8')); if (o.status === 'pending') writeFileSync(f, JSON.stringify({ ...o, status: 'superseded', supersededBy: id, decided: new Date().toISOString() }, null, 2), { mode: 0o600 }); } catch {}
}
logComms({ channel: isMail ? 'mail' : 'teams', dir: 'draft', kind: 'for-owner', draftId: id, chatId, to: isMail ? draft.to : target, subject, text });
console.log(id);
