#!/usr/bin/env node
// Unsent drafts in a shared mailbox through the owner's session; sends only a named, reviewed batch after a go.
// Usage: README.md "Shared mailbox drafts". Dry run unless --create / --update / send with a valid go.
import './oa-env.mjs';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fail } from './graph.mjs';
import { openOwnerAccess, preflight, requireGo, logAsOwner, reportToOwner, esc, beingTeams } from './owner-session.mjs';
import { draftsRoute, guardedGraph, browserRequestAllowed, OUTLOOK_API } from './guards.mjs';
import { sealManifests, checkManifestSet, renderManifestSet, checkSetApproval } from './manifest-set.mjs';
import { loadConfig, approversFor } from './oa-config.mjs';
import { routeFor } from './browser-route.mjs';
import { outlookFromBrowser } from './owner-browser.mjs';
import { normalizeDraft, draftKey, rcpts, validateManifest, preflightProblems, matchOwn } from './mailbox-lib.mjs';
import { planOf, withLedger, fingerprint } from './ledger.mjs';

const { positionals: [cmd], values: o } = parseArgs({ allowPositionals: true, options: {
  input: { type: 'string' }, attach: { type: 'string' }, limit: { type: 'string' }, create: { type: 'boolean' }, update: { type: 'boolean' },
  body: { type: 'boolean' }, batch: { type: 'string' }, out: { type: 'string' }, manifest: { type: 'string', multiple: true }, preview: { type: 'string' }, 'approver-id': { type: 'string' }, 'dry-run': { type: 'boolean' },
  'go-chat': { type: 'string' }, 'go-msg': { type: 'string' } } });
const USAGE = 'usage: shared-mailbox-drafts.mjs create --input drafts.json [--attach f] [--limit N] [--create]\n'
  + '  | update --input drafts.json [--body] [--update]  | plan --batch <name> --input drafts.json [--attach f] --out manifest.json\n'
  + '  | plan-set --manifest file [--manifest file ...] --approver-id <id> [--dry-run]\n'
  + '  | send --preview file --go-chat <id> --go-msg <id>\n'
  + '  | preflight --manifest m.json  | send --manifest m.json --go-chat <id> --go-msg <id>  | sent-check --manifest m.json';
if (!['create', 'update', 'plan', 'plan-set', 'preflight', 'send', 'sent-check'].includes(cmd)) fail(USAGE, 2);
const SEND = cmd === 'send';
const ability = SEND ? 'shared_mailbox_send' : 'shared_mailbox_drafts';
const really = (cmd === 'create' && o.create) || (cmd === 'update' && o.update) || SEND;

