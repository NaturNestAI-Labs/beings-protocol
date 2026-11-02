// Owner-approved mail batches (pure, unit-tested): one preview, one "SEND Bn" typed by the owner, then each row goes once.
// send-batch.mjs does the I/O; approval.mjs keeps the per-draft "send Dn" path unchanged.
import { createHash } from 'node:crypto';
import { strip } from './strip.mjs';
import { MAX_AGE_H } from './approval.mjs';

export const BATCH_ID_RE = /^B\d+$/;
// Case-sensitive on purpose: only an uppercase SEND releases a batch. Bare "SEND" works only with one open batch.
export const BATCH_CMD_RE = /^(SEND|skip)(?:\s+(B\d+))?\s*$/;
export const ADDR_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
export const MAX_ROWS = 100;

export function parseBatchCommand(text) {
  const m = BATCH_CMD_RE.exec(String(text || '').trim());
  if (!m || (m[1] === 'skip' && !m[2])) return null;
  return { verb: m[1] === 'SEND' ? 'send' : 'skip', id: m[2] || '' };
}

// "D45-D79,D81" -> ['D45', ..., 'D79', 'D81'] (no duplicates, order kept).
export function parseDraftRange(spec) {
  const out = [];
  for (const part of String(spec || '').split(/[\s,]+/).filter(Boolean)) {
    const m = /^D(\d+)(?:-D?(\d+))?$/i.exec(part);
    if (!m) throw new Error(`not a draft id or range: ${part}`);
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (b < a || b - a > MAX_ROWS) throw new Error(`bad range: ${part}`);
    for (let n = a; n <= b; n++) if (!out.includes(`D${n}`)) out.push(`D${n}`);
  }
  if (!out.length) throw new Error('no drafts given');
  return out;
}

const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
const rowCore = (r) => ({ draft: r.draft || '', draftFp: r.draftFp || '', to: r.to, cc: r.cc || [], subject: r.subject || '',
  replyTo: r.replyTo || '', text: r.text, attach: (r.attach || []).map((a) => [a.name, a.sha256]) });
// Covers every row's recipients, text and attachments: any change after the preview changes it.
export const batchFingerprint = (b) => createHash('sha256').update(canon({ id: b.id, rows: b.rows.map(rowCore) })).digest('hex').slice(0, 12);

