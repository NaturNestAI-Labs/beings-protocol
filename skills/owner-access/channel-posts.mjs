#!/usr/bin/env node
// Posts a reviewed batch in one allowed Teams channel as the owner, after a go: uploads each file to the channel's
// folder, checks it arrived intact, then posts one by one with a ledger. Usage: README.md "Channel posts as owner".
import './oa-env.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fail } from './graph.mjs';
import { loadConfig, KIT } from './oa-config.mjs';
import { openOwnerAccess, preflight, requireGo, logAsOwner, reportToOwner, esc } from './owner-session.mjs';
import { channelRoute, guardedGraph, isM365Host, sharePointRoute, teamsWebAllowed } from './guards.mjs';
import { validateChannelManifest, batchFingerprint, channelPlan, messageBody, browserTarget, OFFICE } from './channel-lib.mjs';
import { routeFor, channelLink, postText } from './browser-route.mjs';
import { launchOwnerBrowser, sharePointWhoAmI } from './owner-browser.mjs';
import { sha256, withLedger, pendingOps } from './ledger.mjs';

const { positionals: [cmd], values: o } = parseArgs({ allowPositionals: true, options: {
  manifest: { type: 'string' }, out: { type: 'string' }, 'go-chat': { type: 'string' }, 'go-msg': { type: 'string' } } });
if (!['preview', 'apply'].includes(cmd) || !o.manifest) fail('usage: channel-posts.mjs preview --manifest m.json [--out dir] | apply --manifest m.json --go-chat <id> --go-msg <id>', 2);

const cfg = loadConfig();
const m = (() => { try { return validateChannelManifest(JSON.parse(readFileSync(o.manifest, 'utf8')), cfg.channel_posts?.allowed || []); } catch (e) { return fail(`manifest: ${e.message}`, 2); } })();
const bytes = {}, hashes = {};
for (const p of m.posts) for (const f of p.files || []) { bytes[f] = readFileSync(f); hashes[f] = sha256(bytes[f]); }
const fp = batchFingerprint(m, hashes), plan = channelPlan(m, hashes), GO = `go ${m.batch} ${fp}`;

if (cmd === 'preview') {
  // Local only: an HTML page the approver reviews; nothing is sent or uploaded.
  const dir = o.out || path.dirname(path.resolve(o.manifest));
  mkdirSync(dir, { recursive: true });
  const html = `<!doctype html><meta charset="utf-8"><title>${esc(m.batch)}</title><body style="font-family:sans-serif;max-width:52rem;margin:2rem auto">`
    + `<h1>Batch ${esc(m.batch)}</h1><p>Channel ${esc(m.team)} / ${esc(m.channel)}, folder <b>${esc(m.folder)}</b>. Approve by typing <code>${esc(GO)}</code></p>`
    + m.posts.map((p) => `<hr><h2>${esc(p.title)}</h2>${p.body_html || `<p>${esc(p.body_text).replace(/\n/g, '<br>')}</p>`}<ul>`
      + (p.files || []).map((f) => `<li>${esc(path.basename(f))} (${Math.ceil(bytes[f].length / 1024)} KB, sha256 ${hashes[f].slice(0, 12)})</li>`).join('') + '</ul>').join('');
  const out = path.join(dir, `${m.batch}.preview.html`);
  writeFileSync(out, html, { mode: 0o600 });
  console.log(`preview: ${out}\n${m.posts.length} post(s), ${Object.keys(hashes).length} file(s). After review, an approver types in their 1:1 with the Being:\n  ${GO}`);
  process.exit(0);
}

