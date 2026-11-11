#!/usr/bin/env node
// Cheap Teams poll: new messages addressed to the Being since a watermark (no model).
// Exit codes and env: README.md "Script reference".
import { connect, need, fail, strip } from './graph.mjs';
import { openTrigger, readLine } from './fifo-wait.mjs';
import { sweepSince, after, readNotified, commitOffset, addressedBy } from './detect-util.mjs';

// --notified <hook queue.jsonl> <offset file>: read only the messages the Graph webhook named since the offset (fast path).
// --wait <fifo>: sign in now, read the queue when "go" arrives on the FIFO; any other line or a kill: exit, offset untouched.
const NOTIFIED = process.argv[2] === '--notified';
const TRIGGER = NOTIFIED && process.argv[5] === '--wait' && process.argv[6] ? openTrigger(process.argv[6]) : null;
if (!(NOTIFIED ? process.argv[4] : process.argv[2])) fail('usage: teams-detect.mjs <ISO8601-watermark> | --notified <queue.jsonl> <offset-file>');
// The sweep looks BEING_DETECT_OVERLAP_SEC (120) behind its watermark; times are compared with Date.parse (detect-util.mjs).
let since;
try { since = NOTIFIED ? new Date(Date.now() - 15 * 60e3).toISOString() : sweepSince(process.argv[2], Number(process.env.BEING_DETECT_OVERLAP_SEC ?? 120)); }
catch (e) { fail(e.message); }
// Message ids the webhook queued since the offset; the offset is committed only after they were fetched (review #11).
let NOTE = null;
function notifiedIds() { NOTE = readNotified(process.argv[3], process.argv[4]); return NOTE.ids; }
const signIn = () => connect({ upn: need('BEING_UPN'), scopes: ['Chat.Read', 'User.Read'] });
const early = TRIGGER !== null ? await signIn() : null;
if (TRIGGER !== null) {
  if (readLine(TRIGGER) !== 'go') process.exit(0);
  since = new Date(Date.now() - 15 * 60e3).toISOString();
}
const IDS = NOTIFIED ? notifiedIds() : null;
if (IDS && !IDS.size) { commitOffset(process.argv[4], NOTE, true); process.exit(0); }   // nothing named (e.g. a lifecycle kick)
const { g, me } = early || await signIn();
const SELF = me.id;
const OWNER = process.env.OWNER_OID || '';
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const list = (k) => (process.env[k] || '').split(',').map((x) => x.trim()).filter(Boolean);
// Name or alias as a word wakes the Being; stop-list phrases ("Nova Scotia") are removed first (README "Detection limits").
const NAME_RE = new RegExp(`\\b(?:${[need('BEING_NAME'), ...list('BEING_NAME_ALIASES')].map(esc).join('|')})\\b`, 'i');
const STOP = list('BEING_NAME_STOPLIST').map((x) => new RegExp(esc(x), 'gi'));
const named = (t) => NAME_RE.test(STOP.reduce((s, re) => s.replace(re, ' '), t));
// Sweep limits (README "Detection limits"): most recently active chats first, newest messages per chat.
const int = (k, d, max) => Math.min(max, Math.max(1, parseInt(process.env[k] || '', 10) || d));
const MAX_CHATS = int('BEING_DETECT_CHATS', 50, 1000), PER_CHAT = int('BEING_DETECT_MESSAGES', 8, 50);
const MAX_PAGES = int('BEING_DETECT_PAGES', 5, 20);
const EMO = { like: '👍', heart: '❤️', laugh: '😆', surprised: '😮', sad: '😢', angry: '😡' };

const members = new Map();   // chatId -> Map(userId -> displayName)
async function nameOf(id, chatId) {
  if (!id) return 'unknown';
  if (!members.has(chatId)) {
    const m = new Map();
    try { for (const x of (await g(`/chats/${chatId}/members`)).value ?? []) if (x.userId) m.set(x.userId, x.displayName || x.userId.slice(0, 8)); } catch {}
    members.set(chatId, m);
  }
  return members.get(chatId).get(id) || id.slice(0, 8);
}

// One message of chat c: push a hit if it is new and addressed to the Being (or a reaction to the Being's own message).
// A group's recent messages (for the active-thread rule): the sweep's page when it has one, else one Graph read per chat.
const recentOf = new Map();
async function recentFor(c, page) {
  if (!recentOf.has(c.id)) {
    recentOf.set(c.id, (async () => {
      const ms = page || ((await g(`/chats/${c.id}/messages?$top=20`)).value ?? []);
      return ms.filter((x) => x.messageType === 'message' && !x.deletedDateTime && x.from?.user?.id).map((x) => ({ fromId: x.from.user.id,
        at: x.createdDateTime, toBeing: x.mentions?.some((y) => y.mentioned?.user?.id === SELF) || named(strip(x.body?.content ?? '').replace(/\s+/g, ' ')) }));
    })().catch(() => []));
  }
  return recentOf.get(c.id);
}

