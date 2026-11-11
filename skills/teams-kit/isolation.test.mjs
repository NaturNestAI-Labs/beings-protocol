// Isolation wiring with BEING_ISOLATION=bwrap BEING_ISOLATION_LANES=team: teammate lanes and jobs start through
// being-launch, while the owner lane and owner jobs run as with isolation off. Throwaway kit, fake claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { hostEnv } from './test-env.mjs';
const KIT = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HAVE_BWRAP = spawnSync('bwrap', ['--ro-bind', '/', '/', 'true']).status === 0;

// Fake claude: records where it ran. Inside the sandbox the environment is cleared (model-run), so it logs to the run's
// HOME (a teammate lane's home/ in kit state) unless FAKE_LOG reached it (= not sandboxed).
const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), opt = (k) => (a.indexOf(k) >= 0 ? a[a.indexOf(k) + 1] : '');
const kitEnv = process.env.KIT_ENV_PATH_FOR_TEST || '';
let nnp = ''; try { nnp = (fs.readFileSync('/proc/self/status', 'utf8').match(/NoNewPrivs:\\s*(\\d)/) || [])[1]; } catch {}
const rec = { name: opt('-n'), fakeLog: !!process.env.FAKE_LOG, nnp, home: process.env.HOME,
  kitEnvReadable: (() => { try { fs.readFileSync(process.env.FAKE_KIT_ENV || '${'${KITENV}'}'); return true; } catch { return false; } })(),
  ownerMemReadable: (() => { try { fs.readFileSync('${'${OWNERMEM}'}'); return true; } catch { return false; } })(),
  token: !!process.env.BEING_SEND_TOKEN };
