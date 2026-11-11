// kit-broker path-in flags: every file flag of every verb crosses as bytes (both --flag PATH and --flag=PATH forms),
// and a raw host path or an undeclared file flag is refused. Throwaway kit, stand-in commands, a real ai-class broker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findSecretsInFiles } from './secrets.mjs';

import { hostEnv } from './test-env.mjs';
const KIT = path.dirname(fileURLToPath(import.meta.url));
// Stand-in for mail.mjs / draft-for-owner.mjs: prints each argument, and for a file value its content (or MISSING).
const ECHO = `import { existsSync, readFileSync } from 'node:fs';
const show = (v) => v.split(',').map((x) => { const f = x.replace(/=[^=\\/]*$/, ''); return existsSync(f) ? x + ' <' + readFileSync(f, 'utf8') + '>' : x; }).join(',');
console.log(JSON.stringify(process.argv.slice(2).map(show)));\n`;

const verbsIn = () => JSON.parse(spawnSync('python3', ['-I', '-c', `import importlib.machinery as m, importlib.util as u, json, sys
l = m.SourceFileLoader("kb", sys.argv[1]); b = u.module_from_spec(u.spec_from_loader("kb", l)); l.exec_module(b)
print(json.dumps({v: d[2] for v, d in b.VERBS.items() if d[2]}))`, path.join(KIT, 'kit-broker')], { encoding: 'utf8' }).stdout);

async function broker(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'kbtest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const k = path.join(dir, 'kit'), st = path.join(dir, 'state'), host = path.join(dir, 'host');
  for (const d of [k, st, host]) mkdirSync(d);
  for (const f of ['kit-broker', 'kit-client.mjs']) copyFileSync(path.join(KIT, f), path.join(k, f));
  for (const f of ['mail.mjs', 'draft-for-owner.mjs']) writeFileSync(path.join(k, f), ECHO);
  writeFileSync(path.join(host, 'a.txt'), 'AAA'); writeFileSync(path.join(host, 'b.txt'), 'BBB'); writeFileSync(path.join(host, 'logo.png'), 'PNG');
  const sock = path.join(st, 'b.sock');
  const env = { ...hostEnv(), BEING_STATE_DIR: st };
  const b = spawn('python3', [path.join(k, 'kit-broker'), 'serve', '--socket', sock, '--class', 'ai', '--peer-uid', String(process.getuid())],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => b.kill());
  let err = ''; b.stderr.on('data', (d) => { err += d; });
  await new Promise((res, rej) => { b.stdout.once('data', res); b.once('exit', () => rej(new Error('broker died: ' + err))); });
  const client = (verb, args) => {
    const r = spawnSync('node', [path.join(k, 'kit-client.mjs'), ...args], { encoding: 'utf8', timeout: 15000, input: '',
      env: { ...env, KIT_CLIENT_VERB: verb, BEING_BROKER_SOCK: sock } });
    return { ...r, argv: r.status === 0 ? JSON.parse(r.stdout) : null };
  };
  return { host, sock, client };
}

// A hand-built header, as a hostile run could send it: no kit-client, no files_in.
function raw(sock, verb, args) {
  return new Promise((res) => {
    const c = net.createConnection(sock);
    let buf = Buffer.alloc(0), out = '', rc = null;
    const frame = (t, b) => { const h = Buffer.alloc(5); h.write(t, 0, 'latin1'); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };
    c.on('connect', () => { c.write(frame('H', Buffer.from(JSON.stringify({ verb, args })))); c.write(frame('E', Buffer.alloc(0))); });
    c.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 5 && buf.length >= 5 + buf.readUInt32BE(1)) {
        const t = buf.toString('latin1', 0, 1), n = buf.readUInt32BE(1), p = buf.subarray(5, 5 + n); buf = buf.subarray(5 + n);
        if (t === 'X') rc = JSON.parse(p).rc; else out += p.toString();
      }
    });
    c.on('error', () => {}); c.on('close', () => res({ rc, out }));
  });
}

