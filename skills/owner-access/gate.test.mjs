// End-to-end refusals: a temporary Teams kit with this component installed by kit-install.sh, a stub MSAL module, and
// real grants from scope.mjs. Every case must stop before any sign-in is opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxId } from './sessions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEAMS = path.join(HERE, '..', 'teams-kit');
const ENV = { PATH: process.env.PATH, HOME: process.env.HOME };

function kit() {
  const home = mkdtempSync(path.join(tmpdir(), 'oa-home-')), k = path.join(home, 'ops', 'teams-kit');
  mkdirSync(path.join(k, 'node_modules', '@azure', 'msal-node'), { recursive: true });
  for (const f of ['graph.mjs', 'kit-env.mjs', 'cache-write.mjs', 'strip.mjs', 'scope.mjs', 'comms-log.mjs']) copyFileSync(path.join(TEAMS, f), path.join(k, f));
  writeFileSync(path.join(k, 'node_modules', '@azure', 'msal-node', 'package.json'), '{"name":"@azure/msal-node","type":"module","main":"index.js"}');
  writeFileSync(path.join(k, 'node_modules', '@azure', 'msal-node', 'index.js'), 'export class PublicClientApplication { constructor() { throw new Error("STUB: sign-in opened"); } }\n');
  const st = path.join(k, 'state');
  writeFileSync(path.join(k, '.env'), [`BEING_STATE_DIR=${st}`, 'BEING_UPN=being@example.com', 'OWNER_UPN=owner@example.com',
    `BEING_CACHE=${st}/being-cache.json`, `OWNER_CACHE=${st}/owner-cache.json`, 'BEING_OWNER_DELEGATE=1', 'M365_CLIENT_ID=x', 'M365_TENANT_ID=y'].join('\n') + '\n');
  const r = spawnSync('bash', [path.join(HERE, 'kit-install.sh'), home], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0, r.stderr);
  return { home, k, st };
}
const grant = (k, scope) => spawnSync('node', [path.join(k, 'scope.mjs'), 'mint', scope, '1'], { encoding: 'utf8', env: ENV }).stdout.trim();
const scan = (k, token) => spawnSync('node', [path.join(k, 'shared-inbox-monitor.mjs'), 'scan', '--since', '2026-01-01', '--out', path.join(k, 'x.json')],
  { encoding: 'utf8', env: { ...ENV, ...(token && { BEING_SEND_TOKEN: token }) } });
const on = (k, extra = '') => writeFileSync(path.join(k, 'owner-access.toml'),
  `[owner_access]\nenabled = true\n[abilities]\nshared_mailbox_read = true\nowner_files = true\n[shared_mailbox]\naddress = "team@example.com"\n${extra}`);
const stamp = (st, role, service, account, box = boxId()) => {
  mkdirSync(path.join(st, 'sessions'), { recursive: true });
  writeFileSync(path.join(st, 'sessions', `${role}-${service}.json`), JSON.stringify({ role, service, account, box, at: 'x' }));
};

test('kit-install: copies the component, example config all off, keeps an existing config, prints both sign-ins', () => {
  const { home, k } = kit();
  for (const f of ['owner-web', 'owner-web.mjs', 'owner-session.mjs', 'shared-mailbox-drafts.mjs', 'channel-posts.mjs', 'mail-forward-rules.mjs',
    'verify-upload.py', 'OWNER-ACCESS.md', 'owner-access.toml.example']) assert.ok(existsSync(path.join(k, f)), f);
  assert.ok(!readdirSync(k).some((f) => f.endsWith('.test.mjs')));
  assert.doesNotMatch(readFileSync(path.join(k, 'owner-access.toml.example'), 'utf8'), /^\s*[a-z_]+ = true/m);
  writeFileSync(path.join(k, 'owner-access.toml'), 'mine');
  const toml = path.join(home, 'being.toml');
  writeFileSync(toml, '[access]\nowner_files = true\ncodex = false\n');
  const r = spawnSync('bash', [path.join(HERE, 'kit-install.sh'), home, toml], { encoding: 'utf8', env: ENV });
  assert.equal(r.status, 0);
  assert.equal(readFileSync(path.join(k, 'owner-access.toml'), 'utf8'), 'mine');
  assert.match(r.stdout, /being login being/);
  assert.match(r.stdout, /being login owner/);
  assert.match(r.stdout, /owner_files/);
  assert.doesNotMatch(r.stdout, /codex/);
  const missing = spawnSync('bash', [path.join(HERE, 'kit-install.sh'), mkdtempSync(path.join(tmpdir(), 'oa-none-'))], { encoding: 'utf8', env: ENV });
  assert.equal(missing.status, 1);
});

