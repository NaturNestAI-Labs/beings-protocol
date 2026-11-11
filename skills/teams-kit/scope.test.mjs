import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, copyFileSync, chmodSync, existsSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { signJob, jobScope, mintGrant, revokeGrant, currentScope, allowedChats, pruneGrants, handlerKey, keyFile } from './scope.mjs';

import { hostEnv } from './test-env.mjs';
const state = () => mkdtempSync(path.join(tmpdir(), 'scope-'));

test('no token is owner-only; an unknown or revoked token is none (refused), never the owner', () => {
  const s = state();
  assert.equal(currentScope({ state: s, token: '' }).scope, 'owner-only');
  assert.equal(currentScope({ state: s, token: 'made-up' }).scope, 'none');
  const t = mintGrant('chats:a,b', { state: s });
  assert.equal(currentScope({ state: s, token: t }).scope, 'chats:a,b');
  revokeGrant(t, { state: s });
  assert.equal(currentScope({ state: s, token: t }).scope, 'none');
});

test('only the hash is stored; expired, malformed, unsigned and unreadable grants are none', () => {
  const s = state();
  const t = mintGrant('full', { state: s });
  const [f] = readdirSync(path.join(s, 'grants'));
  assert.ok(!f.includes(t));
  writeFileSync(path.join(s, 'grants', f), JSON.stringify({ scope: 'full', expires: Date.now() - 1 }));
  assert.deepEqual(currentScope({ state: s, token: t }), { scope: 'none', why: 'expired grant' });
  writeFileSync(path.join(s, 'grants', f), JSON.stringify({ scope: 'everything', expires: Date.now() + 1e6 }));
  assert.equal(currentScope({ state: s, token: t }).scope, 'none');
  writeFileSync(path.join(s, 'grants', f), JSON.stringify({ scope: 'full', expires: Date.now() + 1e6, mac: 'x' }));
  assert.deepEqual(currentScope({ state: s, token: t }), { scope: 'none', why: 'unsigned grant' });
  writeFileSync(path.join(s, 'grants', f), '{not json');
  assert.deepEqual(currentScope({ state: s, token: t }), { scope: 'none', why: 'unreadable grant' });
  assert.equal(pruneGrants({ state: s }), 1);
});

test('bad scopes cannot be minted; chats parse', () => {
  assert.throws(() => mintGrant('chats:', { state: state() }));
  assert.throws(() => mintGrant('', { state: state() }));
  assert.deepEqual(allowedChats('chats:x,y'), ['x', 'y']);
  assert.deepEqual(allowedChats('full'), []);
});

// A kit copy with its own on-disk .env, as installed; the CLI reads state from there, not from process env.
const kit = (s) => {
  const d = mkdtempSync(path.join(tmpdir(), 'kit-'));
  for (const f of ['scope.mjs', 'kit-env.mjs']) copyFileSync(f, path.join(d, f));
  writeFileSync(path.join(d, '.env'), `BEING_STATE_DIR='${s}'\n`);
  return (args, env = {}, input) => spawnSync('node', [path.join(d, 'scope.mjs'), ...args],
    { env: { ...hostEnv(), BEING_SEND_TOKEN: '', ...env }, encoding: 'utf8', input });
};

test('BEING_SEND_SCOPE and BEING_STATE_DIR in the environment are ignored', () => {
  const s = state(), run = kit(s);
  assert.equal(run(['show'], { BEING_SEND_SCOPE: 'full' }).stdout.trim(), 'owner-only');
  const evil = state(), t = mintGrant('full', { state: evil });   // a grant in a directory the run controls
  assert.equal(run(['show'], { BEING_STATE_DIR: evil, BEING_SEND_TOKEN: t }).stdout.trim(), 'none');
});

test('owner-read-ok needs a real full or owner-only grant', () => {
  const s = state(), run = kit(s);
  const code = (tok) => run(['owner-read-ok'], { BEING_SEND_TOKEN: tok }).status;
  assert.equal(code(''), 3);
  assert.equal(code(mintGrant('chats:a', { state: s })), 3);
  assert.equal(code(mintGrant('owner-only', { state: s })), 0);
  assert.equal(code(mintGrant('full', { state: s })), 0);
});

