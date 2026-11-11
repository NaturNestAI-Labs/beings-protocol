// Draft approval rules shared by draft-for-owner.mjs and approve.mjs; small functions so they are unit-tested.
// A draft is sent only when the owner's own Teams message approves it and the prompt they saw matches the stored draft.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { strip } from './strip.mjs';

export const MAX_AGE_H = 24;
// Owner commands: "send D7", "send draft 7", "drop D7" (drop, cancel, discard, delete, remove, ignore = skip), "edit D7 <text>".
// A bare number counts only alone, after send/skip/save/edit ("remove 3" is not one); send/save/skip with more words
// ("send D7 after lunch") is not a command.
const SKIP_WORDS = 'skip|drop|cancel|discard|delete|remove|ignore';
const CMD_RE = new RegExp(`^(send|edit|save|${SKIP_WORDS})\\s+(draft\\s+)?(?:D\\s?(\\d+)|(\\d+))\\b\\s*([\\s\\S]*)$`, 'i');
const TAIL_OK = /^(?:please|pls|now|thanks|thank you)?[\s.!]*$/i;
// Text that reads as a command for a named draft: a draft with it would approve another draft once sent as the owner.
export const COMMAND_RE = new RegExp(`^(send|edit|save|${SKIP_WORDS})\\s+(?:draft\\s+)?D\\s?\\d+\\b`, 'i');
// Marker that only draft-for-owner may post; teams-send-dm.mjs refuses bodies that carry it.
export const PROMPT_MARK_RE = /\bfingerprint\s+[0-9a-f]{12}\b/i;

const canon = (d) => JSON.stringify({ kind: d.kind, chatId: d.chatId || '', target: d.target || '', to: d.to || [],
  cc: d.cc || [], subject: d.subject || '', replyTo: d.replyTo || '', text: d.text,
  attach: (d.attach || []).map((a) => [a.name, a.sha256]), ...(d.as ? { as: d.as } : {}) });
export const fingerprint = (d) => createHash('sha256').update(canon(d)).digest('hex').slice(0, 12);