fs.appendFileSync(process.env.FAKE_LOG || path.join(process.env.HOME, 'fake.log'), JSON.stringify(rec) + '\\n');
const res = (a[a.length - 1].match(/RESULT file: (\\S+)/) || [])[1];
if (res) fs.writeFileSync(res, 'done');
`;

function kit(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'isowire-'));
  t.after(async () => {   // the kit's detached children (a job's wake, the work run it starts) finish before the dir goes
    for (let i = 0; i < 300 && spawnSync('pgrep', ['-f', `${dir}/kit/being-(handle|job)`]).status === 0; i++) await sleep(100);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const k = path.join(dir, 'kit'), st = path.join(dir, 'state'), cc = path.join(dir, 'cc', 'bin'), ws = path.join(dir, 'ws'), be = path.join(ws, '.beings');
  for (const d of [k, path.join(k, 'isolation'), st, cc, be, path.join(dir, 'home'), path.join(dir, 'cs'), path.join(st, 'jobs')]) mkdirSync(d, { recursive: true });
  for (const f of ['being-handle', 'being-status', 'being-sessions', 'being-board', 'being-job', 'being-launch', 'kit-broker', 'kit-client.mjs',
    'team-sync', 'model-proxy.mjs', 'model-relay.mjs', 'mesh.py', 'soul.py', 'scope.mjs', 'kit-env.mjs', 'secrets.mjs', 'team-fence.py', 'ack-schema.json',
    'voice-schema.json', 'fast-warm.mjs', 'comms-log.mjs']) copyFileSync(path.join(KIT, f), path.join(k, f));
  for (const f of ['model-run', 'make-shims']) { copyFileSync(path.join(KIT, 'isolation', f), path.join(k, 'isolation', f)); chmodSync(path.join(k, 'isolation', f), 0o755); }
  for (const f of ['being-handle', 'being-status', 'being-sessions', 'being-board', 'being-job', 'being-launch', 'kit-broker', 'team-sync'])
    chmodSync(path.join(k, f), 0o755);
  writeFileSync(path.join(cc, 'claude'), FAKE.replace('${KITENV}', path.join(k, '.env')).replace('${OWNERMEM}', path.join(be, 'MEMORY.md')));
  chmodSync(path.join(cc, 'claude'), 0o755);
  writeFileSync(path.join(be, 'SOUL.md'), '# Testbeing — Soul File\n\n## Identity\n**Name:** Testbeing\n\n## Values\n1. **Dharma**\n');
  writeFileSync(path.join(be, 'MEMORY.md'), 'OWNERPRIVATE\n');
  writeFileSync(path.join(dir, 'team-cred.env'), 'CLAUDE_CODE_OAUTH_TOKEN=fixture-team-cred\n');
  writeFileSync(path.join(k, '.env'), `BEING_NAME=Testbeing\nBEING_STATE_DIR=${st}\nBEING_WORKSPACE=${ws}\nBEING_FAST_CLIENT=claude\n` +
    `BEING_FAST_WARM=0\nOWNER_NAME=Owner\nOWNER_OID=owner-oid\nBEING_SINGLE_USER_ACK=1\nBEING_CLAUDE_SESSIONS_DIR=${path.join(dir, 'cs')}\n` +
    `BEING_ISOLATION=bwrap\nBEING_ISOLATION_LANES=team\nBEING_SANDBOX_CLAUDE_ENV=${path.join(dir, 'team-cred.env')}\n`);
  spawnSync(path.join(k, 'isolation', 'make-shims'), [], { encoding: 'utf8' });
  const host = hostEnv();
  const env = { ...host, PATH: `${cc}:${process.env.PATH}`, HOME: path.join(dir, 'home'), BEING_KIT_HOME: k, BEING_STATE_DIR: st,
    FAKE_LOG: path.join(dir, 'fake.log'), BEING_SEND_TOKEN: '' };
  const run = (cmd, args, extra = {}) => spawnSync(path.join(k, cmd), args, { env: { ...env, ...extra }, encoding: 'utf8', cwd: dir });
  const mint = (scope) => spawnSync('node', [path.join(k, 'scope.mjs'), 'mint', scope], { env, encoding: 'utf8' }).stdout.trim();
  const read = (f) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const laneLog = (chat) => {
    const tag = spawnSync('sh', ['-c', `printf '%s' '${chat}' | sha1sum | cut -c1-10`], { encoding: 'utf8' }).stdout.trim();
    return path.join(st, 'team-lanes', tag, 'home', 'fake.log');
  };
  return { dir, k, st, ws, run, mint, owner: () => read(env.FAKE_LOG), team: (chat) => read(laneLog(chat)) };
}

test('teammate work runs go through bwrap; the owner lane runs unchanged (BEING_ISOLATION_LANES=team)', { skip: !HAVE_BWRAP && 'no bwrap' }, async (t) => {
  const { st, run, owner, team } = kit(t);
  const put = (m) => appendFileSync(path.join(st, 'work.jsonl'), JSON.stringify(m) + '\n');
  put({ chatId: '19:owner', chatType: 'oneOnOne', fromId: 'owner-oid', from: 'Owner', messageId: 'o1', text: 'do it', at: '2026-10-13T01:00:00Z' });
  put({ chatId: '19:robin', chatType: 'oneOnOne', fromId: 'oid-robin', from: 'Robin Lee', messageId: 'n1', text: 'review?', at: '2026-10-13T01:00:00Z' });
  run('being-handle', ['work']);
  for (let i = 0; i < 150 && (owner().filter((r) => r.name === 'testbeing-owner').length < 1 || team('19:robin').length < 1); i++) await sleep(100);
  const o = owner().find((r) => r.name === 'testbeing-owner'), m = team('19:robin').find((r) => r.name === 'testbeing-team-robin');
  assert.ok(o, 'owner run happened, unsandboxed (logged through FAKE_LOG)');
  assert.equal(o.kitEnvReadable, true); assert.equal(o.ownerMemReadable, true); assert.equal(o.token, true, 'owner run keeps its grant in env');
  assert.ok(m, 'teammate run happened inside the sandbox (logged in its lane home)');
  assert.equal(m.fakeLog, false, 'environment cleared');
  assert.equal(m.nnp, '1', 'no_new_privs');
  assert.equal(m.kitEnvReadable, false); assert.equal(m.ownerMemReadable, false); assert.equal(m.token, false, 'grant held by the broker');
  assert.ok(!owner().some((r) => r.name === 'testbeing-team-robin'), 'the teammate run never ran outside the sandbox');
});

test('a teammate\'s job runs in the sandbox and its RESULT comes back; an owner job runs unchanged', { skip: !HAVE_BWRAP && 'no bwrap' }, async (t) => {
  const { st, run, mint, owner, team } = kit(t);
  assert.equal(run('being-job', ['agent', 'ownerjob', '--notify', '19:owner', 'task one']).status, 0);
  const r = run('being-job', ['agent', 'teamjob', '--notify', '19:robin', 'task two'], { BEING_SEND_TOKEN: mint('chats:19:robin') });
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 150 && (!owner().some((x) => x.name.includes('ownerjob')) || !team('19:robin').some((x) => x.name.includes('teamjob'))); i++) await sleep(100);
  const oj = owner().find((x) => x.name.includes('ownerjob')), tj = team('19:robin').find((x) => x.name.includes('teamjob'));
  assert.ok(oj && oj.kitEnvReadable, 'owner job unsandboxed');
  if (!tj) { const { readdirSync: rd } = await import('node:fs'); for (const f of rd(path.join(st, 'jobs'))) console.log('JOBFILE', f, readFileSync(path.join(st, 'jobs', f), 'utf8').slice(0, 1500)); }
  assert.ok(tj, 'teammate job ran in its lane sandbox'); assert.equal(tj.kitEnvReadable, false); assert.equal(tj.nnp, '1');
  const { readdirSync } = await import('node:fs');
  let done = false;
  for (let i = 0; i < 100 && !done; i++) {
    done = readdirSync(path.join(st, 'jobs')).filter((f) => f.endsWith('.json') && f.includes('teamjob'))
      .some((f) => JSON.parse(readFileSync(path.join(st, 'jobs', f), 'utf8')).status === 'done');
    if (!done) await sleep(100);
  }
  assert.ok(done, 'teammate job is done: its RESULT file was collected back into kit state');
});

// Broker deadlock regression: a real (non-dry) team broker runs a stand-in teams-send-dm that reads all of stdin
// before it writes anything, like the real one; the send must complete.
test('broker, real (non-dry) send: the child gets stdin EOF, answers, and the client exits (no deadlock)', async (t) => {
  const { k, st } = kit(t);
  copyFileSync(path.join(KIT, 'kit-client.mjs'), path.join(k, 'kit-client.mjs'));
  writeFileSync(path.join(k, 'teams-send-dm.mjs'), `import { readFileSync } from 'node:fs';
