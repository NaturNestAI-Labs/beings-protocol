// Pure helpers for teams-detect.mjs (tested in detect-util.test.mjs): the sweep's look-back and time comparison, and the
// webhook queue offset that moves only after the named messages were fetched (review #11).
import { existsSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs';

// The sweep re-reads OVERLAP seconds behind its watermark: a message Graph indexes late, or one created in the same second
// the sweep started, is still caught. Re-reads are harmless: being-teams enqueue de-duplicates by message id.
export function sweepSince(watermark, overlapSec = 120) {
  const t = Date.parse(watermark);
  if (Number.isNaN(t)) throw new Error(`bad watermark "${watermark}"`);
  return new Date(t - overlapSec * 1000).toISOString();
}
// Graph timestamps carry fractions ("…:00.5Z") and watermarks may not ("…:00Z"): compare as times, never as strings.
export const after = (ts, since) => !!ts && Date.parse(ts) > Date.parse(since);

// Message ids the webhook queued since the offset (messageId -> chatId), and the offset to commit once they are fetched.
// The offset moves past whole lines only; a half-written last line waits for the next kick.
export function readNotified(qf, of) {
  const size = existsSync(qf) ? statSync(qf).size : 0;
  let off = existsSync(of) ? parseInt(readFileSync(of, 'utf8'), 10) : NaN;
  if (!(off >= 0) || off > size) off = size;   // first run or rotated queue: start from now; the poll covers the rest
  const buf = size > off ? readFileSync(qf).subarray(off, size) : Buffer.alloc(0);
  const used = buf.lastIndexOf(10) + 1;
  const ids = new Map();
  for (const l of buf.subarray(0, used).toString('utf8').split('\n')) {
    try {
      const e = JSON.parse(l);
      const x = e.kind === 'notify' && e.changeType === 'created' && /^chats\('([^']+)'\)\/messages\('([^']+)'\)$/.exec(e.resource || '');
      if (x) ids.set(x[2], x[1]);
    } catch {}
  }
  return { ids, from: off, next: off + used };
}

// Commit after the fetch: ok → `next`; a failure keeps the offset for at most `maxTries` tries (the sweep still covers it).
// Atomic write (temp + rename).
export function commitOffset(of, { from, next }, ok, maxTries = 3) {
  const sf = `${of}.stuck`;
  let stuck = { from: -1, n: 0 };
  try { stuck = JSON.parse(readFileSync(sf, 'utf8')); } catch {}
  let to = next;
  if (!ok) {
    const n = stuck.from === from ? stuck.n + 1 : 1;
    if (n < maxTries) { to = from; writeFileSync(sf, JSON.stringify({ from, n })); }
    else writeFileSync(sf, JSON.stringify({ from: -1, n: 0 }));
  } else if (stuck.from !== -1) writeFileSync(sf, JSON.stringify({ from: -1, n: 0 }));
  const tmp = `${of}.tmp.${process.pid}`;
  writeFileSync(tmp, String(to)); renameSync(tmp, of);
  return to;
}

// Who a message is for, or null: direct-chat, named-or-mentioned, owner-in-group (BEING_GROUP_OWNER_WAKES=0: off), or
// active-thread (the Being posted here in 15 min and this sender spoke to it in 30). ctx: {self, owner, ownerWakes, recent}.
export const THREAD_BEING_MIN = 15, THREAD_SENDER_MIN = 30;
export function addressedBy(msg, ctx = {}) {
  if (msg.chatType === 'oneOnOne') return 'direct-chat';
  if (msg.mentionsSelf || msg.named) return 'named-or-mentioned';
  if (ctx.owner && msg.fromId === ctx.owner && ctx.ownerWakes !== false) return 'owner-in-group';
  const t = Date.parse(msg.at);
  if (!ctx.self || !msg.fromId || Number.isNaN(t)) return null;
  const within = (r, min) => { const x = Date.parse(r.at); return x <= t && t - x <= min * 60e3; };
  const recent = ctx.recent || [];
  const beingSpoke = recent.some((r) => r.fromId === ctx.self && within(r, THREAD_BEING_MIN));
  const senderSpoke = recent.some((r) => r.fromId === msg.fromId && r.toBeing && within(r, THREAD_SENDER_MIN) && Date.parse(r.at) < t);
  return beingSpoke && senderSpoke ? 'active-thread' : null;
}
