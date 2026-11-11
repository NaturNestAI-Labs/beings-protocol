// Owner mail forwarding rules (pure, unit-tested): which mails a rule covers, which chat or mail counts as a request,
// the request window, the block list, and one-time code extraction. mail-forward-rules.mjs does the I/O.

const words = (list) => (list || []).map((w) => String(w).trim()).filter(Boolean)
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*'));
const anyOf = (list) => { const w = words(list); return w.length ? new RegExp(`\\b(?:${w.join('|')})\\b`, 'i') : null; };
const lc = (s) => String(s || '').trim().toLowerCase();
const domainOf = (addr) => lc(addr).split('@')[1] || '';

export const DEFAULTS = {
  window_hours: 3, keep_hours: 48, loose_before_min: 5, loose_after_min: 15, code_fresh_min: 30,
  request_action_words: ['forward', 'fwd', 'send', 'email', 'mail', 'link', 'code', 'otp', 'verification', 'log in', 'login', 'sign in'],
  loose_forward_words: ['forward', 'fwd', 'send'],
  loose_object_words: ['email', 'mail', 'link', 'otp', 'code', 'verification'],
};

export function compileRule(raw) {
  const r = { ...DEFAULTS, ...raw };
  if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(r.name || '')) throw new Error('forward rule needs a name (lowercase letters, digits, - or _)');
  const senders = (r.sender_domains || []).map(lc).filter(Boolean);
  if (!senders.length) throw new Error(`rule ${r.name}: sender_domains is required`);
  const subject = anyOf(r.subject_patterns);
  if (!subject) throw new Error(`rule ${r.name}: subject_patterns is required`);
  if (!lc(r.requesters_domain) && !(r.requesters || []).length) throw new Error(`rule ${r.name}: set requesters_domain or requesters`);
  const service = anyOf(r.request_service_words), action = anyOf(r.request_action_words);
  const looseFwd = anyOf(r.loose_forward_words), looseObj = anyOf(r.loose_object_words);
  const block = new Set((r.block || []).map(lc).filter(Boolean));
  const requesters = new Set((r.requesters || []).map(lc).filter(Boolean));
  return {
    name: r.name, raw: r,
    windowMs: r.window_hours * 3600e3, keepMs: r.keep_hours * 3600e3, codeFreshMs: r.code_fresh_min * 60e3, codeDm: r.code_dm === true,
    // Sender's domain is one of the rule's domains (or a subdomain of one) and the subject matches.
    covers(m) {
      const d = domainOf(m.from);
      return senders.some((s) => d === s || d.endsWith(`.${s}`)) && subject.test(m.subject || '');
    },
    // strict: names the service and an action; loose: only "forward/send ... mail/link/code" without the service.
    ask(text) {
      const t = String(text || '');
      if (service && service.test(t) && action && action.test(t)) return 'strict';
      if (looseFwd && looseObj && looseFwd.test(t) && looseObj.test(t)) return 'loose';
      return null;
    },
    mayAsk(email, { owner, being }) {
      const e = lc(email);
      if (!e || e === lc(owner) || e === lc(being)) return false;
      return requesters.size ? requesters.has(e) : domainOf(e) === lc(r.requesters_domain);
    },
    // Strict asks count within the window either side of the mail; loose ones only shortly before or after it.
    inWindow(req, receivedIso) {
      const delta = Date.parse(req.at) - Date.parse(receivedIso);
      if (!(Math.abs(delta) <= this.windowMs)) return false;
      return req.kind !== 'loose' || (delta >= -r.loose_before_min * 60e3 && delta <= r.loose_after_min * 60e3);
    },
    // Full address or local part; a first-name entry blocks every address with that first name (errs on the safe side).
    blocked(addr) {
      const a = lc(addr), local = a.split('@')[0], first = local.split(/[._-]/)[0];
      return [...block].some((b) => { const bl = b.split('@')[0]; return b === a || bl === local || bl.split(/[._-]/)[0] === first; });
    },
  };
}

// The one requester for a mail, or why there is none: zero or several distinct people means hold and tell the owner.
export function pickRequester(rule, requests, receivedIso, { served = () => false } = {}) {
  const byEmail = new Map();
  for (const q of requests.filter((x) => rule.inWindow(x, receivedIso) && !served(x)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) byEmail.set(lc(q.email), q);
  const who = [...byEmail.values()];
  return who.length === 1 ? { requester: who[0], who } : { requester: null, who };
}

// One-time sign-in code: exactly one 6-digit run near a code word, else null (forward only).
const KEY = /\b(?:code|verification|verify|one[- ]time|otp|passcode)\b/i;
const CAND = /(?<![\w#./:=-])(\d{3})[ -]?(\d{3})(?![\w-])/g;
export const textOf = (body) => String(body || '').replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/https?:\/\/[^\s"'<>]+/g, ' ')
  .replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
export function extractCode(subject, body) {
  const found = new Set();
  for (const t of [String(subject || ''), textOf(body)]) {
    for (const m of t.matchAll(CAND)) {
      const near = t.slice(Math.max(0, m.index - 80), m.index) + ' ' + t.slice(m.index + m[0].length, m.index + m[0].length + 40);
      if (KEY.test(near)) found.add(m[1] + m[2]);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}
// Masks code-shaped digit runs before any text reaches a log or a report.
export const redactCodes = (s) => String(s || '').replace(/\d{3}[ -]?\d{3}/g, '[code]');

// Forwards already in Sent Items for a subject ("Fw:"/"Fwd:" + the exact subject).
export const isForwardOf = (sentSubject, subject) => /^(fw|fwd):\s*/i.test(sentSubject || '')
  && sentSubject.replace(/^(fw|fwd):\s*/i, '').trim() === String(subject || '').trim();