const body = readFileSync(0, 'utf8');   // blocks until stdin EOF, like the real sender
process.stdout.write('sent ' + process.argv.slice(2).join(' ') + ' :: ' + body.trim() + '\\n');\n`);
  const { spawn } = await import('node:child_process');
  const sock = path.join(st, 'b-test.sock');
  const env = { ...hostEnv(), BEING_KIT_HOME: k, BEING_STATE_DIR: st };
  for (const key of Object.keys(env)) if (/^(OWNER_|M365_)/.test(key)) delete env[key];
  const broker = spawn('python3', [path.join(k, 'kit-broker'), 'serve', '--socket', sock, '--class', 'team', '--peer-uid', String(process.getuid()),
    '--chat', '19:eof-test@thread.v2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => broker.kill());
  let err = ''; broker.stderr.on('data', (d) => { err += d; });
  await new Promise((res, rej) => { broker.stdout.once('data', res); broker.once('exit', () => rej(new Error('broker died: ' + err))); });
  const t0 = Date.now();
  const r = spawnSync('node', [path.join(k, 'kit-client.mjs'), '--chat', '19:eof-test@thread.v2'], { input: 'hello from the lane\n',
    encoding: 'utf8', timeout: 15000, env: { ...env, KIT_CLIENT_VERB: 'teams-send-dm', BEING_BROKER_SOCK: sock } });
  assert.notEqual(r.signal, 'SIGTERM', `client hung (deadlock) for ${Date.now() - t0} ms`);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sent --chat 19:eof-test@thread\.v2 :: hello from the lane/);
  assert.ok(Date.now() - t0 < 10000, 'answered promptly');
});

test('broker, attachment fetch from a read-only cwd: saved under $HOME/attachments, stdout names that file (not the broker temp)', async (t) => {
  const { dir, k, st } = kit(t);
  copyFileSync(path.join(KIT, 'kit-client.mjs'), path.join(k, 'kit-client.mjs'));
  // Stand-in fetcher: writes the file into --out and prints its path, like the real one.
  writeFileSync(path.join(k, 'teams-fetch-attachment.mjs'), `import { mkdirSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2), out = a[a.indexOf('--out') + 1]; mkdirSync(out, { recursive: true });
