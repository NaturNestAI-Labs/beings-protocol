// Docs index: link extraction, rendering, caps and archive, PATCH and re-pin with Graph mocked, never throwing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractDocLinks, linkName, summarize, renderIndex, addEntry, updateDocsIndex, teamsMessageLink, loadState, enabled, maxEntries } from './docs-index.mjs';

const jwt = (scp) => ['e30', Buffer.from(JSON.stringify({ scp })).toString('base64url'), 'sig'].join('.');
const TOK = jwt('Chat.ReadWrite ChatMessage.Send User.Read');
const CHAT = '19:a_b@unq.gbl.spaces';
const SP = 'https://example-my.sharepoint.com/personal/x/Documents/Shared/Docs/Plan/budget.xlsx';
const entry = (i, url = `https://example-my.sharepoint.com/d/${i}.pdf`) => ({ date: '2026-10-09T04:00:00Z', links: [{ name: `Doc ${i}`, url }], what: `doc number ${i}` });

test('off unless BEING_DOCS_INDEX=1; the entry cap comes from BEING_DOCS_INDEX_MAX', () => {
  assert.equal(enabled({}), false); assert.equal(enabled({ BEING_DOCS_INDEX: '1' }), true);
  assert.equal(maxEntries({}), 60); assert.equal(maxEntries({ BEING_DOCS_INDEX_MAX: '5' }), 5); assert.equal(maxEntries({ BEING_DOCS_INDEX_MAX: 'x' }), 60);
});

test('named doc links are extracted; plain links ignored; bare-URL text gets a file name', () => {
  const html = `<p>Ready: <a href="${SP}">Budget sheet</a>, PR <a href="https://github.com/o/r/pull/1">#1</a>, <a href="${SP}">dup</a>,
    <a href="https://x.sharepoint.com/_layouts/15/Doc.aspx?sourcedoc=%7BA%7D&amp;file=MAPPING.xlsx">https://x.sharepoint.com/_layouts/15/Doc.aspx</a></p>`;
  const l = extractDocLinks(html, { attachUrl: 'https://x.sharepoint.com/Documents/Shared/Docs/T/a.pdf' });
  assert.deepEqual(l.map((x) => x.name), ['Budget sheet', 'MAPPING.xlsx', 'a.pdf']);
  assert.equal(linkName('', 'https://x/Documents/My%20Report.pdf'), 'My Report.pdf');
  assert.deepEqual(extractDocLinks('<p>Deployed #232; tests pass.</p>'), []);
});

test('summary is the first sentence; render puts the pinned entry first, escaped, no bare URLs', () => {
  assert.equal(summarize('<p>The plan is ready. More later.</p>'), 'The plan is ready.');
  assert.ok(summarize('<p>' + 'word '.repeat(60) + '</p>').length <= 110);
  const html = renderIndex({ pinnedEntry: { date: '2026-10-05T04:55:00Z', links: [{ name: 'Earlier pin', url: teamsMessageLink(CHAT, '1791') }], what: 'everything to review' },
    entries: [{ date: '2026-10-09T04:01:00Z', links: [{ name: 'A <b>&', url: SP }], what: 'x' }] });
  assert.ok(html.startsWith('<p><b>📌 Docs index</b>'));
  assert.ok(html.indexOf('Earlier pin') < html.indexOf('A &lt;b&gt;&amp;'));
  assert.ok(html.includes('https://teams.microsoft.com/l/message/19%3Aa_b%40unq.gbl.spaces/1791?context='));
  assert.ok(!/>https?:\/\//.test(html), 'no bare URL text');
});

test('caps: max entries and byte budget roll the oldest off; a re-sent doc moves to the top', () => {
  let s = { entries: [] }; const rolled = [];
  for (let i = 1; i <= 65; i++) { const r = addEntry(s, entry(i), { max: 60 }); s = r.state; rolled.push(...r.rolled); }
  assert.equal(s.entries.length, 60);
  assert.deepEqual(rolled.map((e) => e.what), ['doc number 1', 'doc number 2', 'doc number 3', 'doc number 4', 'doc number 5']);
  const r = addEntry(s, entry(99, 'https://example-my.sharepoint.com/d/10.pdf'), { max: 60 });
  assert.equal(r.state.entries.filter((e) => e.links.some((l) => l.url.endsWith('/10.pdf'))).length, 1);
  const big = addEntry(s, entry(100), { max: 60, maxBytes: 3000 });
  assert.ok(Buffer.byteLength(renderIndex(big.state)) <= 3000 && big.rolled.length > 30);
});

function mockGraph({ patch = 204, pins = [], pinPost = 201, throwOn = null } = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const method = opts.method || 'GET'; calls.push({ method, url, body: opts.body });
    if (throwOn === method) throw new Error('network down');
    const res = (status, body = {}) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (method === 'PATCH') return res(patch);
    if (method === 'GET') return res(200, { value: pins.map((id) => ({ message: { id } })) });
    return res(pinPost);
  };
  return { fn, calls };
}
const seedDir = (state) => { const d = mkdtempSync(path.join(os.tmpdir(), 'dix-')); if (state) writeFileSync(path.join(d, 'docs-index.json'), JSON.stringify(state)); return d; };
const BASE = { chatId: CHAT, messageId: 'IDX', pinnedEntry: null, entries: [entry(1)] };
const DOC_HTML = `<p>Plan ready. <a href="${SP}">Budget sheet</a></p>`;