// route "graph" (owner API session) or "browser" (owner's Outlook web session), from owner-access.toml.
const ROUTE = (() => { try { return routeFor(loadConfig(), ability); } catch (e) { return fail(e.message, 2); } })();
const s0 = preflight(ability, { services: [ROUTE === 'browser' ? 'browser' : 'outlook'] });
const box = s0.cfg.shared_mailbox || {};
const MAILBOX = String(box.address || '').toLowerCase();
if (!MAILBOX) fail('set [shared_mailbox] address in owner-access.toml', 2);
const AREA = box.area || 'shared_mailbox';
const DIR = path.join(s0.state, 'owner-access', 'shared-mailbox');
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const OWN_F = path.join(DIR, `${MAILBOX}-own.jsonl`);
const own = () => (existsSync(OWN_F) ? readFileSync(OWN_F, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const loadInput = () => {
  if (!o.input) fail('--input drafts.json is required', 2);
  const rows = JSON.parse(readFileSync(o.input, 'utf8'));
  if (!Array.isArray(rows)) fail('input must be a JSON array', 2);
  return rows.map((r, i) => normalizeDraft(r, `row ${i + 1}`)).slice(0, o.limit ? Number(o.limit) : undefined);
};
const attachment = () => {
  if (!o.attach) return null;
  if (statSync(o.attach).size >= 3e6) fail('attachment must be under 3 MB', 2);
  return { '@odata.type': '#microsoft.graph.fileAttachment', name: path.basename(o.attach), contentBytes: readFileSync(o.attach).toString('base64') };
};
const checkOwned = (m) => { validateManifest(m); if (m.mailbox !== MAILBOX) fail('manifest is for another mailbox', 2);
  const mine = new Set(own().map((d) => d.id));
  if (m.rows.some((r) => !mine.has(r.id))) fail('manifest lists a draft the Being did not create', 2);
  return m;
};
const loadManifest = () => {
  if (o.manifest?.length !== 1) fail('legacy send requires exactly one --manifest', 2);
  return checkOwned(JSON.parse(readFileSync(o.manifest[0], 'utf8')));
};

if (cmd === 'plan-set') {
  const sealed = sealManifests(o.manifest || []);
  sealed.entries.forEach((e) => checkOwned(e.manifest));
  if (!o['approver-id']) fail('plan-set needs --approver-id from configured approvers', 2);
  const batches = path.join(s0.state, 'batches');
  mkdirSync(batches, { recursive: true, mode: 0o700 });
  const ids = readdirSync(batches).filter((f) => /^B\d+\.json$/.test(f)).map((f) => Number(f.slice(1, -5)));
  const p = { id: `B${Math.max(0, ...ids) + 1}`, kind: 'shared-manifest-set', ...sealed,
    approverId: o['approver-id'], created: new Date().toISOString(), status: 'open', rows: [] };
  const html = renderManifestSet(p);
  if (o['dry-run']) { console.log(html); process.exit(0); }
  const { g } = await beingTeams(s0);
  const allowed = approversFor(s0.cfg, AREA, s0.ownerUpn);
  const chats = await g(`/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`);
  const matches = (chats.value || []).filter((c) => c.chatType === 'oneOnOne' && c.members?.length === 2
    && c.members.some((m) => m.userId === p.approverId && allowed.has(String(m.email || '').toLowerCase()))
    && c.members.some((m) => String(m.email || '').toLowerCase() === s0.beingUpn));
  if (matches.length !== 1) fail('need exactly one verified 1:1 with the configured approver', 3);
  const file = path.join(batches, `${p.id}.json`);
  writeFileSync(file, JSON.stringify({ ...p, status: 'unposted' }), { flag: 'wx', mode: 0o600 });
  const posted = await g(`/chats/${encodeURIComponent(matches[0].id)}/messages`, { body: { body: { contentType: 'html', content: html } } });
  if (!posted.id || !posted.createdDateTime) fail('preview delivery could not be verified', 3);
  writeFileSync(file, JSON.stringify({ ...p, promptChatId: matches[0].id, promptMessageId: posted.id, promptAt: posted.createdDateTime }), { mode: 0o600 });
  console.log(`${p.id}: preview posted; approver types SEND once.`);
  process.exit(0);
}

// Offline dry runs need no sign-in.
if (cmd === 'create' && !really) {
  const rows = loadInput(), a = attachment();
  for (const r of rows) console.log(`WOULD CREATE: ${r.to.join('; ')}${r.cc.length ? ` cc ${r.cc.join('; ')}` : ''} | ${r.subject}${a ? ` | ${a.name}` : ''}`);
  console.log(`dry run: ${rows.length} draft(s); existing drafts are checked with --create`);
  process.exit(0);
}

const scopes = SEND ? ['Mail.ReadWrite.Shared', 'Mail.Send.Shared'] : ['Mail.ReadWrite.Shared'];
const access = { own: new Set(own().map((d) => d.id)), sendIds: new Set(), sentItems: false };
let s = s0, g;
if (ROUTE === 'graph') {
  const { s: s1, owner } = await openOwnerAccess(ability, { services: ['outlook'], ownerScopes: { outlook: scopes } });
  s = s1;
  g = guardedGraph(owner.outlook.token, (url, method) => draftsRoute(MAILBOX, url, method, access));
} else {
  try {
    g = await outlookFromBrowser(s, { mailbox: MAILBOX, scope: 'Mail.ReadWrite.Shared', browserGuard: browserRequestAllowed,
      allow: (url, method) => draftsRoute(MAILBOX, url, method, { ...access, base: OUTLOOK_API }) });
  } catch (e) { fail(`browser route: ${e.message}`, 6); }
}
const H = { Prefer: 'IdType="ImmutableId"' };
const ROOT = `/users/${encodeURIComponent(MAILBOX)}`;
const folder = await g(`${ROOT}/mailFolders/drafts?$select=id`, { headers: H });
const FIELDS = '$select=id,subject,toRecipients,ccRecipients,from,isDraft,parentFolderId,hasAttachments';
const readDraft = async (id) => {
  const m = await g(`${ROOT}/messages/${encodeURIComponent(id)}?${FIELDS}`, { headers: H, allow404: true });
  const atts = m ? (await g(`${ROOT}/messages/${encodeURIComponent(id)}/attachments?$select=name,size,isInline`, { headers: H })).value : [];
  return { m, atts };
};
// $skip pages on both routes: Outlook REST paging links spell the mailbox differently and would miss the allowlist.
const listAll = async (url, max = 20) => {
  const out = [];
  for (let n = 0; n < max; n++) { const p = await g(`${url}&$top=100&$skip=${n * 100}`, { headers: H }); out.push(...(p.value || [])); if ((p.value || []).length < 100) break; }
  return out;
};
const sentKeys = async () => {
  access.sentItems = true;
  const seen = new Map();
  for (const m of await listAll(`${ROOT}/mailFolders/sentitems/messages?$select=subject,toRecipients,ccRecipients,sentDateTime&$orderby=sentDateTime desc`, 5)) {
    const k = draftKey(m.subject || '', rcpts(m.toRecipients)); seen.set(k, [...(seen.get(k) || []), rcpts(m.ccRecipients)]);
  }
  access.sentItems = false;
  return seen;
};

try {
  if (cmd === 'create') {
    const rows = loadInput(), a = attachment();
    const existing = new Set((await listAll(`${ROOT}/mailFolders/drafts/messages?$select=subject,toRecipients`)).map((m) => draftKey(m.subject || '', rcpts(m.toRecipients))));
    let made = 0;
    for (const r of rows) {
      const k = draftKey(r.subject, r.to);
      if (existing.has(k)) { console.log(`SKIP (draft exists): ${r.to.join('; ')} | ${r.subject}`); continue; }
      const rc = (l) => l.map((x) => ({ emailAddress: { address: x } }));
      const m = await g(`${ROOT}/messages`, { method: 'POST', headers: H, body: { subject: r.subject, body: { contentType: 'html', content: r.html },
        toRecipients: rc(r.to), ccRecipients: rc(r.cc), from: { emailAddress: { address: MAILBOX } }, ...(a && { attachments: [a] }) } });
      appendFileSync(OWN_F, JSON.stringify({ id: m.id, subject: r.subject, to: r.to, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
      existing.add(k); access.own.add(m.id);
      const { m: back, atts } = await readDraft(m.id);
      const p = preflightProblems({ ...r, attachment: a?.name || '' }, back, atts, folder.id, MAILBOX);
      if (p.length) { console.log(`CREATED BUT CHECK FAILED: ${r.subject} -> ${p.join(', ')}`); process.exitCode = 1; break; }
      made++;
      logAsOwner(ability, { channel: 'mail', mailbox: MAILBOX, action: 'draft-created', to: r.to, subject: r.subject });
      console.log(`CREATED: ${r.to.join('; ')} | ${r.subject}`);
    }
    if (made) reportToOwner(s, `Created ${made} unsent draft(s) in ${esc(MAILBOX)} as you. Nothing was sent.`);
  } else if (cmd === 'update') {
    const rows = loadInput(), mine = own();
    let changed = 0;
    for (const r of rows) {
      const hit = matchOwn(mine, r);
      if (hit.length !== 1) { console.log(`SKIP (${hit.length} own drafts match): ${r.subject}`); process.exitCode = 1; continue; }
      const { m } = await readDraft(hit[0].id);
      if (!m || m.isDraft !== true || m.parentFolderId !== folder.id) { console.log(`SKIP (no longer an unsent draft): ${r.subject}`); continue; }
      const cc = [...new Set([...rcpts(m.ccRecipients), ...r.cc])];
      const patch = { ...(cc.length !== rcpts(m.ccRecipients).length && { ccRecipients: cc.map((x) => ({ emailAddress: { address: x } })) }),
        ...(o.body && { body: { contentType: 'html', content: r.html } }) };
      if (!Object.keys(patch).length) { console.log(`UNCHANGED: ${r.subject}`); continue; }
      if (!really) { console.log(`WOULD UPDATE: ${r.subject} (${Object.keys(patch).join(', ')})`); continue; }
      await g(`${ROOT}/messages/${encodeURIComponent(m.id)}`, { method: 'PATCH', headers: H, body: patch });
      changed++;
      logAsOwner(ability, { channel: 'mail', mailbox: MAILBOX, action: 'draft-updated', subject: r.subject, fields: Object.keys(patch) });
      console.log(`UPDATED: ${r.subject}`);
    }
    if (changed) reportToOwner(s, `Edited ${changed} of my own unsent draft(s) in ${esc(MAILBOX)}. Nothing was sent.`);
  } else if (cmd === 'plan') {
    if (!o.batch || !o.out) fail('plan needs --batch and --out', 2);
    const mine = own(), a = o.attach ? path.basename(o.attach) : '';
    const rows = loadInput().map((r) => {
      const hit = matchOwn(mine, r);
      if (hit.length !== 1) fail(`${r.subject}: ${hit.length} own drafts match (need exactly one)`, 2);
      return { id: hit[0].id, to: r.to, cc: r.cc, subject: r.subject, attachment: a };
    });
    const manifest = validateManifest({ batch: o.batch, mailbox: MAILBOX, created: new Date().toISOString(), rows });
    writeFileSync(o.out, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    console.log(`manifest ${o.out}: ${rows.length} draft(s). After review, an approver types in their 1:1 with the Being:\n  go ${o.batch} ${fingerprint(manifest)}`);
  } else {
    const preview = o.preview ? JSON.parse(readFileSync(o.preview, 'utf8')) : null;
    if (preview && (!SEND || preview.kind !== 'shared-manifest-set' || preview.status !== 'open')) throw new Error('preview is not open for sending');
    const manifests = preview ? checkManifestSet(preview, o.manifest).map(checkOwned) : [loadManifest()];
    let approval;
    if (preview) {
      approval = await requireGo(s, { area: AREA, expect: 'SEND', chatId: o['go-chat'], msgId: o['go-msg'], notBefore: preview.promptAt, receipt: true,
        verify: async (got) => {
          if (existsSync(path.join(s.state, 'batches', 'STOP')) || existsSync(path.join(s.state, 'batches', `${preview.id}.stop`))) throw new Error('batch stopped');
          const active = readdirSync(path.join(s.state, 'batches')).filter((f) => /^B\d+\.json$/.test(f))
            .map((f) => JSON.parse(readFileSync(path.join(s.state, 'batches', f), 'utf8')))
            .filter((b) => ['open', 'partial', 'sending'].includes(b.status) && Date.now() - Date.parse(b.created) < 24 * 3600e3);
          if (active.length !== 1 || active[0].id !== preview.id) throw new Error('SEND is ambiguous; need exactly one active preview');
          if (active[0].digest !== preview.digest || JSON.stringify(active[0].entries) !== JSON.stringify(preview.entries)) throw new Error('stored manifest set changed after approval');
          const prompt = await got.g(`/chats/${encodeURIComponent(preview.promptChatId)}/messages/${encodeURIComponent(preview.promptMessageId)}`);
          checkSetApproval({ ...got, preview, prompt, beingUpn: s.beingUpn });
          checkManifestSet(preview, o.manifest);
        } });
      writeFileSync(o.preview, JSON.stringify({ ...preview, status: 'sending' }), { mode: 0o600 });
    }
    for (const m of manifests) {
      const fp = fingerprint(m), ledgerFile = path.join(DIR, `${m.batch}.ledger.jsonl`);
      const plan = planOf(m.batch, m.rows.map((r) => ({ id: r.id, kind: 'mail', title: r.subject })));
      const sent = await sentKeys();
      const inSent = (r) => (sent.get(draftKey(r.subject, r.to)) || []).some((cc) => r.cc.every((c) => cc.includes(c)));
      if (cmd === 'sent-check') {
        const missing = m.rows.filter((r) => !inSent(r));
        console.log(`in Sent Items: ${m.rows.length - missing.length}/${m.rows.length}`);
        for (const r of missing) console.log(`NOT IN SENT ITEMS: ${r.subject}`);
        process.exit(missing.length ? 1 : 0);
      }
      if (SEND && !preview) approval = await requireGo(s, { area: AREA, expect: `go ${m.batch} ${fp}`, chatId: o['go-chat'], msgId: o['go-msg'], notBefore: m.created, receipt: true });
      await withLedger(ledgerFile, plan, async (ledger) => {
        const problems = [];
        for (const r of m.rows) {
          const st = ledger.records.get(r.id)?.state;
          if (st === 'done') { console.log(`ALREADY SENT (ledger): ${r.subject}`); continue; }
          const { m: msg, atts } = await readDraft(r.id);
          // A send that was started but not confirmed counts as done only when the draft left Drafts and is in Sent Items.
          if (st === 'started') {
            if (!msg && inSent(r)) { await ledger.put({ id: r.id, kind: 'mail' }, 'done', { reconciled: true }); console.log(`CONFIRMED SENT: ${r.subject}`); continue; }
            problems.push(`${r.subject}: unconfirmed send from an earlier run; check Sent Items by hand`); continue;
          }
          const p = preflightProblems(r, msg, atts, folder.id, MAILBOX);
          console.log(`${p.length ? 'PREFLIGHT FAIL' : 'PREFLIGHT OK'}: ${r.to.join('; ')} | ${r.subject}${p.length ? ` -> ${p.join(', ')}` : ''}`);
          if (p.length) problems.push(`${r.subject}: ${p.join(', ')}`);
        }
        if (problems.length) throw new Error(`not sending: ${problems.join(' | ')}`);
        if (!SEND) { console.log(`preflight ok; go command: go ${m.batch} ${fp}`); return; }
        const pending = m.rows.filter((r) => ledger.records.get(r.id)?.state !== 'done');
        const gap = Number(box.send_gap_seconds ?? 3) * 1000;
        let n = 0;
        for (const r of pending) {
          if (n) await new Promise((res) => setTimeout(res, gap));
          await approval.recheck();
          access.sendIds = new Set([r.id]);
          await ledger.put({ id: r.id, kind: 'mail' }, 'started');
          if (preview) checkManifestSet(preview, o.manifest);
          approval.assertFresh();
          await g(`${ROOT}/messages/${encodeURIComponent(r.id)}/send`, { method: 'POST', headers: H });
          await ledger.put({ id: r.id, kind: 'mail' }, 'done');
          access.sendIds = new Set();
          n++;
          logAsOwner(ability, { channel: 'mail', mailbox: MAILBOX, action: 'sent', batch: m.batch, to: r.to, cc: r.cc, subject: r.subject });
          console.log(`SENT ${n}/${pending.length}: ${r.to.join('; ')} | ${r.subject}`);
        }
        const after = await sentKeys();
        const missing = m.rows.filter((r) => !(after.get(draftKey(r.subject, r.to)) || []).some((cc) => r.cc.every((c) => cc.includes(c))));
        reportToOwner(s, `Sent batch <b>${esc(m.batch)}</b> from ${esc(MAILBOX)} as you: ${n} sent now, ${m.rows.length - pending.length} earlier; `
          + `${m.rows.length - missing.length}/${m.rows.length} confirmed in Sent Items.`);
        if (missing.length) { for (const r of missing) console.log(`NOT YET IN SENT ITEMS: ${r.subject}`); process.exitCode = 1; }
      });
    }
    if (preview) writeFileSync(o.preview, JSON.stringify({ ...preview, status: 'done' }), { mode: 0o600 });
  }
} catch (e) { fail(`shared-mailbox-drafts: ${e.message}`); }