const file = out + '/1-image.png'; writeFileSync(file, 'PNGDATA'); console.log(JSON.stringify({ file, bytes: 7 }));\n`);
  const { spawn } = await import('node:child_process');
  const sock = path.join(st, 'b-att.sock');
  const env = { ...hostEnv(), BEING_KIT_HOME: k, BEING_STATE_DIR: st };
  for (const key of Object.keys(env)) if (/^(OWNER_|M365_)/.test(key)) delete env[key];
  const broker = spawn('python3', [path.join(k, 'kit-broker'), 'serve', '--socket', sock, '--class', 'team', '--peer-uid', String(process.getuid()),
    '--chat', '19:att-test@thread.v2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => broker.kill());
  let err = ''; broker.stderr.on('data', (d) => { err += d; });
  await new Promise((res, rej) => { broker.stdout.once('data', res); broker.once('exit', () => rej(new Error('broker died: ' + err))); });
  const ro = path.join(dir, 'ro-ws'), home = path.join(dir, 'lane-home');
  mkdirSync(ro); mkdirSync(home); chmodSync(ro, 0o555);
  t.after(() => { try { chmodSync(ro, 0o755); } catch { /* already removed */ } });
  const r = spawnSync('node', [path.join(k, 'kit-client.mjs'), 'https://graph.microsoft.com/v1.0/chats/19:att-test@thread.v2/messages/1/hostedContents/x/$value'],
    { cwd: ro, encoding: 'utf8', timeout: 15000, env: { ...env, HOME: home, KIT_CLIENT_VERB: 'teams-fetch-attachment', BEING_BROKER_SOCK: sock } });
  assert.equal(r.status, 0, r.stderr);
  const printed = JSON.parse(r.stdout.trim()).file;
  assert.equal(printed, path.join(home, 'attachments', '1-image.png'), `stdout path: ${r.stdout}`);
  assert.equal(readFileSync(printed, 'utf8'), 'PNGDATA');
  assert.ok(!existsSync(path.join(ro, 'attachments')), 'nothing written in the read-only cwd');
});

// S4: a teammate lane on the model proxy has no network of the host's; the model is reached through a unix socket.
test('bwrap teammate lane: --unshare-net, the model call works through the relay, host loopback is unreachable', { skip: !HAVE_BWRAP && 'no bwrap' }, async (t) => {
  const { dir, k, st, ws } = kit(t);
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const up = http.createServer((req, res) => { res.end(req.headers.authorization === 'Bearer fixture-access-tok' ? 'AUTH-OK' : 'AUTH-BAD'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r)); t.after(() => up.close());
  const upport = up.address().port;
  const creds = path.join(dir, 'creds.json');
  writeFileSync(creds, JSON.stringify({ claudeAiOauth: { accessToken: 'fixture-access-tok', expiresAt: Date.now() + 3600e3 } }), { mode: 0o600 });
  writeFileSync(path.join(st, 'soul-public.md'), 'public soul\n');
  const host = hostEnv();
  const env = { ...host, HOME: path.join(dir, 'home'), BEING_KIT_HOME: k, BEING_STATE_DIR: st, BEING_WORKSPACE: ws, BEING_NAME: 'Testbeing',
    BEING_ISOLATION: 'bwrap', BEING_ISOLATION_LANES: 'team', BEING_PROXY_CRED: creds, BEING_PROXY_UPSTREAM: `http://127.0.0.1:${upport}` };
  assert.equal(spawnSync('python3', [path.join(k, 'team-sync'), '19:net@thread.v2'], { env, encoding: 'utf8' }).status, 0);
  const probe = `const b = process.env.ANTHROPIC_BASE_URL, k = process.env.ANTHROPIC_AUTH_TOKEN;
const model = await fetch(b + '/v1/messages', { method: 'POST', headers: { authorization: 'Bearer ' + k }, body: '{}' }).then((r) => r.text(), (e) => 'ERR ' + e.cause?.code);
const host = await fetch('http://127.0.0.1:${upport}/').then(() => 'reached', (e) => 'blocked ' + (e.cause?.code || ''));
const ifs = Object.keys((await import('node:os')).networkInterfaces());
console.log(JSON.stringify({ model, host, ifs, base: b, cred: !!process.env.BEING_PROXY_CRED }));`;
  const r = await new Promise((res) => {
    const c = spawn(path.join(k, 'being-launch'), ['team:19:net@thread.v2', '--', 'node', '--input-type=module', '-e', probe], { env, cwd: dir });
    let out = '', err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('exit', (code) => res({ code, out, err }));
  });
  assert.equal(r.code, 0, r.err);
  const o = JSON.parse(r.out.trim().split('\n').pop());
  assert.equal(o.model, 'AUTH-OK', 'model call through relay → unix socket → proxy → upstream');
  assert.match(o.host, /^blocked/, 'the host loopback (where the upstream listens) is not reachable');
  assert.deepEqual(o.ifs, ['lo'], 'own network namespace: loopback only');
  assert.match(o.base, /^http:\/\/127\.0\.0\.1:\d+$/); assert.equal(o.cred, false);
  assert.ok(!readdirSync(path.join(st, 'run')).some((f) => f.startsWith('model-')), 'proxy socket removed after the run');
});