const lower = (l) => (l || []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

// Dedupe: no address gets two mails from one batch, nor one it already got with the same subject (sentBefore: Set of
// "addr\nsubject"). Returns { rows, left: [{ row, why }] }.
export function dedupeRows(rows, sentBefore = new Set()) {
  const seen = new Map(), keep = [], left = [];
  for (const r of rows) {
    const addrs = [...lower(r.to), ...lower(r.cc)];
    const bad = addrs.filter((a) => !ADDR_RE.test(a));
    if (!lower(r.to).length) { left.push({ row: r, why: 'no recipient' }); continue; }
    if (bad.length) { left.push({ row: r, why: `not an email address: ${bad.join(', ')}` }); continue; }
    const dup = addrs.find((a) => seen.has(a));
    if (dup) { left.push({ row: r, why: `${dup} is already in ${seen.get(dup)}` }); continue; }
    const subj = String(r.subject || '').trim().toLowerCase();
    const before = addrs.find((a) => subj && sentBefore.has(`${a}\n${subj}`));
    if (before) { left.push({ row: r, why: `${before} already got this subject from you` }); continue; }
    addrs.forEach((a) => seen.set(a, r.draft || r.label || 'this batch'));
    keep.push({ ...r, to: lower(r.to), cc: lower(r.cc) });
  }
  return { rows: keep, left };
}

// Minimal CSV: header row, comma separated, double quotes for fields with commas. Needs an "email" column.
export function parseCsv(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const cells = (l) => { const out = []; let cur = '', q = false;
    for (let i = 0; i < l.length; i++) {
      const c = l[i];
      if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
      else if (c === '"') q = true; else if (c === ',') { out.push(cur.trim()); cur = ''; } else cur += c;
    }
    out.push(cur.trim()); return out; };
  if (lines.length < 2) throw new Error('recipient list needs a header row and at least one row');
  const head = cells(lines[0]).map((h) => h.toLowerCase());
  if (!head.includes('email')) throw new Error('recipient list needs an "email" column');
  return lines.slice(1).map((l) => Object.fromEntries(cells(l).map((v, i) => [head[i], v])));
}

// {{column}} placeholders from one recipient row; a missing value is an error, never a blank.
export function fillTemplate(tpl, rec) {
  return String(tpl).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (_, k) => {
    const v = rec[k.toLowerCase()];
    if (v === undefined || v === '') throw new Error(`no value for {{${k}}} for ${rec.email || 'a row'}`);
    return v;
  });
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// The one preview the owner approves: count, every recipient, the subject(s), a sample text, what was left out.
export function renderBatchPrompt(b, sampleHtml, { gapSec, onlyOpen = true } = {}) {
  const n = b.rows.length, subs = [...new Set(b.rows.map((r) => r.subject || '(reply in thread)'))];
  const att = [...new Set(b.rows.flatMap((r) => (r.attach || []).map((a) => a.name)))];
  const list = b.rows.map((r, i) => `${i + 1}. ${r.draft ? `${r.draft}: ` : ''}${esc(r.to.join(', '))}${r.cc.length ? ` (cc ${esc(r.cc.join(', '))})` : ''}`);
  const mins = Math.ceil((n * (gapSec || 0)) / 60);
  return `<p><b>Batch ${b.id}</b>: <b>${n} email${n === 1 ? '' : 's'} as you</b>, one per recipient, nobody twice${b.label ? ` (${esc(b.label)})` : ''}.</p>`
    + `<p><i>Subject${subs.length > 1 ? 's' : ''}:</i> ${subs.slice(0, 5).map(esc).join(' · ')}${subs.length > 5 ? ` +${subs.length - 5} more` : ''}</p>`
    + (att.length ? `<p><i>Attachments:</i> ${att.map(esc).join(', ')}</p>` : '')
    + `<p><i>Recipients (${n}):</i><br>${list.join('<br>')}</p>`
    + (b.left?.length ? `<p><i>Left out (${b.left.length}):</i><br>${b.left.map((l) => `${esc(l.row.draft || l.row.to?.join(', ') || '?')}: ${esc(l.why)}`).join('<br>')}</p>` : '')
    + `<p><i>Sample (first mail${b.rows[0]?.draft ? `, ${b.rows[0].draft}` : ''}):</i></p><hr>${sampleHtml}<hr>`
    + `<p>Reply <b>SEND ${b.id}</b> to send all ${n}${onlyOpen ? ` (plain <b>SEND</b> works while this is the only open batch)` : ''} · <b>skip ${b.id}</b> to drop it.`
    + ` About one mail every ${gapSec || 0} s${mins ? `, ~${mins} min in all` : ''}; you get a result summary here.`
    + ` · fingerprint ${b.fingerprint}</p>`;
}

// Same checks as approval.checkCommand, for a batch command. Returns an error string or null.
export function checkBatchCommand({ msg, chat, members, ownerOid, beingUpn, verb, batch, used, kitSent = new Set(), openIds = [], now = Date.now() }) {
  if (!msg || !chat) return 'command message not found';
  if (used.has(msg.id)) return 'that command was already used';
  if (kitSent.has(msg.id)) return 'command was posted by the kit, not typed by the owner';
  if (msg.from?.application || msg.from?.device) return 'command was posted by an app, not typed by the owner';
  if (msg.from?.user?.id !== ownerOid) return 'command was not written by the owner';
  if (msg.messageType && msg.messageType !== 'message') return 'command is not a chat message';
  if (msg.deletedDateTime || msg.lastEditedDateTime) return 'command was edited or deleted';
  if (chat.chatType !== 'oneOnOne') return 'command is not in a 1:1 chat';
  const emails = (members || []).map((m) => String(m.email || '').toLowerCase());
  if (!(members || []).some((m) => m.userId === ownerOid) || !emails.includes(String(beingUpn).toLowerCase())) return 'command is not in the owner\'s 1:1 with the Being';
  if (batch.promptChatId && batch.promptChatId !== chat.id) return 'command is not in the chat the batch was offered in';
  const c = parseBatchCommand(strip(msg.body?.content));
  if (!c || c.verb !== verb) return 'command text does not match';
  if (c.id && c.id !== batch.id) return 'command names another batch';
  if (!c.id && !(openIds.length === 1 && openIds[0] === batch.id)) return 'more than one batch is open: type SEND with the batch number';
  const at = Date.parse(msg.createdDateTime);
  if (!(at >= Date.parse(batch.promptAt || batch.created))) return 'command is older than the batch';
  if (now - at > MAX_AGE_H * 3600e3) return `command is older than ${MAX_AGE_H}h`;
  return null;
}

export function checkBatchPrompt({ promptMsg, beingId, batch, cmdAt }) {
  if (!promptMsg) return 'batch preview not found';
  if (promptMsg.from?.user?.id !== beingId) return 'batch preview was not posted by the Being';
  if (promptMsg.deletedDateTime) return 'batch preview was deleted';
  if (promptMsg.lastEditedDateTime) return 'batch preview was edited after it was posted';
  if (cmdAt !== undefined && !(Date.parse(promptMsg.lastModifiedDateTime || promptMsg.createdDateTime || '') <= cmdAt)) return 'batch preview changed after the owner\'s command';
  const t = strip(promptMsg.body?.content);
  if (!new RegExp(`\\bBatch ${batch.id}\\b`).test(t)) return 'batch preview is for another batch';
  const fp = batchFingerprint(batch);
  if (fp !== batch.fingerprint || !t.includes(`fingerprint ${fp}`)) return 'batch changed after the owner saw it';
  return null;
}

// Sends the rows one by one. deps: send(row), sleep(ms), stopped(), ledger { state(id), put(id, state, extra) },
// recheck(row) -> error string | null (e.g. its draft was sent on its own meanwhile). Never sends a row twice.
export async function runBatch(rows, { send, sleep, stopped = () => false, ledger, recheck = () => null, gapMs = 0, maxFailRun = 3 }) {
  const res = { sent: [], failed: [], skipped: [], stopped: false };
  let n = 0, failRun = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], st = ledger.state(r.key);
    if (res.aborted) { res.skipped.push({ row: r, why: `not tried: ${res.aborted}` }); continue; }
    if (st === 'done') { res.skipped.push({ row: r, why: 'already sent in an earlier run' }); continue; }
    if (st === 'started') { res.failed.push({ row: r, why: 'an earlier run started it but did not confirm: check Sent Items' }); continue; }
    if (stopped()) { res.stopped = true; res.skipped.push({ row: r, why: 'stopped' }); continue; }
    const why = recheck(r);
    if (why) { res.skipped.push({ row: r, why }); continue; }
    if (n++ && gapMs) await sleep(gapMs);
    await ledger.put(r.key, 'started');
    try {
      await send(r);
      await ledger.put(r.key, 'done');
      res.sent.push({ row: r }); failRun = 0;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 200);
      // e.uncertain: the send call itself failed, so it may have gone; the row stays "started" and is never retried blind.
      if (e.uncertain) res.failed.push({ row: r, why: `${msg} (may have gone: check Sent Items)` });
      else { await ledger.put(r.key, 'failed', { error: msg }); res.failed.push({ row: r, why: msg }); }
      if (++failRun >= maxFailRun) { res.stopped = true; res.aborted = `${failRun} failures in a row`; }
    }
  }
  return res;
}

export function summaryText(b, res) {
  const who = (r) => `${r.draft ? `${r.draft} ` : ''}${r.to.join(', ')}`;
  const lines = [`Batch ${b.id}: sent ${res.sent.length} of ${b.rows.length}.`];
  if (res.failed.length) lines.push(`Failed (${res.failed.length}): ${res.failed.map((f) => `${who(f.row)}: ${f.why}`).join('; ')}`);
  if (res.skipped.length) lines.push(`Not sent (${res.skipped.length}): ${res.skipped.map((f) => `${who(f.row)}: ${f.why}`).join('; ')}`);
  if (res.failed.length) lines.push(`Type SEND ${b.id} again to retry the failed ones only; the sent ones never go twice.`);
  return lines.join('\n');
}