test('a grant file written without the handler key is not honoured', () => {
  const s = state(), t = mintGrant('chats:a', { state: s });
  const [f] = readdirSync(path.join(s, 'grants'));
  const g = JSON.parse(readFileSync(path.join(s, 'grants', f), 'utf8'));
  writeFileSync(path.join(s, 'grants', f), JSON.stringify({ ...g, scope: 'full' }));   // escalate an existing grant
  assert.equal(currentScope({ state: s, token: t }).scope, 'none');
  writeFileSync(path.join(s, 'grants', f), JSON.stringify({ scope: 'full', expires: Date.now() + 1e6 }));   // forged, unsigned
  assert.equal(currentScope({ state: s, token: t }).why, 'unsigned grant');
  assert.equal(pruneGrants({ state: s }), 1);
});

test('mint full needs the handler key: unreadable or loose key refuses', { skip: process.getuid?.() === 0 && 'root reads any file' }, () => {
  const s = state(), run = kit(s);
  const t = run(['mint', 'full', '1']);
  assert.equal(t.status, 0);
  assert.equal(run(['show'], { BEING_SEND_TOKEN: t.stdout.trim() }).stdout.trim(), 'full');
  chmodSync(keyFile(s), 0o000);   // what a separate model user sees in the two-user layout
  const r = run(['mint', 'full', '1']);
  assert.equal(r.status, 2); assert.equal(r.stdout, '');
  assert.equal(run(['show'], { BEING_SEND_TOKEN: t.stdout.trim() }).stdout.trim(), 'none');
  chmodSync(keyFile(s), 0o644);
  assert.match(run(['mint', 'full', '1']).stderr, /must be mode 600/);
  assert.throws(() => handlerKey({ state: state() }), /no handler key/);
});

// Scheduled routines (review #10): owner lane for reads, sends limited to the routine's own chat, never full.
test('routine scope: owner reads allowed, sends limited to its chats, signed job record round-trips', () => {
  const s = state(), run = kit(s);
  const t = mintGrant('routine:19:abc@thread.v2', { state: s });
  assert.equal(currentScope({ state: s, token: t }).scope, 'routine:19:abc@thread.v2');
  assert.deepEqual(allowedChats('routine:19:abc@thread.v2,x'), ['19:abc@thread.v2', 'x']);
  assert.equal(run(['owner-read-ok'], { BEING_SEND_TOKEN: t }).status, 0);
  assert.throws(() => mintGrant('routine:', { state: s }));
  signJob('0101-000000-routine-x', 'routine:c1', 'n', { state: s });
  assert.equal(jobScope('0101-000000-routine-x', { state: s }).scope, 'routine:c1');
});

function routineEnv() {   // a throwaway routines.conf; the real one (gitignored) holds the Being's own chat ids
  const d = mkdtempSync(path.join(tmpdir(), 'routine-')), conf = path.join(d, 'routines.conf');
  writeFileSync(conf, 'brief owner\nteamreport 19:leads@thread.v2\n');
  return { ...hostEnv(), BEING_ROUTINES_FILE: conf, OWNER_DM_CHAT: '19:owner_being@unq.gbl.spaces', BEING_STATE_DIR: d };
}

test('being-routine --dry-run names the routine\'s own chat as scope and never asks for full', () => {
  const r = spawnSync('./being-routine', ['teamreport', '--dry-run'], { encoding: 'utf8', env: routineEnv() });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /scope routine:19:leads@thread\.v2;/);
  assert.doesNotMatch(r.stdout, /scope full/);
  assert.equal(spawnSync('./being-routine', ['bogus'], { encoding: 'utf8', env: routineEnv() }).status, 2);
});

test('a grant is written whole and renamed in (0600); a prune leaves one being minted and clears a stale leftover', () => {
  const s = state(), t = mintGrant('chats:a', { state: s }), g = path.join(s, 'grants');
  const files = readdirSync(g);
  assert.equal(files.length, 1); assert.match(files[0], /^[0-9a-f]{64}\.json$/);
  assert.equal(statSync(path.join(g, files[0])).mode & 0o777, 0o600);
  const tmp = path.join(g, `.${'0'.repeat(64)}.tmp`);
  writeFileSync(tmp, '{"scope":"ch');                                    // a grant mid-write
  assert.equal(pruneGrants({ state: s }), 0); assert.ok(existsSync(tmp));
  const old = (Date.now() - 120e3) / 1000; utimesSync(tmp, old, old);
  assert.equal(pruneGrants({ state: s }), 1); assert.ok(!existsSync(tmp));
  assert.equal(currentScope({ state: s, token: t }).scope, 'chats:a');
});