test('BEING_SANDBOX_NET accepts only none|host: a typo stops the launch instead of using the host network', (t) => {
  const { k, st, ws } = kit(t);
  const run = (net) => spawnSync(path.join(k, 'being-launch'), ['team:19:x', '--', 'true'], { encoding: 'utf8',
    env: { ...hostEnv(), BEING_KIT_HOME: k, BEING_STATE_DIR: st, BEING_WORKSPACE: ws, BEING_ISOLATION: 'bwrap',
      BEING_ISOLATION_LANES: 'team', BEING_LAUNCH_DRY: '1', BEING_SANDBOX_NET: net } });
  const r = run('hots');
  assert.equal(r.status, 5, r.stderr); assert.match(r.stderr, /BEING_SANDBOX_NET=hots \(none\|host\)/);
});

test('bwrap: a node installed outside /usr is bound into the sandbox at /run/bin/node; one under /usr is not', { skip: !HAVE_BWRAP && 'no bwrap' }, (t) => {
  const { dir, k, st, ws } = kit(t);
  const fakeNode = path.join(dir, 'opt-node', 'bin', 'node');
  mkdirSync(path.dirname(fakeNode), { recursive: true }); writeFileSync(fakeNode, '#!/bin/sh\n'); chmodSync(fakeNode, 0o755);
  const dry = (nodeBin) => spawnSync(path.join(k, 'being-launch'), ['job', '--', 'true'], { encoding: 'utf8',
    env: { ...hostEnv(), PATH: `${path.join(dir, 'cc', 'bin')}:${process.env.PATH}`, BEING_KIT_HOME: k, BEING_STATE_DIR: st, BEING_WORKSPACE: ws,
      BEING_NAME: 'Testbeing', BEING_ISOLATION: 'bwrap', BEING_ISOLATION_LANES: 'all', BEING_LAUNCH_DRY: '1', BEING_NODE_BIN: nodeBin } });
  const outside = dry(fakeNode);
  assert.equal(outside.status, 0, outside.stderr);
  assert.ok(outside.stdout.includes(`--ro-bind ${fakeNode} /run/bin/node`), outside.stdout);
  const usr = spawnSync('sh', ['-c', 'for n in /usr/bin/*; do [ -x "$n" ] && [ ! -L "$n" ] && { echo "$n"; break; }; done'], { encoding: 'utf8' }).stdout.trim();
  const inside = dry(usr);
  assert.equal(inside.status, 0, inside.stderr);
  assert.ok(!inside.stdout.includes('/run/bin/node'), 'a /usr node is already in the sandbox');
  const none = dry(path.join(dir, 'missing-node'));
  assert.equal(none.status, 5); assert.match(none.stderr, /no node binary/);
});
