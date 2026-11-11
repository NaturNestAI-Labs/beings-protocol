// Owner-access config (owner-access.toml next to the kit scripts): abilities, pause files, per-area approvers.
// Every ability is off unless the file says `true`; a missing file means everything is off. Never read from env.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = path.join(KIT, 'owner-access.toml');

export const ABILITIES = {
  owner_teams_read: 'Read the owner\'s Teams chats (owner-read)',
  owner_mail_read: 'Read the owner\'s mailbox (owner-mail)',
  owner_teams_send_approved: 'Send a Teams message as the owner after "send Dn" (approve.mjs)',
  owner_mail_send_approved: 'Send mail as the owner after "send Dn" (approve.mjs)',
  owner_files: 'Search, list and download the owner\'s OneDrive/SharePoint files (owner-web)',
  owner_web_pages: 'Read Outlook/Teams web pages as the owner, text only (owner-web open)',
  shared_mailbox_read: 'Read a shared mailbox the owner can open (shared-inbox-monitor)',
  shared_mailbox_drafts: 'Create and edit the Being\'s own unsent drafts in a shared mailbox',
  shared_mailbox_send: 'Send a named, reviewed batch of those drafts after a go',
  channel_posts: 'Post a reviewed batch in one allowed Teams channel as the owner after a go',
  mail_forward_rules: 'Forward matching mail from the owner\'s inbox under pre-approved rules',
  area_approvers: 'Let named people (not only the owner) say "go" for one area',
};

// TOML subset: [table], [[array of tables]], key = string | 'literal' | bool | number | [array] (may span lines).
export function parseToml(text) {
  const root = {};
  let cur = root;
  const lines = String(text).split('\n');
  const value = (s) => {
    s = s.trim();
    if (s.startsWith('"')) {
      let out = '', i = 1;
      for (; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\') { const c = s[++i]; out += { n: '\n', t: '\t', '"': '"', '\\': '\\' }[c] ?? c; } else out += s[i];
      }
      if (i >= s.length) throw new Error(`unterminated string: ${s.slice(0, 40)}`);
      return [out, s.slice(i + 1)];
    }
    if (s.startsWith("'")) { const j = s.indexOf("'", 1); if (j < 0) throw new Error('unterminated literal'); return [s.slice(1, j), s.slice(j + 1)]; }
    if (s.startsWith('[')) {
      const arr = []; let rest = s.slice(1).trim();
      while (!rest.startsWith(']')) {
        if (!rest) throw new Error('unterminated array');
        const [v, r] = value(rest); arr.push(v);
        rest = r.trim().replace(/^,/, '').trim();
      }
      return [arr, rest.slice(1)];
    }
    const m = /^(true|false|-?\d+(?:\.\d+)?)/.exec(s);
    if (!m) throw new Error(`bad value: ${s.slice(0, 40)}`);
    return [m[1] === 'true' ? true : m[1] === 'false' ? false : Number(m[1]), s.slice(m[0].length)];
  };
  const noComment = (s) => { let q = null; for (let i = 0; i < s.length; i++) { const c = s[i]; if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '#') return s.slice(0, i); } return s; };
  for (let n = 0; n < lines.length; n++) {
    let line = noComment(lines[n]).trim();
    if (!line) continue;
    let m;
    if ((m = /^\[\[\s*([A-Za-z0-9_.-]+)\s*\]\]$/.exec(line))) { (root[m[1]] ||= []).push(cur = {}); continue; }
    if ((m = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line))) { cur = (root[m[1]] ||= {}); continue; }
    if (!(m = /^([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line))) throw new Error(`line ${n + 1}: expected key = value`);
    let raw = m[2];
    // An array may continue over several lines until its brackets balance.
    const depth = (s) => [...s.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '')].reduce((d, c) => d + (c === '[') - (c === ']'), 0);
    while (raw.trim().startsWith('[') && depth(raw) > 0 && n + 1 < lines.length) raw += ' ' + noComment(lines[++n]);
    const [v, rest] = value(raw);
    if (rest.trim()) throw new Error(`line ${n + 1}: unexpected text after value`);
    cur[m[1]] = v;
  }
  return root;
}

export function loadConfig(file = CONFIG_FILE) {
  if (!existsSync(file)) return { owner_access: { enabled: false }, abilities: {} };
  return parseToml(readFileSync(file, 'utf8'));
}

// An ability is on only when the master switch and its own switch are both literally true.
export function abilityOn(cfg, name) {
  if (!(name in ABILITIES)) throw new Error(`unknown ability ${name}`);
  return cfg?.owner_access?.enabled === true && cfg?.abilities?.[name] === true;
}

// Pause file per ability (and per forward rule): <state>/owner-access/<name>.pause. Empty = paused until removed;
// an ISO time inside = paused until then.
export const pauseFile = (state, name) => path.join(state, 'owner-access', `${name}.pause`);
export function paused(state, name, now = Date.now()) {
  const f = pauseFile(state, name);
  if (!existsSync(f)) return false;
  const t = readFileSync(f, 'utf8').trim();
  if (!t) return true;
  const until = Date.parse(t);
  return Number.isNaN(until) ? true : until > now;
}

// Who may say "go" for an area: always the owner; named people only when area_approvers is on.
export function approversFor(cfg, area, ownerUpn) {
  const lc = (x) => String(x || '').trim().toLowerCase();
  const out = new Set([lc(ownerUpn)].filter(Boolean));
  if (area && abilityOn(cfg, 'area_approvers')) for (const p of cfg.approvers?.[area] || []) out.add(lc(p));
  return out;
}