async function classify(c, m, hits, page) {
  // Reactions to the Being's own messages count as input (a 👍 on a question is an answer).
  if (m.from?.user?.id === SELF && !m.deletedDateTime) {
    for (const r of m.reactions ?? []) {
      if (!after(r.createdDateTime, since) || r.user?.user?.id === SELF) continue;
      if (c.chatType !== 'oneOnOne' && r.user?.user?.id !== OWNER) continue;   // group likes are not a cue
      hits.push({ addressedBy: 'reaction', chatId: c.id, topic: c.topic ?? '(direct)', chatType: c.chatType,
        from: r.user?.user?.displayName ?? await nameOf(r.user?.user?.id, c.id), fromId: r.user?.user?.id, at: r.createdDateTime,
        preview: `${r.displayName || EMO[r.reactionType] || r.reactionType} on my message [${m.id}]: "${strip(m.body?.content).slice(0, 100)}"` });
    }
    return;
  }
  if (!after(m.createdDateTime, since)) return;
  if (m.messageType !== 'message' || m.deletedDateTime || !m.from?.user?.id) return;   // system events, notices
  if (m.from.user.id === SELF) return;   // never answer yourself: that is the loop
  const html = m.body?.content ?? '';
  const text = strip(html).replace(/\s+/g, ' ');
  const attachments = [
    ...(m.attachments ?? []).filter((a) => a.contentType === 'reference' && a.contentUrl).map((a) => ({ kind: 'file', name: a.name ?? '(unnamed)', url: a.contentUrl })),
    ...[...html.matchAll(/<img[^>]+src="([^"]+)"/gi)].map((x) => ({ kind: 'image', name: 'inline image', url: x[1] })),
  ];
  // Wake the model only for messages FOR the Being: a 1:1, an @mention, or its name in the text.
  // In a group also: the owner, and a sender in a live thread with the Being (detect-util.mjs addressedBy).
  const msg = { chatType: c.chatType, fromId: m.from.user.id, at: m.createdDateTime, named: named(text),
    mentionsSelf: m.mentions?.some((x) => x.mentioned?.user?.id === SELF) };
  const ctx = { self: SELF, owner: OWNER, ownerWakes: process.env.BEING_GROUP_OWNER_WAKES !== '0' };
  let by = addressedBy(msg, ctx);
  if (!by && c.chatType !== 'oneOnOne') by = addressedBy(msg, { ...ctx, recent: await recentFor(c, page) });
  if (!by) return;
  hits.push({ addressedBy: by,
    chatId: c.id, topic: c.topic ?? '(direct)', chatType: c.chatType, from: m.from.user.displayName ?? 'unknown',
    fromId: m.from.user.id, at: m.createdDateTime, messageId: m.id, preview: text.slice(0, 160), text,
    ...(attachments.length ? { attachments } : {}) });
}

// Fast path: fetch just the notified messages; Graph may need a moment before a new message is readable, so 404 retries briefly.
async function notified(g, ids) {
  const hits = [];
  let transient = false;
  const get = async (url) => {
    for (const wait of [250, 500, 1000, 0]) {
      try { return await g(url); } catch (e) {
        if (!wait || /^40[13] /.test(e.message)) throw e;
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  };
  await Promise.all([...ids].map(async ([mid, cid]) => {
    try {
      const [c, m] = await Promise.all([get(`/chats/${cid}?$select=id,topic,chatType`), get(`/chats/${cid}/messages/${mid}`)]);
      await classify(c, m, hits);
    } catch (e) { console.error(`notified ${mid}: ${e.message}`); transient = true; }
  }));
  return { hits, transient };
}

try {
  if (NOTIFIED) {
    const { hits, transient } = await notified(g, IDS);
    commitOffset(process.argv[4], NOTE, !transient);   // a failed fetch is tried again on the next kick (max 3)
    if (!hits.length) process.exit(transient ? 1 : 0);
    hits.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    console.log(JSON.stringify({ since, count: hits.length, messages: hits }, null, 2));
    process.exit(10);
  }
  // One watermark covers every chat, so every tick sweeps every chat (up to MAX_CHATS, paged).
  const base = '/me/chats?$top=50&$select=id,topic,chatType';
  let r = await g(`${base}&$orderby=lastMessagePreview/createdDateTime desc`).catch(() => g(base));   // unordered if $orderby is refused
  const chats = [...(r.value ?? [])];
  while (r['@odata.nextLink'] && chats.length < MAX_CHATS) { r = await g(r['@odata.nextLink']); chats.push(...(r.value ?? [])); }
  chats.splice(MAX_CHATS);
  const hits = [];
  let transient = false;
  // Graph has no createdDateTime filter for chat messages: fetch the newest few and compare locally.
  await Promise.all(chats.map(async (c) => {
    try {
      // A burst can fill the first page: read further back until a message at or before the watermark (bounded).
      let r = await g(`/chats/${c.id}/messages?$top=${PER_CHAT}`);
      const page = [...(r.value ?? [])];
      for (let n = 1; n < MAX_PAGES && r['@odata.nextLink'] && page.length && page.every((m) => after(m.createdDateTime, since)); n++) {
        r = await g(r['@odata.nextLink']); page.push(...(r.value ?? []));
      }
      if (r['@odata.nextLink'] && page.length && page.every((m) => after(m.createdDateTime, since))) {
        console.error(`chat ${c.id.slice(0, 30)}: ${page.length}+ new messages since the last sweep; older ones may be missed (raise BEING_DETECT_PAGES)`);
      }
      for (const m of page) await classify(c, m, hits, page);
    } catch (e) {
      // One unreadable chat must not blind the sweep; a transient error must hold the watermark.
      console.error(`chat ${c.id.slice(0, 30)}: ${e.message}`);
      if (!/^40[34] /.test(e.message)) transient = true;
    }
  }));
  if (transient && !hits.length) process.exit(1);
  if (!hits.length) process.exit(0);
  hits.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  console.log(JSON.stringify({ since, count: hits.length, messages: hits }, null, 2));
  process.exit(transient ? 11 : 10);
} catch (e) {
  fail(`detect failed: ${e.message}`);
}
