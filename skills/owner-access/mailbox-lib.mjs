// Shared-mailbox draft helpers (pure, unit-tested): input rows, draft matching, manifest checks, preflight problems.
import { BATCH_RE } from './ledger.mjs';

const ADDR = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function addresses(v, required = false) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[,;]/)).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((x) => !ADDR.test(x));
  if (bad.length) throw new Error(`not an email address: ${bad.join(', ')}`);
  if (required && !list.length) throw new Error('at least one recipient is required');
  return [...new Set(list)];
}

// Input row: { to, cc?, subject, body_html | body_text }.
export function normalizeDraft(raw, where = 'row') {
  try {
    if (!raw || typeof raw !== 'object') throw new Error('not an object');
    const subject = String(raw.subject || '').trim();
    if (!subject) throw new Error('subject is required');
    const html = raw.body_html ? String(raw.body_html)
      : raw.body_text ? `<div>${esc(raw.body_text).replace(/\r?\n/g, '<br>')}</div>` : '';
    if (!html.trim()) throw new Error('body_html or body_text is required');
    return { to: addresses(raw.to, true), cc: addresses(raw.cc), subject, html };
  } catch (e) { throw new Error(`${where}: ${e.message}`); }
}

// Same draft = exact subject and the same set of To addresses.
export const draftKey = (subject, to) => `${String(subject).trim()}\n${[...new Set(to.map((x) => x.toLowerCase()))].sort().join(',')}`;
export const rcpts = (list) => (list || []).map((r) => String(r?.emailAddress?.address || '').toLowerCase()).filter(Boolean);

export function validateManifest(m) {
  if (!m || typeof m !== 'object' || !BATCH_RE.test(m.batch || '')) throw new Error('manifest needs a batch name');
  if (!ADDR.test(m.mailbox || '')) throw new Error('manifest needs the mailbox address');
  if (!Date.parse(m.created || '')) throw new Error('manifest needs a created time');
  if (!Array.isArray(m.rows) || !m.rows.length) throw new Error('manifest has no rows');
  const ids = new Set();
  m.rows.forEach((r, i) => {
    const ok = r && typeof r.id === 'string' && r.id && typeof r.subject === 'string' && r.subject && Array.isArray(r.to) && r.to.length
      && Array.isArray(r.cc) && typeof r.attachment === 'string';
    if (!ok) throw new Error(`manifest row ${i + 1} is incomplete`);
    if (ids.has(r.id)) throw new Error(`manifest row ${i + 1}: duplicate draft id`);
    ids.add(r.id);
  });
  return m;
}

// What is wrong with one live draft against its manifest row (empty list = ready to send).
export function preflightProblems(row, msg, attachments, draftsFolderId, mailbox) {
  if (!msg) return ['not in Drafts'];
  const cc = rcpts(msg.ccRecipients), from = String(msg.from?.emailAddress?.address || '').toLowerCase();
  return [
    msg.isDraft !== true && 'not a draft',
    msg.parentFolderId !== draftsFolderId && 'not in Drafts',
    from && from !== mailbox.toLowerCase() && 'From is not the mailbox',
    msg.subject !== row.subject && 'subject differs',
    draftKey(msg.subject || '', rcpts(msg.toRecipients)) !== draftKey(row.subject, row.to) && 'To differs',
    row.cc.some((x) => !cc.includes(x.toLowerCase())) && 'CC missing',
    row.attachment && !(attachments || []).some((a) => a.name === row.attachment) && `attachment ${row.attachment} missing`,
    !row.attachment && (attachments || []).some((a) => !a.isInline) && 'has an attachment (manifest expects none)',
  ].filter(Boolean);
}

// Own drafts that match one input row: exactly one match is required for edit and plan.
export function matchOwn(own, row) {
  const k = draftKey(row.subject, row.to);
  return own.filter((d) => draftKey(d.subject, d.to) === k);
}
