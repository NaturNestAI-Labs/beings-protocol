// Separate headless sessions: the Being and the owner each have their own API token cache and browser profile,
// per service (teams, outlook, browser). A stamp records whose session it is and on which box it was signed in.
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ROLES = ['being', 'owner'];
export const SERVICES = ['teams', 'outlook', 'browser'];

// Delegated scopes per service. The owner's read-only lists are the narrowest; abilities add their own on top.
export const SCOPES = {
  being: { teams: ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'], outlook: ['Mail.ReadWrite', 'Mail.Send', 'User.Read'] },
  owner: { teams: ['Chat.Read', 'User.Read'], outlook: ['Mail.Read', 'User.Read'] },
};

// Box identity: hash of /etc/machine-id (never the raw id). Sessions copied from another box are refused.
export function boxId(file = '/etc/machine-id') {
  let raw = '';
  try { raw = readFileSync(file, 'utf8').trim(); } catch {}
  return createHash('sha256').update(`beings-box|${raw || 'unknown'}`).digest('hex').slice(0, 16);
}

export const stampFile = (state, role, service) => path.join(state, 'sessions', `${role}-${service}.json`);

export function writeStamp(state, { role, service, account, box = boxId(), at = new Date().toISOString() }) {
  if (!ROLES.includes(role) || !SERVICES.includes(service)) throw new Error(`bad session ${role}/${service}`);
  const f = stampFile(state, role, service);
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify({ role, service, account: String(account).toLowerCase(), box, at }) + '\n', { mode: 0o600 });
}

// Problem string, or null when the session is signed in on this box for the expected account.
export function checkStamp(state, role, service, expect, { box = boxId() } = {}) {
  const f = stampFile(state, role, service);
  if (!existsSync(f)) return `${role} ${service} session not signed in (run: owner-access-login ${role} --${service})`;
  let s;
  try { s = JSON.parse(readFileSync(f, 'utf8')); } catch { return `${role} ${service} session stamp unreadable`; }
  if (s.box !== box) return `${role} ${service} session was signed in on another box; sign in again here, never copy sessions`;
  if (expect && s.account !== String(expect).toLowerCase()) return `${role} ${service} session is ${s.account}, expected ${expect}`;
  return null;
}

const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
const under = (a, b) => { const r = path.relative(b, a); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };

// Hard separation rules between the two identities' files. Returns a list of problems (empty = ok).
export function separationProblems({ beingCache, ownerCache, beingProfile, ownerProfile, beingUpn, ownerUpn }) {
  const p = [];
  if (beingUpn && ownerUpn && beingUpn.toLowerCase() === ownerUpn.toLowerCase()) p.push('Being and owner are the same account');
  if (beingCache && ownerCache && real(beingCache) === real(ownerCache)) p.push('Being and owner share one token cache');
  if (beingProfile && ownerProfile && (under(real(beingProfile), real(ownerProfile)) || under(real(ownerProfile), real(beingProfile))))
    p.push('Being and owner browser profiles overlap');
  if (ownerProfile && !/owner-/.test(path.basename(ownerProfile))) p.push('owner browser profile folder name must start with owner-');
  if (beingProfile && !/being-/.test(path.basename(beingProfile))) p.push('Being browser profile folder name must start with being-');
  for (const [label, f, mode] of [['owner token cache', ownerCache, 0o077], ['owner browser profile', ownerProfile, 0o077],
    ['Being token cache', beingCache, 0o077], ['Being browser profile', beingProfile, 0o077]]) {
    try { if (f && existsSync(f) && (statSync(f).mode & mode)) p.push(`${label} is readable by others (chmod ${statSync(f).isDirectory() ? 700 : 600})`); } catch {}
  }
  return p;
}

// CLI for owner-access-login and doctor: stamp <role> <service> <account> | status
if (process.argv[1] && /sessions\.mjs$/.test(process.argv[1])) {
  const [cmd, role, service, account] = process.argv.slice(2);
  const state = process.env.BEING_STATE_DIR;
  if (!state) { console.error('BEING_STATE_DIR not set'); process.exit(2); }
  if (cmd === 'stamp') writeStamp(state, { role, service, account });
  else if (cmd === 'status') {
    for (const r of ROLES) for (const svc of SERVICES) {
      const want = r === 'being' ? process.env.BEING_UPN : process.env.OWNER_UPN;
      const p = checkStamp(state, r, svc, want);
      let at = '';
      try { at = JSON.parse(readFileSync(stampFile(state, r, svc), 'utf8')).at; } catch {}
      console.log(`${r.padEnd(5)} ${svc.padEnd(7)} ${p ? `NO   ${p}` : `ok   ${want} (signed in ${at})`}`);
    }
  } else { console.error('usage: sessions.mjs stamp <being|owner> <teams|outlook|browser> <account> | status'); process.exit(2); }
}