test('refused in order: no grant, teammate grant, ability off, paused, sessions missing, other box, one cache', () => {
  const { k, st } = kit();
  assert.equal(scan(k).status, 3, 'no grant');
  assert.equal(scan(k, grant(k, 'chats:19:abc@thread.v2')).status, 3, 'teammate lane');
  assert.equal(scan(k, 'forged-token').status, 3, 'bad grant');
  const owner = grant(k, 'owner-only');
  let r = scan(k, owner);
  assert.equal(r.status, 4, r.stderr);
  on(k);
  mkdirSync(path.join(st, 'owner-access'), { recursive: true });
  writeFileSync(path.join(st, 'owner-access', 'shared_mailbox_read.pause'), '');
  assert.equal(scan(k, owner).status, 5);
  rmSync(path.join(st, 'owner-access', 'shared_mailbox_read.pause'));
  r = scan(k, owner);
  assert.equal(r.status, 6); assert.match(r.stderr, /both sessions are signed in/);
  stamp(st, 'being', 'outlook', 'being@example.com');
  r = scan(k, owner);
  assert.equal(r.status, 6); assert.match(r.stderr, /owner outlook session not signed in/);
  stamp(st, 'owner', 'outlook', 'owner@example.com', 'another-box');
  r = scan(k, owner);
  assert.equal(r.status, 6); assert.match(r.stderr, /another box/);
  stamp(st, 'owner', 'outlook', 'owner@example.com');
  r = scan(k, owner);
  assert.match(r.stderr, /STUB: sign-in opened/, 'all checks pass, then the session opens');
  writeFileSync(path.join(k, '.env'), readFileSync(path.join(k, '.env'), 'utf8').replace(/OWNER_CACHE=.*/, `OWNER_CACHE=${st}/being-cache.json`));
  r = scan(k, owner);
  assert.equal(r.status, 6); assert.match(r.stderr, /share one token cache/);
});

test('only the approved scripts may open owner sessions; owner-web refuses teammate lanes and non-Microsoft hosts', () => {
  const { k, st } = kit();
  on(k, '[owner_web]\nmy_host = "https://org-my.sharepoint.com"\nroot_host = "https://org.sharepoint.com"\n');
  const owner = grant(k, 'owner-only');
  const probe = path.join(k, 'probe.mjs');
  writeFileSync(probe, "import { preflight } from './owner-session.mjs'; preflight('owner_files', { services: ['browser'] });\n");
  assert.equal(spawnSync('node', [probe], { env: { ...ENV, BEING_SEND_TOKEN: owner } }).status, 2);
  const web = (args, token) => spawnSync(path.join(k, 'owner-web'), args, { encoding: 'utf8', env: { ...ENV, ...(token && { BEING_SEND_TOKEN: token }) } });
  assert.equal(web(['search', 'x'], grant(k, 'chats:19:abc@thread.v2')).status, 3);
  assert.equal(web(['check']).status, 3);
  for (const role of ['being', 'owner']) stamp(st, role, 'browser', `${role}@example.com`);
  const r = web(['get', 'https://example.com/file.pdf'], owner);
  assert.equal(r.status, 2); assert.match(r.stderr, /Microsoft 365/);
  assert.equal(web(['upload', 'x'], owner).status, 2);
});

test('shared-mailbox send and channel posts need their own switches', () => {
  const { k } = kit();
  on(k);
  const owner = grant(k, 'owner-only');
  const run = (f, args) => spawnSync('node', [path.join(k, f), ...args], { encoding: 'utf8', env: { ...ENV, BEING_SEND_TOKEN: owner } });
  const m = path.join(k, 'm.json');
  writeFileSync(m, '{}');
  assert.equal(run('shared-mailbox-drafts.mjs', ['send', '--manifest', m]).status, 4);
  assert.equal(run('shared-mailbox-drafts.mjs', ['create', '--input', m]).status, 4);
  assert.equal(run('mail-forward-rules.mjs', []).status, 4);
  const c = run('channel-posts.mjs', ['apply', '--manifest', m]);
  assert.equal(c.status, 2); assert.match(c.stderr, /manifest/);
});

test('browser route: needs both browser sessions (not the API ones); a bad route value stops the tool', () => {
  const { k, st } = kit();
  const cfg = (route) => writeFileSync(path.join(k, 'owner-access.toml'),
    `[owner_access]\nenabled = true\n[abilities]\nshared_mailbox_drafts = true\n[shared_mailbox]\naddress = "team@example.com"\nroute = "${route}"\n`);
  const input = path.join(k, 'in.json');
  writeFileSync(input, JSON.stringify([{ to: 'a@example.com', subject: 'Hello', body_text: 'x' }]));
  const owner = grant(k, 'owner-only');
  const run = () => spawnSync('node', [path.join(k, 'shared-mailbox-drafts.mjs'), 'create', '--input', input], { encoding: 'utf8', env: { ...ENV, BEING_SEND_TOKEN: owner } });
  cfg('web');
  let r = run();
  assert.equal(r.status, 2); assert.match(r.stderr, /must be "graph" or "browser"/);
  cfg('browser');
  for (const role of ['being', 'owner']) stamp(st, role, 'outlook', `${role}@example.com`);
  r = run();
  assert.equal(r.status, 6); assert.match(r.stderr, /being browser session not signed in/);
  stamp(st, 'being', 'browser', 'being@example.com');
  r = run();
  assert.equal(r.status, 6); assert.match(r.stderr, /owner browser session not signed in/);
  stamp(st, 'owner', 'browser', 'owner@example.com');
  r = run();
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /WOULD CREATE: a@example\.com \| Hello/);
});
