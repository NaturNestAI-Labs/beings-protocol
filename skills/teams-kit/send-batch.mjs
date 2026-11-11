#!/usr/bin/env node
// Owner-approved mail batches: one preview in the owner's 1:1, one "SEND Bn" typed by the owner, then each mail goes once.
// Usage: README.md "Mail batches". The command is re-read from Graph as in approve.mjs; GUARDRAILS.md "Sending as the owner".
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, readdirSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, need, stateDir, fail, standby, beingSender } from './graph.mjs';
import { logComms } from './comms-log.mjs';
import { toHtml } from './fmt.mjs';
import { findSecrets, findSecretsInFiles } from './secrets.mjs';
import { fingerprint as draftFingerprint, MAX_AGE_H, replyRecipients } from './approval.mjs';
import { mailCache, kitEnv, ownerDelegate } from './kit-env.mjs';
import { parseDraftRange, dedupeRows, batchFingerprint, renderBatchPrompt, checkBatchCommand, checkBatchPrompt, parseCsv,
  fillTemplate, runBatch, summaryText, MAX_ROWS, BATCH_ID_RE } from './batch-lib.mjs';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i === -1 ? '' : (argv[i + 1] ?? ''); };
const has = (f) => argv.includes(f);
const [cmd, arg1] = argv;
const USAGE = 'usage: send-batch.mjs plan --drafts D45-D79 [--label L] [--dry-run]\n'
  + '  | plan --manifest file [--manifest file ...] --approver-id <configured id> [--dry-run]\n'
  + '  | plan --recipients list.csv --subject S [--cc a,b] [--attach /abs/f] [--label L] [--dry-run] < template.md\n'
  + '  | send [Bn] --chat <owner 1:1> --msg <owner command id>  | skip Bn --chat .. --msg ..\n'
  + '  | dry-run Bn  | status [Bn]  | stop Bn';