const value = (flag, kind, host) => (kind === 'cid' ? `${host}/logo.png=logo1` : `${host}/a.txt,${host}/b.txt`);

test('every path-in flag of every verb is rewritten to broker-owned bytes, in --flag PATH and --flag=PATH form', async (t) => {
  const { host, client } = await broker(t);
  const table = verbsIn();
  assert.deepEqual(Object.keys(table).sort(), ['draft-for-owner', 'mail']);
  assert.deepEqual(table.mail, { '--attach': 'list', '--inline': 'cid' });
  for (const [verb, flags] of Object.entries(table)) {
    for (const [flag, kind] of Object.entries(flags)) {
      for (const form of ['split', 'joined']) {
        const v = value(flag, kind, host);
        const r = client(verb, ['--send', '--to', 'o@x', ...(form === 'split' ? [flag, v] : [`${flag}=${v}`])]);
        assert.equal(r.status, 0, `${verb} ${flag} ${form}: ${r.stderr}`);
        const i = r.argv.indexOf(flag); assert.ok(i > 0, `${verb} ${flag} ${form}: flag passed on split`);
        const got = r.argv[i + 1];
        assert.ok(!got.includes(host), `${verb} ${flag} ${form}: host path crossed: ${got}`);
        if (kind === 'cid') assert.match(got, /^\/\S+\/logo\.png=logo1 <PNG>$/);
        else assert.match(got, /^\/\S+\/a\.txt <AAA>,\/\S+\/b\.txt <BBB>$/);
      }
    }
  }
});

test('a raw host path on a path-in flag, or an undeclared file flag, is refused', async (t) => {
  const { host, sock, client } = await broker(t);
  for (const [verb, flags] of Object.entries(verbsIn())) {
    for (const [flag, kind] of Object.entries(flags)) {
      const v = value(flag, kind, host);
      for (const args of [[flag, v], [`${flag}=${v}`], [flag]]) {
        const r = await raw(sock, verb, ['--send', ...args]);
        assert.equal(r.rc, 3, `${verb} ${args.join(' ')}: ${r.out}`); assert.match(r.out, /refused/);
      }
    }
  }
  for (const args of [['--file', `${host}/a.txt`], [`--path=${host}/a.txt`], ['--output', host]]) {
    const r = client('mail', ['--send', ...args]);
    assert.equal(r.status, 3, `${args.join(' ')}: ${r.stdout}`); assert.match(r.stderr, /not a file flag/);
  }
  for (const args of [['name', 'x', '--msgs', `${host}/m.jsonl`], ['end', `--transcript=${host}/t.jsonl`]]) {
    const r = await raw(sock, 'being-sessions', args);
    assert.equal(r.rc, 3, `being-sessions ${args.join(' ')}: ${r.out}`); assert.match(r.out, /not a file flag/);
  }
  assert.equal((await raw(sock, 'draft-for-owner', ['--mail', '--inline', `${host}/logo.png=x`])).rc, 3, 'draft has no --inline');
  const bad = client('mail', ['--send', '--inline', `${host}/logo.png=bad cid!`]);
  assert.equal(bad.status, 3);
});

test('attachment bytes go through the secret scan', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'kbsec-'));
  try {
    writeFileSync(path.join(dir, 'ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    writeFileSync(path.join(dir, 'leak.txt'), 'x\nBEING_UPN=nova@example.org\n');
    writeFileSync(path.join(dir, 'key.bin'), Buffer.concat([Buffer.from([0, 255]), Buffer.from(' sk-ant-api03-' + 'A'.repeat(40))]));
    assert.deepEqual(findSecretsInFiles([path.join(dir, 'ok.png')], { secrets: [] }), []);
    assert.deepEqual(findSecretsInFiles([path.join(dir, 'leak.txt'), path.join(dir, 'key.bin')], { secrets: [] }),
      ['leak.txt: env-line', 'key.bin: api-key']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
