// The kit's .env as written on disk next to these scripts. Guards read it here because a run can override process env.
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT_ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');

// Bash-style value: 'single', "double", \x and bare words; stops at an unquoted space or #.
export function parseValue(raw) {
  let out = '', i = 0;
  const s = raw.replace(/^\s+/, '');
  while (i < s.length) {
    const c = s[i];
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j === -1) return out + s.slice(i + 1); out += s.slice(i + 1, j); i = j + 1; }
    else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\' && /["\\$`]/.test(s[i + 1] || '')) i++; out += s[i++]; }
      i++;
    } else if (c === '\\') { out += s[i + 1] || ''; i += 2; }
    else if (/\s/.test(c) || c === '#') break;
    else out += s[i++];
  }
  return out;
}

export function kitEnv(file = KIT_ENV_FILE) {
  const env = {};
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
    if (m) env[m[1]] = parseValue(m[2]);
  }
  return env;
}

const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

// Owner delegate sign-in is opt-in: BEING_OWNER_DELEGATE=1 and an OWNER_CACHE path, both in the on-disk .env.
export const ownerDelegate = (env = kitEnv()) => env.BEING_OWNER_DELEGATE === '1' && !!env.OWNER_CACHE;

// Why a sender identity is the owner's ('upn' | 'cache' | 'oid'), or null. Checked against the on-disk .env and process env.
export function ownerMatch({ upn, cache, oid } = {}, env = kitEnv()) {
  const lc = (x) => String(x || '').trim().toLowerCase();
  const upns = [env.OWNER_UPN, process.env.OWNER_UPN].map(lc).filter(Boolean);
  const caches = [env.OWNER_CACHE, process.env.OWNER_CACHE, env.OWNER_MAIL_CACHE, process.env.OWNER_MAIL_CACHE,
    mailCache('owner', { ...env, ...process.env })].filter(Boolean).map(real);
  const oids = [env.OWNER_OID, process.env.OWNER_OID].map(lc).filter(Boolean);
  if (upn && upns.includes(lc(upn))) return 'upn';
  if (cache && caches.includes(real(cache))) return 'cache';
  if (oid && oids.includes(lc(oid))) return 'oid';
  return null;
}

// Outlook session file: *_MAIL_CACHE, else the separate default next to the Teams cache, else the Teams cache (older installs).
export function mailCache(who = 'being', env = { ...kitEnv(), ...process.env }) {
  const P = who === 'owner' ? 'OWNER' : 'BEING';
  if (env[`${P}_MAIL_CACHE`]) return env[`${P}_MAIL_CACHE`];
  const base = env[`${P}_CACHE`];
  if (!base) return '';
  const sep = path.join(path.dirname(base), `${who === 'owner' ? 'owner' : 'being'}-outlook-cache.json`);
  return existsSync(sep) ? sep : base;
}