// Route "graph" (owner API session) or "browser" (owner's Teams web + SharePoint session), from owner-access.toml.
const ROUTE = (() => { try { return routeFor(cfg, 'channel_posts'); } catch (e) { return fail(e.message, 2); } })();
const target = ROUTE === 'browser' ? (() => { try { return browserTarget(m, cfg.channel_posts?.browser_folders || []); } catch (e) { return fail(`manifest: ${e.message}`, 2); } })() : null;
let s, adapter;
if (ROUTE === 'graph') {
  const opened = await openOwnerAccess('channel_posts', { services: ['teams'],
    ownerScopes: { teams: ['ChannelMessage.Send', 'Channel.ReadBasic.All', 'Files.ReadWrite.All'] } });
  s = opened.s; adapter = graphAdapter(opened.owner.teams);
} else {
  s = preflight('channel_posts', { services: ['browser'] });
}
await requireGo(s, { area: cfg.channel_posts?.area || 'channel_posts', expect: GO, chatId: o['go-chat'], msgId: o['go-msg'], notBefore: m.created });
const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

// Same bytes, or (Office files only) the same package apart from metadata SharePoint adds on upload.
function verify(name, src, got) {
  if (sha256(src) === sha256(got)) return;
  if (!OFFICE.test(name)) throw new Error(`${name}: uploaded bytes differ`);
  const t = mkdtempSync(path.join(tmpdir(), 'oa-verify-'));
  try {
    writeFileSync(path.join(t, 'a'), src); writeFileSync(path.join(t, 'b'), got);
    execFileSync('python3', ['-I', path.join(KIT, 'verify-upload.py'), path.join(t, 'a'), path.join(t, 'b')], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { throw new Error(`${name}: ${String(e.stderr || e.message).trim().split('\n').pop()}`); } finally { rmSync(t, { recursive: true, force: true }); }
}

// Graph: files into the channel's files folder, posts with reference attachments.
function graphAdapter(sess) {
  const where = { team: m.team, channel: m.channel }, token = sess.token, ownerId = sess.me.id;
  const g = guardedGraph(token, (url, method) => channelRoute(where, url, method));
  const CH = `/teams/${encodeURIComponent(m.team)}/channels/${encodeURIComponent(m.channel)}`;
  const itemPath = (name) => `/drives/${encodeURIComponent(where.driveId)}/items/${encodeURIComponent(where.folderId)}:/${enc(`${m.folder}/${name}`)}:`;
  return {
    async init() { await g(CH); const ff = await g(`${CH}/filesFolder`); Object.assign(where, { driveId: ff.parentReference.driveId, folderId: ff.id }); },
    async findItem(name) { const it = await g(itemPath(name).slice(0, -1), { allow404: true }); return it && { itemId: it.id, eTag: it.eTag, webUrl: it.webUrl }; },
    async download(row) {
      // Follows the Graph redirect to a Microsoft 365 host only.
      const r = await fetch(`https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(where.driveId)}/items/${encodeURIComponent(row.itemId)}/content`,
        { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
      let res = r;
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!isM365Host(loc)) throw new Error('download redirected outside Microsoft 365');
        res = await fetch(loc, { redirect: 'error' });
      }
      if (!res.ok) throw new Error(`download failed HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async upload(name, data) {
      const at = itemPath(name);
      let it;
      if (data.length <= 4e6) it = await g(`${at}/content?@microsoft.graph.conflictBehavior=fail`, { method: 'PUT', body: data });
      else {
        const { uploadUrl } = await g(`${at}/createUploadSession`, { method: 'POST', body: { item: { '@microsoft.graph.conflictBehavior': 'fail' } } });
        if (!isM365Host(uploadUrl)) throw new Error('upload session is outside Microsoft 365');
        for (let off = 0; off < data.length; off += 5 * 327680) {
          const end = Math.min(off + 5 * 327680, data.length);
          const r = await fetch(uploadUrl, { method: 'PUT', redirect: 'error', body: data.subarray(off, end), headers: { 'Content-Range': `bytes ${off}-${end - 1}/${data.length}` } });
          if (!r.ok) throw new Error(`chunk upload failed HTTP ${r.status}`);
          if (end === data.length) it = await r.json();
        }
      }
      return { itemId: it.id, eTag: it.eTag, webUrl: it.webUrl };
    },
    async findPost(title) { return !!(await g(`${CH}/messages?$top=50`)).value?.find((x) => x.subject === title && x.from?.user?.id === ownerId && !x.deletedDateTime); },
    async post(post, items) { const msg = await g(`${CH}/messages`, { method: 'POST', body: messageBody(post, items) }); return { messageId: msg.id, webUrl: msg.webUrl }; },
    async close() {},
  };
}

// Browser: files through SharePoint REST with the owner's cookies, posts typed into Teams web; no clicks outside the
// composer, and the page may post only into this channel (guards.teamsWebAllowed).
async function browserAdapter() {
  const b = await launchOwnerBrowser(s, { guard: (method, url) => teamsWebAllowed(method, url, { channel: m.channel }) });
  const sub = `${target.folder}/${m.folder}`, origin = new URL(target.site).origin;
  const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
  const sp = async (route, { method = 'GET', data, allow404 = false, json = true } = {}) => {
    const url = `${target.site}/_api/${route}`;
    const body = data === undefined || Buffer.isBuffer(data) ? data : JSON.stringify(data);
    if (!sharePointRoute(target, url, method, Buffer.isBuffer(body) ? '' : body)) throw new Error(`refused: ${method} ${route.split('(')[0]} is outside this tool's allowlist`);
    const headers = { Accept: 'application/json;odata=nometadata' };
    if (method === 'POST' && route !== 'contextinfo') {
      headers['X-RequestDigest'] = (await sp('contextinfo', { method: 'POST' })).FormDigestValue;
      headers['Content-Type'] = Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json;odata=nometadata';
    }
    const r = await b.ctx.request.fetch(url, { method, data: body, headers, maxRedirects: 0, timeout: 120000 });
    if (allow404 && r.status() === 404) return null;
    if (!r.ok()) throw new Error(`SharePoint ${method} failed HTTP ${r.status()}`);
    return json ? r.json() : r.body();
  };
  const fileRoute = (name) => `web/GetFileByServerRelativeUrl(${encodeURIComponent(lit(`${sub}/${name}`))})`;
  const page = b.page;
  const subject = page.getByRole('textbox', { name: 'Add a subject', exact: true });
  const body = page.getByRole('textbox', { name: 'Type a message', exact: true });
  const newPost = page.getByRole('button', { name: /^(Post in channel|Start a post|New post)$/ });
  return {
    async init() {
      await sharePointWhoAmI(b.ctx, origin, s.ownerUpn);
      if (!(await sp(`web/GetFolderByServerRelativeUrl(${encodeURIComponent(lit(sub))})?$select=Name`, { allow404: true }))) {
        await sp('web/folders', { method: 'POST', data: { ServerRelativeUrl: sub } });
      }
      await page.goto(channelLink(m.team, m.channel), { waitUntil: 'domcontentloaded', timeout: 90000 });
      const web = page.getByRole('button', { name: /use the web app instead/i });
      if (await web.count().catch(() => 0)) await web.first().click();
      await newPost.first().waitFor({ state: 'visible', timeout: 90000 }).catch(() => { throw new Error('Teams web did not open the channel (signed out, or layout not recognised)'); });
    },
    async findItem(name) {
      const f = await sp(`${fileRoute(name)}?$select=Name,ServerRelativeUrl`, { allow404: true });
      return f && { path: f.ServerRelativeUrl, webUrl: origin + enc(f.ServerRelativeUrl) };
    },
    async download(row) { return sp(`web/GetFileByServerRelativeUrl(${encodeURIComponent(lit(row.path))})/$value`, { json: false }); },
    async upload(name, data) {
      if (data.length > 200e6) throw new Error(`${name}: over 200 MB, use the graph route`);
      await sp(`web/GetFolderByServerRelativeUrl(${encodeURIComponent(lit(sub))})/Files/add(url=${encodeURIComponent(lit(name))},overwrite=false)`, { method: 'POST', data });
      return { path: `${sub}/${name}`, webUrl: origin + enc(`${sub}/${name}`) };
    },
    async findPost(title) { return (await page.getByText(title, { exact: true }).count()) > 0; },
    async post(post, items) {
      if (await subject.count()) throw new Error('a post draft is already open in the channel; refusing to replace it');
      await newPost.first().click();
      await subject.waitFor({ state: 'visible', timeout: 15000 });
      await subject.fill(post.title.trim());
      await body.fill(postText(post, items.map((x) => ({ name: x.name, url: x.webUrl }))));
      await page.getByRole('button', { name: 'Post', exact: true }).click();
      await subject.waitFor({ state: 'hidden', timeout: 30000 });
      await page.getByText(post.title.trim(), { exact: true }).first().waitFor({ state: 'visible', timeout: 30000 });
      return { route: 'browser' };
    },
    close: b.close,
  };
}

try {
  if (ROUTE === 'browser') adapter = await browserAdapter();
  await adapter.init();
  const posted = [];
  await withLedger(path.join(s.state, 'owner-access', `channel-${m.batch}.ledger.jsonl`), plan, async (ledger) => {
    // Reconcile actions an earlier run started but never confirmed, from what is actually in the channel and folder.
    const reconciled = new Set();
    for (const op of plan.operations.filter((x) => ledger.records.get(x.id)?.state === 'started')) {
      if (op.kind === 'file') {
        const it = await adapter.findItem(op.name);
        if (it) { verify(op.name, bytes[op.source], await adapter.download(it)); await ledger.put(op, 'done', { ...it, reconciled: true }); reconciled.add(op.id); }
      } else if (await adapter.findPost(op.title)) { await ledger.put(op, 'done', { reconciled: true }); reconciled.add(op.id); }
    }
    for (const op of pendingOps(plan, ledger.records, { reconciled })) {
      if (op.kind === 'file') {
        if (await adapter.findItem(op.name)) throw new Error(`${m.folder}/${op.name} already exists and is not in this batch's ledger; refusing to overwrite`);
        await ledger.put(op, 'started');
        const it = await adapter.upload(op.name, bytes[op.source]);
        verify(op.name, bytes[op.source], await adapter.download(it));
        await ledger.put(op, 'done', it);
        logAsOwner('channel_posts', { channel: 'teams', action: 'file-uploaded', route: ROUTE, batch: m.batch, team: m.team, chan: m.channel, name: op.name, sha256: op.sha256 });
        console.log(`UPLOADED + VERIFIED: ${m.folder}/${op.name}`);
      } else {
        if (await adapter.findPost(op.title)) throw new Error(`a post titled "${op.title}" already exists and is not in this batch's ledger`);
        const items = plan.operations.filter((x) => x.kind === 'file' && x.post === op.post).map((x) => ({ name: x.name, ...ledger.records.get(x.id) }));
        await ledger.put(op, 'started');
        await ledger.put(op, 'done', await adapter.post(m.posts[op.post], items));
        posted.push(op.title);
        logAsOwner('channel_posts', { channel: 'teams', action: 'posted', route: ROUTE, batch: m.batch, team: m.team, chan: m.channel, subject: op.title });
        console.log(`POSTED: ${op.title}`);
      }
    }
  });
  reportToOwner(s, `Posted batch <b>${esc(m.batch)}</b> in the channel as you: ${posted.length} post(s) now (${esc(posted.join(', ') || 'none new')}); every file checked after upload.`);
} catch (e) {
  reportToOwner(s, `Channel batch <b>${esc(m.batch)}</b> stopped: ${esc(e.message.slice(0, 200))}. Nothing after that step was posted.`);
  process.exitCode = 1;
  console.error(`channel-posts: ${e.message}`);
} finally { await adapter?.close(); }