// Next free draft id. Each id is claimed by an exclusive create, so concurrent runs never share one.
export function allocDraftId(dir) {
  const nf = path.join(dir, 'next-id');
  let n = Math.max(1, parseInt(existsSync(nf) ? readFileSync(nf, 'utf8') : '1', 10) || 1);
  for (;; n++) {
    try { writeFileSync(path.join(dir, `D${n}.json`), '{}', { flag: 'wx', mode: 0o600 }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  writeFileSync(nf, String(n + 1));
  return `D${n}`;
}

export function parseCommand(text) {
  const m = CMD_RE.exec(String(text || '').trim());
  if (!m) return null;
  const v = m[1].toLowerCase(), verb = ['send', 'edit', 'save'].includes(v) ? v : 'skip', rest = m[5].trim();
  if (m[4] && !m[2] && (rest || verb !== v)) return null;
  if (verb !== 'edit' && !TAIL_OK.test(rest)) return null;
  return { verb, id: `D${m[3] || m[4]}`, rest: verb === 'edit' ? rest : '' };
}

// A newer draft for the same chat (or mail thread) replaces the older live ones, so a stale one cannot be approved.
// New mails count as one thread only when written to the same people within 30 min (a re-draft, not a second mail).
const REDRAFT_MS = 30 * 60e3;
const who = (d) => [].concat(d.to || []).map((x) => String(x).toLowerCase()).sort().join(',');
const thread = (d) => (d.kind === 'mail' ? `mail|${d.replyTo ? `r:${d.replyTo}` : 'new'}|${who(d)}` : `teams|${d.chatId}|${d.as || ''}`);
const num = (id) => Number(String(id).slice(1));
export function replacedBy(draft, drafts, now = Date.now()) {
  return drafts.filter((d) => d.id !== draft.id && num(d.id) < num(draft.id) && d.status === 'pending'
    && now - Date.parse(d.created) <= MAX_AGE_H * 3600e3 && thread(d) === thread(draft)
    && (draft.kind !== 'mail' || draft.replyTo || now - Date.parse(d.created) < REDRAFT_MS)).map((d) => d.id).sort((a, b) => num(a) - num(b));
}
export function loadDrafts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^D\d+\.json$/.test(f)).flatMap((f) => {
    try { const d = JSON.parse(readFileSync(path.join(dir, f), 'utf8')); return d.id ? [d] : []; } catch { return []; }
  });
}

// Human label for a chat, built from Graph data (never from a model-supplied label).
export function chatLabel(chat, members, { exclude = [] } = {}) {
  const skip = new Set(exclude.map((x) => String(x).toLowerCase()));
  const people = (members || []).filter((m) => !skip.has(String(m.userId || '').toLowerCase()) && !skip.has(String(m.email || '').toLowerCase()))
    .map((m) => (m.email ? `${m.displayName || m.email} <${m.email}>` : (m.displayName || 'unknown')));
  if (chat.chatType === 'oneOnOne') return `1:1 with ${people[0] || 'unknown'}`;
  const who = people.slice(0, 6).join(', ') + (people.length > 6 ? ` +${people.length - 6} more` : '');
  return `${chat.chatType === 'meeting' ? 'meeting chat' : 'group chat'} "${chat.topic || '(no topic)'}" (${people.length} others: ${who})`;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function renderPrompt(d, bodyHtml) {
  const isMail = d.kind === 'mail';
  const head = isMail
    ? `<p><b>Draft ${d.id}</b>: email as you${d.replyTo ? ' (reply in thread)' : ''} to <b>${esc(d.to.join(', ') || 'the original sender')}</b>`
      + (d.cc.length ? ` cc ${esc(d.cc.join(', '))}` : '') + '</p>' + (d.subject ? `<p><i>Subject:</i> ${esc(d.subject)}</p>` : '')
      + (d.attach.length ? `<p><i>Attachments:</i> ${esc(d.attach.map((a) => `${a.name} (${Math.round(a.size / 1024)} KB)`).join(', '))}</p>` : '')
    : `<p><b>Draft ${d.id}</b>: reply ${d.as ? `as <b>${esc(d.as)}</b> (not you)` : 'as you'} in <b>${esc(d.target)}</b></p>`;
  return head + (d.re ? `<p><i>They wrote:</i> “${esc(d.re.slice(0, 300))}”</p>` : '') + '<hr>' + bodyHtml + '<hr>'
    + (d.replaces?.length ? `<p><i>Replaces:</i> ${esc(d.replaces.join(', '))} (no longer sendable)</p>` : '')
    + `<p>Reply <b>send ${d.id}</b> · <b>edit ${d.id} &lt;new text&gt;</b> · <b>skip ${d.id}</b>${isMail ? ` · <b>save ${d.id}</b>` : ''}`
    + ` · fingerprint ${d.fingerprint}</p>`;
}

// Checks the owner's command message as returned by Graph. Returns an error string, or null when it may proceed.
// kitSent: ids of messages the kit itself posted (any identity), so a kit-authored "send Dn" never counts.
export function checkCommand({ msg, chat, members, ownerOid, beingUpn, verb, id, draft, used, kitSent = new Set(), now = Date.now() }) {
  if (!msg || !chat) return 'command message not found';
  if (used.has(msg.id)) return 'that command was already used';
  if (kitSent.has(msg.id)) return 'command was posted by the kit, not typed by the owner';
  if (msg.from?.application || msg.from?.device) return 'command was posted by an app, not typed by the owner';
  if (msg.from?.user?.id !== ownerOid) return 'command was not written by the owner';
  if (msg.messageType && msg.messageType !== 'message') return 'command is not a chat message';
  if (chat.chatType !== 'oneOnOne') return 'command is not in a 1:1 chat';
  const emails = (members || []).map((m) => String(m.email || '').toLowerCase());
  const ids = (members || []).map((m) => m.userId);
  if (!ids.includes(ownerOid) || !emails.includes(String(beingUpn).toLowerCase())) return 'command is not in the owner\'s 1:1 with the Being';
  if (draft.promptChatId && draft.promptChatId !== chat.id) return 'command is not in the chat the draft was offered in';
  const c = parseCommand(strip(msg.body?.content));
  if (!c || c.verb !== verb || c.id !== id) return 'command text does not match';
  const at = Date.parse(msg.createdDateTime);
  if (!(at >= Date.parse(draft.promptAt || draft.created))) return 'command is older than the draft';
  if (now - at > MAX_AGE_H * 3600e3) return `command is older than ${MAX_AGE_H}h`;
  return null;
}

// Checks that the approval prompt the owner saw was posted by the Being and carries this draft's fingerprint.
// cmdAt: when the owner's command was written; a prompt edited or changed after that is refused.
export function checkPrompt({ promptMsg, beingId, draft, cmdAt }) {
  if (!promptMsg) return 'approval prompt not found';
  if (promptMsg.from?.user?.id !== beingId) return 'approval prompt was not posted by the Being';
  if (promptMsg.deletedDateTime) return 'approval prompt was deleted';
  if (promptMsg.lastEditedDateTime) return 'approval prompt was edited after it was posted';
  if (cmdAt !== undefined && !(Date.parse(promptMsg.lastModifiedDateTime || promptMsg.createdDateTime || '') <= cmdAt)) {
    return 'approval prompt changed after the owner\'s command';
  }
  const t = strip(promptMsg.body?.content);
  if (!new RegExp(`\\bDraft ${draft.id}\\b`).test(t)) return 'approval prompt is for another draft';
  const fp = fingerprint(draft);
  if (fp !== draft.fingerprint || !t.includes(`fingerprint ${fp}`)) return 'draft changed after the owner saw it';
  return null;
}

// Recipients for a reply to the owner's own sent mail: its original To (and Cc unless the draft names one), never the
// owner again. {} when the draft names recipients or the original came from someone else.
export function replyRecipients(original, ownerUpn, d = {}) {
  const from = String(original?.from?.emailAddress?.address || '').toLowerCase();
  if (d.to?.length || !from || from !== String(ownerUpn || '').toLowerCase()) return {};
  const to = original.toRecipients || [];
  return to.length ? { toRecipients: to, ...(!d.cc?.length && original.ccRecipients?.length ? { ccRecipients: original.ccRecipients } : {}) } : {};
}
