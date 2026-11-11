#!/usr/bin/env node
// Read Teams as the Being (or as the owner, via owner-read). Never sends.
// Usage: README.md "Script reference".
import { connect, need, fail } from './graph.mjs';
import { htmlToText, inlineImages, formatReactions } from './fmt.mjs';

const args = process.argv.slice(2);
const take = (f) => { const i = args.indexOf(f); if (i === -1) return null; const v = args[i + 1] || ''; args.splice(i, 2); return v; };
const flag = (f) => { const i = args.indexOf(f); if (i === -1) return false; args.splice(i, 1); return true; };
const AS = take('--as') || need('BEING_UPN');
const CHAT = take('--chat'), FIND = take('--find'), SINCE = take('--since');
const TOP = parseInt(take('--top') || '10', 10);
const WHOAMI = flag('--whoami'), LIST = flag('--list'), MEMBERS = flag('--members');
const PEER = (args[0] || '').toLowerCase();

const { g, me } = await connect({ upn: AS, scopes: ['Chat.Read', 'User.Read'] });
console.error(`reading as ${me.userPrincipalName}`);
if (WHOAMI) { console.log(`${me.userPrincipalName}  oid ${me.id}`); process.exit(0); }
const row = (c) => `${c.lastUpdatedDateTime || '-'}  ${c.chatType.padEnd(9)}  ${c.topic || (c.members || []).map((m) => m.displayName).filter(Boolean).join(', ')}\n    ${c.id}`;

if (MEMBERS && CHAT) {
  for (const m of (await g(`/chats/${CHAT}/members`)).value ?? []) console.log(`${m.email || ''}\t${m.displayName || ''}`);
  process.exit(0);
}
if (FIND) {
  const q = FIND.toLowerCase(); let url = '/me/chats?$expand=members&$top=50', seen = 0, hits = 0;
  while (url && seen < 1000) {
    const page = await g(url);
    for (const c of page.value) {
      seen++;
      const who = (c.members || []).map((m) => m.displayName).join(', ').toLowerCase();
      if ((c.topic || '').toLowerCase().includes(q) || who.includes(q)) { hits++; console.log(row(c)); }
    }
    url = page['@odata.nextLink'] || null;
  }
  if (!hits) fail(`no chat matching "${FIND}" in ${seen} chats`);
  process.exit(0);
}
if (LIST) { for (const c of (await g(`/me/chats?$expand=members&$top=${TOP}`)).value) console.log(row(c)); process.exit(0); }

let chatId = CHAT;
if (!chatId) {
  if (!PEER) fail('need --chat <id>, a peer upn, --find or --list');
  const cs = await g(`/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`);
  chatId = cs.value.find((c) => c.members?.some((m) => (m.email || '').toLowerCase() === PEER))?.id;
  if (!chatId) fail(`no 1:1 with ${PEER}`);
}
let all = [];
if (SINCE) {
  let url = `/chats/${chatId}/messages?$top=50`, found = false;
  while (url && all.length < 500 && !found) {
    const page = await g(url);
    for (const m of page.value) { if (m.id === SINCE) { found = true; break; } all.push(m); }
    url = page['@odata.nextLink'] || null;
  }
  if (!found) fail(`anchor ${SINCE} not found in ${all.length} messages`, 2);
  console.error(`${all.length} message(s) after ${SINCE}`);
} else {
  all = (await g(`/chats/${chatId}/messages?$top=${TOP}`)).value;
}
// Reactions carry only a user id in most tenants: names come from the chat roster, read once and only when needed.
let names = new Map();
if (all.some((m) => (m.reactions || []).some((r) => !r.user?.user?.displayName))) {
  try { names = new Map(((await g(`/chats/${chatId}/members`)).value || []).filter((x) => x.userId).map((x) => [x.userId, x.displayName || x.email || x.userId.slice(0, 8)])); } catch {}
}
for (const m of all.slice().reverse()) {
  const body = htmlToText(m.body?.content);
  if (!body && m.messageType !== 'message') continue;
  const who = m.from?.user?.displayName || m.from?.application?.displayName || '(system)';
  const rx = formatReactions(m.reactions, names);
  console.log(`\n--- ${m.createdDateTime}  ${who}  [${m.id}]${rx ? `  reactions: ${rx}` : ''}\n${body}`);
  for (const a of m.attachments ?? []) if (a.contentType === 'reference' && a.contentUrl) console.log(`    [file] ${a.name ?? '(unnamed)'}  ${a.contentUrl}`);
  for (const src of inlineImages(m.body?.content)) console.log(`    [image] ${src}`);
}
