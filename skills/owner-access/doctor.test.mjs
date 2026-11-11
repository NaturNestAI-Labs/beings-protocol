// owner-access doctor: a browser ability fails the check before first use when its prerequisites are missing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), TK = path.join(HERE, '..', 'teams-kit');
const host = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BEING_|OWNER_|M365_|HOOK_)/.test(k)));

function doctor(t, web) {
  const k = mkdtempSync(path.join(tmpdir(), 'oadoc-')); t.after(() => rmSync(k, { recursive: true, force: true }));
  for (const d of [TK, HERE]) for (const f of readdirSync(d)) if (f.endsWith('.mjs') && !f.endsWith('.test.mjs')) copyFileSync(path.join(d, f), path.join(k, f));
  symlinkSync(path.join(TK, 'node_modules'), path.join(k, 'node_modules'));
  writeFileSync(path.join(k, '.env'), `BEING_NAME=nova\nBEING_UPN=nova@example.test\nOWNER_UPN=sam@example.test\nBEING_STATE_DIR=${k}/state\n`, { mode: 0o600 });
  writeFileSync(path.join(k, 'owner-access.toml'), `[owner_access]\nenabled = true\n\n[abilities]\nowner_files = true\n\n[owner_web]\n${web}\n`, { mode: 0o600 });
  return spawnSync('node', [path.join(k, 'owner-access-doctor.mjs')], { env: { ...host, HOME: k }, encoding: 'utf8' });
}

test('placeholder [owner_web] hosts fail the doctor while a browser ability is on', (t) => {
  const r = doctor(t, 'my_host = "https://<org>-my.sharepoint.com"\nroot_host = "https://<org>.sharepoint.com"');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /FAIL \[owner_web\] my_host, root_host not set/);
});

test('real hosts pass that check; playwright-core is reported either way', (t) => {
  const r = doctor(t, 'my_host = "https://org-my.sharepoint.com"\nroot_host = "https://org.sharepoint.com"');
  assert.match(r.stdout, /ok\s+\[owner_web\] hosts set/);
  assert.match(r.stdout, /playwright-core (installed|missing)/);
});
