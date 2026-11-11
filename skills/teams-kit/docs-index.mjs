// Docs index (optional, BEING_DOCS_INDEX=1): one pinned message in the owner's 1:1 listing delivered documents, newest first.
// Entries past the count or size cap move to state/docs-index-archive.jsonl. Only the Being posts and edits it.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmdirSync, statSync, renameSync } from 'node:fs';
import path from 'node:path';
import { pinMessage, pinnedIds } from './pin.mjs';

export const enabled = (env = process.env) => env.BEING_DOCS_INDEX === '1';
export const maxEntries = (env = process.env) => Math.max(1, parseInt(env.BEING_DOCS_INDEX_MAX || '60', 10) || 60);
export const MAX_BYTES = 24000;   // Teams rejects message bodies near 28 KB
const DOC_URL = /(?:sharepoint\.com|onedrive\.live\.com|1drv\.ms|notion\.(?:so|site|com))\b|\.(?:pdf|xlsx|xls|docx|doc|pptx|ppt|csv)(?:$|[?#])/i;
const GRAPH = 'https://graph.microsoft.com/v1.0';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => String(s).replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const text = (h) => unesc(String(h).replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ');

// A bare-URL link text becomes the file or page name, so the index never shows raw URLs.
export function linkName(name, url) {
  const n = text(name).trim();
  if (n && !/^https?:\/\//i.test(n)) return n.slice(0, 80);
  try {
    const u = new URL(url);
    const file = u.searchParams.get('file') || decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return (file || u.hostname).slice(0, 80);
  } catch { return 'document'; }
}

export function extractDocLinks(html = '', { attachUrl = null, attachName = null } = {}) {
  const out = [], seen = new Set();
  const add = (name, url) => { if (!url || seen.has(url)) return; seen.add(url); out.push({ name: linkName(name, url), url }); };
  for (const m of String(html).matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = unesc(m[1]);
    if (/^https?:\/\//i.test(url) && DOC_URL.test(url)) add(m[2], url);
  }
  if (attachUrl) add(attachName || '', attachUrl);
  return out;
}

// First sentence of the message as the entry's one-line description.
export function summarize(html = '', max = 110) {
  const t = text(html).split('\n').map((s) => s.trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const first = (t.match(/^.*?[.!?:](?=\s|$)/) || [t])[0].replace(/[:\s]+$/, '');
  return first.length > max ? first.slice(0, max - 1).replace(/\s+\S*$/, '') + '…' : first;
}

// "09 Oct" in the host's timezone (TZ).
export const day = (iso, tz = undefined) => {
  try { return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: tz }).format(new Date(iso)).replace('Sept', 'Sep'); }
  catch { return String(iso).slice(0, 10); }
};
const line = (e) => `${e.date ? `${esc(day(e.date))} · ` : ''}${e.links.map((l) => `<a href="${esc(l.url)}">${esc(l.name)}</a>`).join(' · ')}${e.what ? ` · ${esc(e.what)}` : ''}`;

export function renderIndex(state) {
  const items = [];
  if (state.pinnedEntry) items.push(`<li><b>${line(state.pinnedEntry)}</b></li>`);
  for (const e of state.entries || []) items.push(`<li>${line(e)}</li>`);
  return `<p><b>📌 Docs index</b> · newest first · kept up to date automatically</p><ul>${items.join('')}</ul>`;
}

// Prepend an entry; a re-sent document moves to the top. Entries past max or MAX_BYTES roll off (returned for the archive).
export function addEntry(state, entry, { max = maxEntries(), maxBytes = MAX_BYTES } = {}) {
  const urls = new Set(entry.links.map((l) => l.url));
  const rest = (state.entries || []).map((e) => ({ ...e, links: e.links.filter((l) => !urls.has(l.url)) })).filter((e) => e.links.length);
  const next = { ...state, entries: [entry, ...rest] };
  const rolled = [];
  while (next.entries.length > 1 && (next.entries.length > max || Buffer.byteLength(renderIndex(next)) > maxBytes)) rolled.unshift(next.entries.pop());
  return { state: next, rolled };
}

export const statePaths = (dir) => ({ state: path.join(dir, 'docs-index.json'), archive: path.join(dir, 'docs-index-archive.jsonl'), lock: path.join(dir, 'docs-index.lock') });
export const loadState = (dir) => { const p = statePaths(dir).state; return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
export function saveState(dir, state, rolled = []) {
  const p = statePaths(dir);
  writeFileSync(p.state + '.tmp', JSON.stringify(state, null, 1), { mode: 0o600 }); renameSync(p.state + '.tmp', p.state);
  for (const e of rolled) appendFileSync(p.archive, JSON.stringify({ archivedAt: new Date().toISOString(), ...e }) + '\n', { mode: 0o600 });
}

// mkdir lock; a lock older than 2 minutes is stale.
async function withLock(dir, fn) {
  const lock = statePaths(dir).lock;
  for (let i = 0; ; i++) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 120000) { rmdirSync(lock); continue; } } catch {}
      if (i > 100) throw new Error('docs-index lock busy');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  try { return await fn(); } finally { try { rmdirSync(lock); } catch {} }
}

export async function patchMessage(fetchFn, token, chatId, messageId, html) {
  const r = await fetchFn(`${GRAPH}/chats/${encodeURIComponent(chatId)}/messages/${messageId}`, {
    method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: { contentType: 'html', content: html } }),
  });
  return r.ok ? { ok: true } : { ok: false, status: r.status, error: (await r.text()).slice(0, 200) };
}

// Re-pin the index when the chat's pins no longer include it.
export async function ensurePinned(fetchFn, token, chatId, messageId) {
  const ids = await pinnedIds(fetchFn, token, chatId);
  if (ids === null) return { ok: false, error: 'cannot read pins' };
  if (ids.includes(messageId)) return { ok: true, already: true };
  return { ...(await pinMessage(fetchFn, token, chatId, messageId)), repinned: true };
}

// After a document message in the owner's 1:1. Never throws; returns what happened for the log.
export async function updateDocsIndex({ fetchFn, token, dir, chatId, sourceId, html, attachUrl, attachName, date = new Date().toISOString() }) {
  try {
    const links = extractDocLinks(html, { attachUrl, attachName });
    if (!links.length) return { ok: false, skipped: true, error: 'no named document links' };
    return await withLock(dir, async () => {
      const state = loadState(dir);
      if (!state?.messageId || state.chatId !== chatId) return { ok: false, skipped: true, error: 'no docs index for this chat (docs-index-cli.mjs post)' };
      const { state: next, rolled } = addEntry(state, { date, links, what: summarize(html), sourceId });
      const p = await patchMessage(fetchFn, token, chatId, state.messageId, renderIndex(next));
      if (!p.ok) return { ...p, error: `index PATCH failed: ${p.error}` };
      saveState(dir, { ...next, updatedAt: new Date().toISOString() }, rolled);
      const pin = await ensurePinned(fetchFn, token, chatId, state.messageId).catch((e) => ({ ok: false, error: e.message }));
      return { ok: true, added: links.length, rolled: rolled.length, pin };
    });
  } catch (e) { return { ok: false, error: e.message }; }
}

// Deep link to a chat message, e.g. for a seed's pinnedEntry.
export const teamsMessageLink = (chatId, messageId) =>
  `https://teams.microsoft.com/l/message/${encodeURIComponent(chatId)}/${messageId}?context=${encodeURIComponent('{"contextType":"chat"}')}`;
