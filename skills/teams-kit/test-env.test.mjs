// Guard: no test hands the raw host environment to a kit tool (it would carry a live Being's state path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostEnv } from './test-env.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));
const RAW = new RegExp('\\.\\.\\.process\\.env\\b');

test('no test spreads the raw host environment: each uses hostEnv()', () => {
  const files = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' ? []
    : e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.test.mjs') ? [path.join(d, e.name)] : []));
  const bad = files(KIT).filter((f) => RAW.test(readFileSync(f, 'utf8'))).map((f) => path.relative(KIT, f));
  assert.deepEqual(bad, []);
});

test('hostEnv() drops a live Being\'s settings and keeps the rest', (t) => {
  const d = mkdtempSync(path.join(tmpdir(), 'tenv-')); t.after(() => rmSync(d, { recursive: true, force: true }));
  const live = { BEING_STATE_DIR: '/live/state', OWNER_DM_CHAT: '19:live', M365_X: '1', HOOK_Y: '1', KEEP_ME: 'yes' };
  const saved = {}; for (const k of Object.keys(live)) { saved[k] = process.env[k]; process.env[k] = live[k]; }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  const e = hostEnv();
  for (const k of ['BEING_STATE_DIR', 'OWNER_DM_CHAT', 'M365_X', 'HOOK_Y']) assert.equal(e[k], undefined, k);
  assert.equal(e.KEEP_ME, 'yes'); assert.equal(e.PATH, process.env.PATH);
  const r = spawnSync('sh', ['-c', 'echo "${BEING_STATE_DIR:-unset}"'], { env: { ...hostEnv(), HOME: d }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), 'unset');
});