test('update PATCHes the index with the new entry on top, keeps it pinned, re-pins when needed', async () => {
  let dir = seedDir(BASE), g = mockGraph({ pins: ['IDX'] });
  let u = await updateDocsIndex({ fetchFn: g.fn, token: TOK, dir, chatId: CHAT, sourceId: 'M1', html: DOC_HTML });
  assert.ok(u.ok && u.added === 1 && u.pin.already);
  const content = JSON.parse(g.calls.find((c) => c.method === 'PATCH').body).body.content;
  assert.ok(content.indexOf('Budget sheet') < content.indexOf('Doc 1'));
  assert.equal(loadState(dir).entries[0].sourceId, 'M1');
  assert.ok(!g.calls.some((c) => c.method === 'POST'));
  dir = seedDir(BASE); g = mockGraph({ pins: ['OTHER'] });
  u = await updateDocsIndex({ fetchFn: g.fn, token: TOK, dir, chatId: CHAT, sourceId: 'M1', html: DOC_HTML });
  assert.ok(u.ok && u.pin.ok && u.pin.repinned);
  assert.ok(!existsSync(path.join(dir, 'docs-index.lock')), 'lock released');
});

test('rolled-off entries go to the archive file', async () => {
  const dir = seedDir({ ...BASE, entries: Array.from({ length: 60 }, (_, i) => entry(60 - i)) }), g = mockGraph({ pins: ['IDX'] });
  const u = await updateDocsIndex({ fetchFn: g.fn, token: TOK, dir, chatId: CHAT, sourceId: 'M1', html: DOC_HTML });
  assert.equal(u.rolled, 1);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'docs-index-archive.jsonl'), 'utf8').trim().split('\n')[0]).what, 'doc number 1');
});

test('update never throws, keeps state on failure, and skips without an index or doc links', async () => {
  for (const g of [mockGraph({ patch: 403 }), mockGraph({ throwOn: 'PATCH' })]) {
    const dir = seedDir(BASE);
    assert.equal((await updateDocsIndex({ fetchFn: g.fn, token: TOK, dir, chatId: CHAT, sourceId: 'M1', html: DOC_HTML })).ok, false);
    assert.equal(loadState(dir).entries.length, 1);
  }
  const g = mockGraph();
  assert.ok((await updateDocsIndex({ fetchFn: g.fn, token: TOK, dir: seedDir(null), chatId: CHAT, html: DOC_HTML })).skipped);
  assert.ok((await updateDocsIndex({ fetchFn: g.fn, token: TOK, dir: seedDir(BASE), chatId: '19:other', html: DOC_HTML })).skipped);
  assert.ok((await updateDocsIndex({ fetchFn: g.fn, token: TOK, dir: seedDir(BASE), chatId: CHAT, html: '<p>notes in the repo</p>' })).skipped);
  assert.equal(g.calls.length, 0);
});
