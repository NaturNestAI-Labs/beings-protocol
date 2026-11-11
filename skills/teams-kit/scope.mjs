#!/usr/bin/env node
// Send grants: the handler mints an opaque per-run token; only its hash, scope and a MAC are stored under state/grants.
// No token means owner-only; a token that does not check out means none (refused), never the owner. See GUARDRAILS.md.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kitEnv } from './kit-env.mjs';

// routine:<chat>,... is the scheduled routines' scope: owner lane (it may read the owner's mail and chats) but sends only to
// the listed chats and the owner's 1:1, never full.
const SCOPE_RE = /^(full|owner-only|(chats|routine):[^,\s]+(,[^,\s]+)*)$/;
// State comes from the on-disk .env, so a run cannot point grants at a directory it controls.
const stateOf = (state) => {
  const s = state || kitEnv().BEING_STATE_DIR;
  if (!s) throw new Error('BEING_STATE_DIR missing from the kit .env');
  return s;
};
const dir = (state) => path.join(stateOf(state), 'grants');
const hash = (t) => createHash('sha256').update(t).digest('hex');
export const keyFile = (state) => path.join(stateOf(state), 'handler.key');

// Minting authority = reading state/handler.key (0600, kit user only). Created on first mint by the handler.
export function handlerKey({ state, create = false } = {}) {
  const f = keyFile(state);
  if (!existsSync(f)) {
    if (!create) throw new Error('no handler key');
    mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    try { writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  if (statSync(f).mode & 0o077) throw new Error(`handler key ${f} must be mode 600`);
  return readFileSync(f, 'utf8').trim();
}
const mac = (key, th, scope, expires) => createHmac('sha256', key).update(`${th}|${scope}|${expires}`).digest('hex');

export function mintGrant(scope, { state, ttlHours = 12 } = {}) {
  if (!SCOPE_RE.test(scope)) throw new Error(`bad scope "${scope}"`);
  const key = handlerKey({ state, create: true });
  const d = dir(state); mkdirSync(d, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString('base64url'), th = hash(token), expires = Date.now() + ttlHours * 3600e3;
  // Written whole under a temp name, then renamed in: a prune never sees (and deletes) a half-written grant.
  const tmp = path.join(d, `.${th}.tmp`);
  writeFileSync(tmp, JSON.stringify({ scope, expires, mac: mac(key, th, scope, expires) }), { mode: 0o600, flag: 'wx' });
  renameSync(tmp, path.join(d, `${th}.json`));
  return token;
}

export function revokeGrant(token, { state } = {}) {
  if (token) rmSync(path.join(dir(state), `${hash(token)}.json`), { force: true });
}

// Effective scope of this process: "full", "owner-only", "chats:<id>,...", "routine:<id>,..." or "none" (a bad grant:
// every send and every lane is refused). Never read from a plain env var.
export function currentScope({ state, token = process.env.BEING_SEND_TOKEN } = {}) {
  if (!token) return { scope: 'owner-only', why: 'no grant' };
  const deny = (why) => ({ scope: 'none', why });
  let f, key;
  try { f = path.join(dir(state), `${hash(token)}.json`); } catch { return deny('no state dir'); }
  if (!existsSync(f)) return deny('unknown grant');
  try { key = handlerKey({ state }); } catch { return deny('no handler key'); }
  try {
    const g = JSON.parse(readFileSync(f, 'utf8'));
    if (!SCOPE_RE.test(g.scope || '')) return deny('bad grant');
    if (!(g.expires > Date.now())) return deny('expired grant');
    const want = Buffer.from(mac(key, hash(token), g.scope, g.expires)), got = Buffer.from(String(g.mac || ''));
    if (got.length !== want.length || !timingSafeEqual(got, want)) return deny('unsigned grant');
    return { scope: g.scope, why: 'grant' };
  } catch { return deny('unreadable grant'); }
}

export const allowedChats = (scope) => {
  const m = /^(chats|routine):(.*)$/.exec(scope);
  return m ? m[2].split(',').filter(Boolean) : [];
};

// Job records: a job's scope and notify chat live outside its own record (state/job-scopes/<id>.json), signed with the
// handler key, so a job that rewrites its state/jobs/<id>.json changes nothing (review #5).
const JOB_ID_RE = /^[0-9]{4}-[0-9]{6}-[A-Za-z0-9-]+$/;
const jobFile = (id, state) => path.join(stateOf(state), 'job-scopes', `${id}.json`);
const jobMac = (key, id, scope, notify) => createHmac('sha256', key).update(`job|${id}|${scope}|${notify}`).digest('hex');
export function signJob(id, scope, notify, { state } = {}) {
  if (!JOB_ID_RE.test(id)) throw new Error(`bad job id "${id}"`);
  if (!SCOPE_RE.test(scope)) throw new Error(`bad scope "${scope}"`);
  const key = handlerKey({ state, create: true }), f = jobFile(id, state);
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  // wx: a record is written once, at job start; nothing can re-sign an existing job with another scope.
  writeFileSync(f, JSON.stringify({ scope, notify: notify || '', mac: jobMac(key, id, scope, notify || '') }), { mode: 0o600, flag: 'wx' });
}
export function jobScope(id, { state } = {}) {
  if (!JOB_ID_RE.test(id)) throw new Error(`bad job id "${id}"`);
  const g = JSON.parse(readFileSync(jobFile(id, state), 'utf8'));
  if (!SCOPE_RE.test(g.scope || '')) throw new Error('bad job scope');
  const want = Buffer.from(jobMac(handlerKey({ state }), id, g.scope, g.notify || '')), got = Buffer.from(String(g.mac || ''));
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('unsigned job record');
  return { scope: g.scope, notify: g.notify || '' };
}

export function pruneGrants({ state } = {}) {
  const d = dir(state); if (!existsSync(d)) return 0;
  let n = 0, key = null;
  try { key = handlerKey({ state }); } catch {}
  for (const f of readdirSync(d)) {
    if (f.startsWith('.')) {   // a grant being minted; only a mint that died leaves one behind for long
      try { if (Date.now() - statSync(path.join(d, f)).mtimeMs > 60e3) { rmSync(path.join(d, f), { force: true }); n++; } } catch {}
      continue;
    }
    try {
      const g = JSON.parse(readFileSync(path.join(d, f), 'utf8'));
      const signed = key && g.mac === mac(key, f.replace(/\.json$/, ''), g.scope, g.expires);
      if (!(g.expires > Date.now()) || !SCOPE_RE.test(g.scope || '') || !signed) { rmSync(path.join(d, f)); n++; }
    }
    catch { rmSync(path.join(d, f), { force: true }); n++; }
  }
  return n;
}

// CLI for the handler: mint <scope> [ttlHours] (needs the handler key) | revoke (token on stdin) | show | owner-read-ok | prune
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    if (cmd === 'mint') console.log(mintGrant(a, { ttlHours: b ? Number(b) : 12 }));
    else if (cmd === 'revoke') revokeGrant(readFileSync(0, 'utf8').trim());
    else if (cmd === 'show') { const c = currentScope(); console.log(c.scope); if (c.scope === 'none') console.error(`scope: ${c.why}`); }
    else if (cmd === 'owner-read-ok') { const c = currentScope(); process.exit(c.why === 'grant' && (['full', 'owner-only'].includes(c.scope) || c.scope.startsWith('routine:')) ? 0 : 3); }
    else if (cmd === 'prune') console.log(`pruned ${pruneGrants()}`);
    // job-sign <id> <notify>: signs the CALLER's own grant scope (never a scope given on the command line).
    else if (cmd === 'job-sign') signJob(a, currentScope().scope, b || '');
    else if (cmd === 'job-scope') { try { console.log(JSON.stringify(jobScope(a))); } catch (e) { console.error(`job ${a}: ${e.message}`); process.exit(3); } }
    else { console.error('usage: scope.mjs mint <full|owner-only|chats:id,...|routine:id,...> [ttlHours] | revoke < token | show | owner-read-ok | prune | job-sign <id> <notifyChat> | job-scope <id>'); process.exit(2); }
  } catch (e) { console.error(e.message); process.exit(2); }
}