const GAP_S = Math.max(5, Number(process.env.BEING_BATCH_GAP_SEC || 20));
const here = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(stateDir(), 'batches'), DDIR = path.join(stateDir(), 'drafts');
mkdirSync(DIR, { recursive: true, mode: 0o700 });
const USED = path.join(DDIR, 'used-commands.txt');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const bfile = (id) => path.join(DIR, `${id}.json`);
const loadB = (id) => { if (!BATCH_ID_RE.test(id || '') || !existsSync(bfile(id))) return null; return JSON.parse(readFileSync(bfile(id), 'utf8')); };
const saveB = (b) => { const t = `${bfile(b.id)}.tmp`; writeFileSync(t, JSON.stringify(b, null, 2), { mode: 0o600 }); renameSync(t, bfile(b.id)); };
const allB = () => readdirSync(DIR).filter((f) => /^B\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')));
const fresh = (b) => Date.now() - Date.parse(b.created) <= MAX_AGE_H * 3600e3;
const openIds = () => allB().filter((b) => (['open', 'partial'].includes(b.status) || (b.status === 'sending' && !existsSync(path.join(DIR, `${b.id}.lock`)))) && fresh(b)).map((b) => b.id);
const tell = (msg) => (process.env.BEING_BATCH_NO_TELL === '1' ? console.log(`[to owner] ${msg}`)
  : spawnSync('node', [path.join(here, 'teams-send-dm.mjs'), '--verbatim'], { input: `<p>${esc(msg).replace(/\n/g, '<br>')}</p>`, stdio: ['pipe', 'ignore', 'inherit'] }));
const stop = (msg, code = 1) => { tell(msg); process.exit(code); };
const loadDraft = (id) => { const f = path.join(DDIR, `${id}.json`); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
const hashOf = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

// Addresses that already got a mail with this subject from the owner (comms log, last 14 days): never mailed again.
function sentBefore() {
  const out = new Set(), f = process.env.BEING_COMMS_LOG || path.join(stateDir(), 'comms.jsonl'), since = Date.now() - 14 * 864e5;
  if (!existsSync(f)) return out;
  for (const l of readFileSync(f, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(l);
      if (e.channel !== 'mail' || e.dir !== 'out' || !/^as-owner/.test(e.kind || '') || !(Date.parse(e.loggedAt || e.at || 0) >= since)) continue;
      const s = String(e.subject || '').trim().toLowerCase();
      if (s) for (const a of [...(e.to || []), ...(e.cc || [])]) out.add(`${String(a).toLowerCase()}\n${s}`);
    } catch {}
  }
  return out;
}

// Ledger: append-only key -> state lines; a lock file keeps two runs of one batch apart.
function ledgerOf(id) {
  const f = path.join(DIR, `${id}.ledger.jsonl`), states = new Map();
  if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const r = JSON.parse(l); states.set(r.key, r.state); }
  return { state: (k) => states.get(k), put: async (k, state, extra = {}) => { appendFileSync(f, JSON.stringify({ key: k, state, ...extra, at: new Date().toISOString() }) + '\n', { mode: 0o600 }); states.set(k, state); } };
}
const result = (id, row) => appendFileSync(path.join(DIR, `${id}.results.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n', { mode: 0o600 });

function sharedTool(args) {
  const tool = path.join(here, 'shared-mailbox-drafts.mjs');
  if (!existsSync(tool)) fail('install owner-access before planning shared-mailbox batches', 2);
  const child = spawnSync(process.execPath, [tool, ...args], { stdio: 'inherit', env: process.env });
  process.exit(child.status ?? 1);
}

// ---- plan: build the batch, dedupe, post one preview (or print it with --dry-run) ----
async function plan() {
  if (standby()) fail('standby host: batches disabled', 3);
  if (has('--manifest')) {
    if (has('--drafts') || has('--recipients')) fail('shared manifests cannot be mixed with owner drafts or templates', 2);
    sharedTool(['plan-set', ...argv.slice(1)]);
  }
  const label = opt('--label').slice(0, 80), dry = has('--dry-run');
  let rows = [];
  if (opt('--drafts')) {
    for (const id of parseDraftRange(opt('--drafts'))) {
      const d = loadDraft(id);
      if (!d) fail(`no draft ${id}`, 2);
      if (d.kind !== 'mail' || d.as) fail(`${id} is not an email draft as the owner`, 2);
      if (d.status !== 'pending') { console.error(`skip ${id}: already ${d.status}`); continue; }
      if (Date.now() - Date.parse(d.created) > MAX_AGE_H * 3600e3) fail(`${id} is older than ${MAX_AGE_H}h; stage it again`, 2);
      if (draftFingerprint(d) !== d.fingerprint) fail(`${id} changed after its own prompt; refusing`, 2);
      rows.push({ key: id, draft: id, draftFp: d.fingerprint, to: d.to, cc: d.cc || [], subject: d.subject || '', replyTo: d.replyTo || '', text: d.text, attach: d.attach || [] });
    }
  } else if (opt('--recipients')) {
    const tpl = readFileSync(0, 'utf8').trim(), subject = opt('--subject').trim();
    if (!tpl || !subject) fail('template mode needs --subject and the template text on stdin', 2);
    const cc = opt('--cc').split(',').map((x) => x.trim()).filter(Boolean);
    const attach = opt('--attach').split(',').map((x) => x.trim()).filter(Boolean).map((f) => {
      if (!path.isAbsolute(f) || !existsSync(f) || statSync(f).size >= 3 * 1024 * 1024) fail(`attachment missing, relative or >= 3 MB: ${f}`, 2);
      return { path: f, name: path.basename(f), size: statSync(f).size, sha256: hashOf(f) };
    });
    rows = parseCsv(readFileSync(opt('--recipients'), 'utf8')).map((rec, i) => ({ key: `R${i + 1}`, label: rec.email, to: [rec.email], cc,
      subject: fillTemplate(subject, rec), replyTo: '', text: fillTemplate(tpl, rec), attach }));
  } else fail(USAGE, 2);
  const { rows: keep, left } = dedupeRows(rows, sentBefore());
  if (!keep.length) fail(`nothing to send: ${left.map((l) => `${l.row.key}: ${l.why}`).join('; ') || 'no rows'}`, 2);
  if (keep.length > MAX_ROWS) fail(`a batch holds at most ${MAX_ROWS} mails; split it`, 2);
  const leaked = [...findSecrets(keep.map((r) => `${r.subject}\n${r.text}`).join('\n')), ...findSecretsInFiles([...new Set(keep.flatMap((r) => r.attach.map((a) => a.path)))])];
  if (leaked.length) fail(`blocked: batch looks like it contains secrets (${leaked.join(', ')}); not staged`, 3);
  const ids = allB().map((b) => Number(b.id.slice(1)));
  const b = { id: dry ? 'B0' : `B${Math.max(0, ...ids) + 1}`, label, created: new Date().toISOString(), status: 'open', rows: keep, left, gapSec: GAP_S };
  b.fingerprint = batchFingerprint(b);
  const html = renderBatchPrompt(b, toHtml(keep[0].text), { gapSec: GAP_S, onlyOpen: openIds().length === 0 });
  if (dry) {
    console.log(`DRY RUN (nothing stored or posted): ${keep.length} to send, ${left.length} left out`);
    console.log(html.replace(/<br>|<\/p>|<hr>/g, '\n').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
    await run(b.id, { dry: true, batch: b });
    return;
  }
  try { writeFileSync(bfile(b.id), '', { flag: 'wx', mode: 0o600 }); } catch { fail(`${b.id} exists; run plan again`, 1); }
  saveB(b);
  const S = beingSender(), OWNER = need('OWNER_UPN').toLowerCase();
  const { g, me } = await connect({ ...S, sender: true, scopes: ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'] });
  try {
    const cs = await g(`/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`);
    const chat = cs.value.find((c) => c.members?.some((m) => (m.email || '').toLowerCase() === OWNER));
    if (!chat) throw new Error('no 1:1 chat with the owner yet');
    const sent = await g(`/chats/${chat.id}/messages`, { body: { body: { contentType: 'html', content: html } } });
    saveB({ ...b, promptChatId: chat.id, promptMessageId: sent.id, promptAt: sent.createdDateTime || new Date().toISOString(), by: me.userPrincipalName });
    logComms({ dir: 'out', kind: 'batch-preview', batch: b.id, chatId: chat.id, messageId: sent.id, count: keep.length });
  } catch (e) { fail(`batch ${b.id} stored but its preview was not delivered: ${e.message}`); }
  console.log(`${b.id}: ${keep.length} mail(s), ${left.length} left out; preview posted. The owner types SEND ${b.id}.`);
}

// ---- send / skip: verify the owner's typed command in Graph, then start the sender detached ----
async function decide(verb) {
  const MSG = opt('--msg'), CHAT = opt('--chat');
  if (!MSG || !CHAT) fail(USAGE, 2);
  let id = BATCH_ID_RE.test(arg1 || '') ? arg1 : '';
  const open = openIds();
  if (!id) { if (open.length !== 1) stop(open.length ? `More than one batch is open (${open.join(', ')}): type SEND with its number, e.g. SEND ${open.at(-1)}.` : 'There is no open batch to send.'); id = open[0]; }
  const b = loadB(id);
  if (!b) stop(`I don't have a batch ${id}.`);
  if (b.kind === 'shared-manifest-set') {
    if (verb !== 'send') stop('Shared-mailbox previews need a fresh plan to replace them.');
    if (open.length !== 1 || open[0] !== id) stop('SEND needs exactly one open preview; close other batches first.');
    sharedTool(['send', '--preview', bfile(id), '--go-chat', CHAT, '--go-msg', MSG]);
  }
  const dead = b.status === 'sending' && !existsSync(path.join(DIR, `${id}.lock`));   // its run died: resume from the ledger
  if (!['open', 'partial'].includes(b.status) && !dead) stop(`Batch ${id} is already ${b.status}.`);
  if (!fresh(b)) stop(`Batch ${id} is older than ${MAX_AGE_H}h; ask me for a fresh one.`);
  const kenv = kitEnv(), OWNER = kenv.OWNER_UPN || need('OWNER_UPN'), OWNER_OID = kenv.OWNER_OID || need('OWNER_OID');
  if (!ownerDelegate(kenv)) stop(`No owner sign-in on this host, so I cannot send batch ${id} as you.`);
  const { g, me } = await connect({ upn: OWNER, cache: mailCache('owner', kenv) || kenv.OWNER_CACHE, scopes: ['Mail.Send', 'Mail.ReadWrite', 'Chat.ReadWrite', 'User.Read'] });
  if (me.id !== OWNER_OID) stop('Owner sign-in does not match OWNER_OID; nothing sent.');
  const used = new Set(existsSync(USED) ? readFileSync(USED, 'utf8').split('\n').filter(Boolean) : []);
  const COMMS = process.env.BEING_COMMS_LOG || path.join(stateDir(), 'comms.jsonl'), kitSent = new Set();
  if (existsSync(COMMS)) for (const l of readFileSync(COMMS, 'utf8').split('\n')) { try { const e = JSON.parse(l); if (e.dir === 'out' && e.messageId) kitSent.add(e.messageId); } catch {} }
  let refusal;
  try {
    const chat = await g(`/chats/${encodeURIComponent(CHAT)}?$expand=members`);
    const msg = await g(`/chats/${encodeURIComponent(CHAT)}/messages/${encodeURIComponent(MSG)}`);
    const beingId = (chat.members || []).find((m) => (m.email || '').toLowerCase() === need('BEING_UPN').toLowerCase())?.userId;
    refusal = checkBatchCommand({ msg, chat, members: chat.members, ownerOid: OWNER_OID, beingUpn: need('BEING_UPN'), verb, batch: b, used, kitSent, openIds: open });
    if (!refusal) {
      const prompt = await g(`/chats/${encodeURIComponent(b.promptChatId)}/messages/${encodeURIComponent(b.promptMessageId)}`);
      refusal = checkBatchPrompt({ promptMsg: prompt, beingId, batch: b, cmdAt: Date.parse(msg.createdDateTime) });
    }
  } catch (e) { refusal = `could not verify (${e.message.slice(0, 100)})`; }
  if (refusal) { logComms({ dir: 'draft', kind: 'batch-refused', batch: id, error: refusal }); stop(`Did not act on batch ${id}: ${refusal}. Nothing went out.`); }
  appendFileSync(USED, `${MSG}\n`);
  if (verb === 'skip') { saveB({ ...b, status: 'skipped', decided: new Date().toISOString() }); logComms({ dir: 'draft', kind: 'batch-skipped', batch: id }); tell(`Dropped batch ${id}; nothing from it was sent.`); return; }
  saveB({ ...b, status: 'sending', approvedAt: new Date().toISOString(), approvedCommand: MSG });
  logComms({ dir: 'draft', kind: 'batch-approved', batch: id, count: b.rows.length });
  // The run outlives this handler call; the batch status ("sending") and the ledger keep it single.
  const log = openSync(path.join(DIR, `${id}.run.log`), 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '__run', id], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref(); closeSync(log);
  tell(`Sending batch ${id}: ${b.rows.length} mail(s), about one every ${b.gapSec || GAP_S} s. I'll post the result here.`);
}

// Graph send for one row, as in approve.mjs. Errors at the final send call are marked uncertain.
async function sendRow(g, OWNER, r) {
  const rcpt = (a) => ({ emailAddress: { address: a } });
  const attachments = (r.attach || []).map((a) => {
    if (!existsSync(a.path) || hashOf(a.path) !== a.sha256) throw new Error(`attachment ${a.name} is missing or changed`);
    return { '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentBytes: readFileSync(a.path).toString('base64') };
  });
  const html = toHtml(r.text);
  let recipients = { ...(r.to.length ? { toRecipients: r.to.map(rcpt) } : {}), ...(r.cc.length ? { ccRecipients: r.cc.map(rcpt) } : {}) };
  let msgId;
  if (r.replyTo) {
    const orig = await g(`/me/messages/${encodeURIComponent(r.replyTo)}?$select=from,toRecipients,ccRecipients`).catch(() => null);
    recipients = { ...replyRecipients(orig, OWNER, r), ...recipients };
    const rr = await g(`/me/messages/${encodeURIComponent(r.replyTo)}/createReply`, { body: {} });
    await g(`/me/messages/${rr.id}`, { method: 'PATCH', body: { body: { contentType: 'html', content: html + (rr.body?.content || '') }, ...(r.subject ? { subject: r.subject } : {}), ...recipients } });
    msgId = rr.id;
  } else msgId = (await g('/me/messages', { body: { subject: r.subject, body: { contentType: 'html', content: html }, ...recipients } })).id;
  for (const a of attachments) await g(`/me/messages/${msgId}/attachments`, { body: a });
  try { await g(`/me/messages/${msgId}/send`, { body: {} }); } catch (e) { e.uncertain = true; throw e; }
}

async function run(id, { dry = false, batch } = {}) {
  const b = batch || loadB(id);
  if (!b) fail(`no batch ${id}`, 2);
  if (!dry && b.status !== 'sending') fail(`batch ${id} is ${b.status}, not approved for sending`, 3);
  if (!dry && batchFingerprint(b) !== b.fingerprint) { saveB({ ...b, status: 'partial' }); stop(`Batch ${id} changed after you approved it; nothing more was sent.`); }
  const lockF = path.join(DIR, `${id}.lock`);
  if (!dry) {
    try { closeSync(openSync(lockF, 'wx', 0o600)); } catch { fail(`${lockF} exists: another run is active or one died`, 1); }
    // Killed mid-run (service restart): free the lock so the owner's next SEND resumes; the ledger keeps sent rows single.
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => { try { unlinkSync(lockF); } catch {} tell(`Batch ${id} was interrupted; type SEND ${id} to send the rest (sent ones never go twice).`); process.exit(1); });
  }
  const kenv = kitEnv(), OWNER = kenv.OWNER_UPN || need('OWNER_UPN');
  let g;
  if (!dry) ({ g } = await connect({ upn: OWNER, cache: mailCache('owner', kenv) || kenv.OWNER_CACHE, scopes: ['Mail.Send', 'Mail.ReadWrite', 'User.Read'] }));
  const memLedger = new Map();
  const ledger = dry ? { state: (k) => memLedger.get(k), put: async (k, s) => memLedger.set(k, s) } : ledgerOf(id);
  const stopF = path.join(DIR, 'STOP');
  let res;
  try {
    res = await runBatch(b.rows, {
      gapMs: dry ? 0 : (b.gapSec || GAP_S) * 1000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      stopped: () => existsSync(stopF) || existsSync(path.join(DIR, `${id}.stop`)) || (!dry && loadB(id)?.status === 'skipped'),
      ledger,
      recheck: (r) => {
        if (!r.draft) return null;
        const d = loadDraft(r.draft);
        if (!d || d.status !== 'pending') return `draft ${r.draft} is ${d?.status || 'gone'} (sent or dropped on its own)`;
        return draftFingerprint(d) === r.draftFp ? null : `draft ${r.draft} changed after the preview`;
      },
      send: async (r) => {
        if (dry) { console.log(`WOULD SEND ${r.key}: ${r.to.join(', ')}${r.cc.length ? ` cc ${r.cc.join(', ')}` : ''} | ${r.subject || '(reply)'}`); return; }
        await sendRow(g, OWNER, r);
        if (r.draft) { const f = path.join(DDIR, `${r.draft}.json`), d = loadDraft(r.draft); writeFileSync(f, JSON.stringify({ ...d, status: 'sent', sentText: r.text, batch: id, decided: new Date().toISOString() }, null, 2), { mode: 0o600 }); }
        logComms({ channel: 'mail', dir: 'out', kind: 'as-owner-batch', batch: id, draftId: r.draft || undefined, to: r.to, cc: r.cc, subject: r.subject, replyTo: r.replyTo, text: r.text });
        result(id, { key: r.key, draft: r.draft, to: r.to, cc: r.cc, status: 'sent' });
      },
    });
  } finally { if (!dry) try { unlinkSync(lockF); } catch {} }
  if (!dry) {
    for (const f of res.failed) result(id, { key: f.row.key, draft: f.row.draft, to: f.row.to, status: 'failed', error: f.why });
    for (const s of res.skipped) result(id, { key: s.row.key, draft: s.row.draft, to: s.row.to, status: 'not-sent', why: s.why });
    const cur = loadB(id);
    saveB({ ...cur, status: cur.status === 'skipped' ? 'skipped' : (res.failed.length || res.stopped ? 'partial' : 'done'), finished: new Date().toISOString(),
      counts: { sent: res.sent.length, failed: res.failed.length, notSent: res.skipped.length } });
  }
  const text = summaryText(b, res);
  if (dry) console.log(`DRY RUN, nothing sent:\n${text}`); else tell(text);
  process.exitCode = res.failed.length ? 1 : 0;
}

function status() {
  const list = arg1 ? [loadB(arg1)].filter(Boolean) : allB();
  for (const b of list) console.log(`${b.id} ${b.status} rows=${b.kind === 'shared-manifest-set' ? b.entries.reduce((n, e) => n + e.manifest.rows.length, 0) : b.rows.length} left=${b.left?.length || 0} created=${b.created}${b.counts ? ` sent=${b.counts.sent} failed=${b.counts.failed} notSent=${b.counts.notSent}` : ''}${b.label ? ` "${b.label}"` : ''}`);
}

if (cmd === 'plan') await plan();
else if (cmd === 'send' || cmd === 'skip') await decide(cmd);
else if (cmd === '__run') await run(arg1);
else if (cmd === 'dry-run') await run(arg1, { dry: true });
else if (cmd === 'status') status();
else if (cmd === 'stop' && BATCH_ID_RE.test(arg1 || '')) { writeFileSync(path.join(DIR, `${arg1}.stop`), new Date().toISOString(), { mode: 0o600 }); console.log(`stop requested for ${arg1}: it halts before the next mail`); }
else fail(USAGE, 2);
