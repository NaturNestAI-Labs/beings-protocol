// being-deadman: alerts once on a problem (Teams + the pluggable external channel), not again while it lasts, once more
// when it clears; an undelivered alert is retried. Throwaway state, fake sender and fake external command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostEnv } from './test-env.mjs';

const KIT = path.dirname(fileURLToPath(import.meta.url));

function box(t, { teamsWorks = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deadman-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const k = path.join(dir, 'kit'), st = path.join(dir, 'state'), hook = path.join(dir, 'hook');
  for (const d of [k, st, hook]) mkdirSync(d);
  for (const f of ['being-deadman', 'being-retry']) copyFileSync(path.join(KIT, f), path.join(k, f));
  writeFileSync(path.join(k, '.env'), `BEING_STATE_DIR=${st}\nBEING_NAME=Test\n`);
  const log = path.join(dir, 'sent.log');
  writeFileSync(path.join(k, 'teams-send-dm.mjs'), `import { readFileSync, appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, 'teams ' + readFileSync(0, 'utf8') + '\\n'); process.exit(${teamsWorks ? 0 : 1});`);
  const ext = path.join(dir, 'ext.sh');
  writeFileSync(ext, `#!/bin/sh\necho "ext $(cat)" >> ${log}\n`); chmodSync(ext, 0o755);
  writeFileSync(path.join(st, 'watermark'), 'x'); writeFileSync(path.join(st, 'loop.log'), 'x'); writeFileSync(path.join(hook, 'health'), 'ok now\n');
  const env = { ...Object.fromEntries(Object.entries(hostEnv()).filter(([x]) => !/^(NTFY|TELEGRAM)/.test(x))),
    BEING_STATE_DIR: st, HOOK_STATE: hook, BEING_DEADMAN_SKIP_UNIT: '1', BEING_ALERT_ENV: path.join(dir, 'none.env'),
    BEING_ALERT_CHANNEL: 'command', BEING_ALERT_COMMAND: ext };
  const run = (...a) => spawnSync('python3', [path.join(k, 'being-deadman'), ...a], { env, encoding: 'utf8' });
  const sent = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
  const stale = () => utimesSync(path.join(st, 'watermark'), new Date(0), new Date(0));
  const fresh = () => writeFileSync(path.join(st, 'watermark'), 'y');
  return { st, run, sent, stale, fresh };
}

test('healthy: nothing sent, state written', (t) => {
  const { st, run, sent } = box(t);
  assert.equal(run().status, 0);
  assert.equal(sent().length, 0);
  assert.equal(JSON.parse(readFileSync(path.join(st, 'deadman.json'), 'utf8')).ok, true);
});

test('a stale watermark alerts once on both channels, not again while it lasts, then says it cleared', (t) => {
  const { st, run, sent, stale, fresh } = box(t);
  stale(); run();
  assert.equal(sent().length, 2);
  assert.ok(sent().some((l) => l.startsWith('ext 🚨') && /no successful Teams sweep/.test(l)));
  assert.ok(sent().some((l) => l.startsWith('teams')));
  run(); assert.equal(sent().length, 2);            // same problem: quiet until the reminder interval
  fresh(); run();
  assert.equal(sent().length, 4); assert.ok(sent().some((l) => l.startsWith('ext ✅')));
  assert.equal(JSON.parse(readFileSync(path.join(st, 'deadman.json'), 'utf8')).ok, true);
});

test('failed items waiting and a down webhook are reported; dry-run sends nothing', (t) => {
  const { st, run, sent } = box(t);
  writeFileSync(path.join(st, 'failed.jsonl'), JSON.stringify({ messageId: 'm1' }) + '\n');
  writeFileSync(path.join(path.dirname(st), 'hook', 'health'), 'down 2026-10-12 token: invalid_grant\n');
  const r = run('--dry-run');
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.deepEqual(j.keys, ['failed', 'webhook']);
  assert.equal(sent().length, 0);
});
