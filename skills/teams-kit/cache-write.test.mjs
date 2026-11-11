// cache-write: token cache writes are atomic (no torn reads) and merged under flock (no lost entries) when several
// processes write the same cache at once (review #12). Fake MSAL-shaped caches; no real tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCaches, writeCache } from './cache-write.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));

test('merge keeps entries from both sides; ours wins per key', () => {
  const disk = JSON.stringify({ Account: { a: 1 }, RefreshToken: { r1: 'old', r2: 'theirs' }, AccessToken: { x: 1 } });
  const ours = JSON.stringify({ Account: { a: 1 }, RefreshToken: { r1: 'new' }, AccessToken: { y: 2 } });
  assert.deepEqual(JSON.parse(mergeCaches(disk, ours)),
    { Account: { a: 1 }, RefreshToken: { r1: 'new', r2: 'theirs' }, AccessToken: { x: 1, y: 2 } });
  assert.equal(mergeCaches('torn{', ours), ours);
});

test('20 concurrent writers: every reader sees whole JSON, no entry is lost, mode 0600, no temp files left', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cache-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'token-cache.json');
  writeFileSync(f, JSON.stringify({ RefreshToken: { base: 'x' } }), { mode: 0o600 });
  const W = `import { writeCache } from ${JSON.stringify(path.join(KIT, 'cache-write.mjs'))};
const i = process.argv[1]; writeCache(${JSON.stringify(f)}, JSON.stringify({ RefreshToken: { ['w' + i]: 'v'.repeat(20000) } }));`;
  let torn = 0, reading = true;
  const reader = (async () => {
    while (reading) {
      try { JSON.parse(readFileSync(f, 'utf8')); } catch { torn++; }
      await new Promise((r) => setImmediate(r));
    }
  })();
  await Promise.all(Array.from({ length: 20 }, (_, i) => new Promise((res, rej) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', W, String(i)], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`writer ${i} exit ${c}`))));
  })));
  reading = false; await reader;
  assert.equal(torn, 0);
  const rt = JSON.parse(readFileSync(f, 'utf8')).RefreshToken;
  assert.equal(Object.keys(rt).length, 21);   // base + w0..w19
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir).filter((x) => x.includes('tmp')), []);
});

test('writeCache works without a prior file', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cache-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'c.json');
  writeCache(f, '{"Account":{}}');
  assert.equal(readFileSync(f, 'utf8'), '{"Account":{}}');
});
