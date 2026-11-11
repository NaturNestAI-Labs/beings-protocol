#!/usr/bin/env node
// Token cache write-back for every signing-in process: a 0600 temp file, merged under flock, renamed into place.
// writeCache(file, data) is the API; `node cache-write.mjs <cache> <temp>` is the step that runs under flock.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);

// MSAL's cache: top-level sections (Account, IdToken, AccessToken, RefreshToken, AppMetadata) of key → entry.
export function mergeCaches(diskText, oursText) {
  let disk, ours;
  try { ours = JSON.parse(oursText); } catch { return oursText; }   // not JSON: write ours as is
  try { disk = JSON.parse(diskText); } catch { return oursText; }
  const out = { ...disk };
  for (const [k, v] of Object.entries(ours)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && disk[k] && typeof disk[k] === 'object' ? { ...disk[k], ...v } : v;
  }
  return JSON.stringify(out);
}

function mergeInto(file, tmp) {   // runs while <file>.lock is held
  const ours = readFileSync(tmp, 'utf8');
  const merged = existsSync(file) ? mergeCaches(readFileSync(file, 'utf8'), ours) : ours;
  const t2 = `${file}.tmp.${process.pid}.m`;
  writeFileSync(t2, merged, { mode: 0o600 }); renameSync(t2, file); rmSync(tmp, { force: true });
}

export function writeCache(file, data) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, data, { mode: 0o600 });
  const r = spawnSync('flock', ['-w', '15', `${file}.lock`, process.execPath, SELF, file, tmp], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000, env: { ...process.env, NODE_TEST_CONTEXT: '' } });
  if (r.status !== 0 && process.env.CACHE_WRITE_DEBUG) console.error('cache-write:', r.status, r.error, String(r.stderr).slice(0, 300));
  if (r.error || r.status !== 0) {
    // No flock or lock timeout: still atomic (rename), just not merged.
    if (existsSync(tmp)) renameSync(tmp, file);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  const [file, tmp] = process.argv.slice(2);
  if (!file || !tmp) { console.error('usage: cache-write.mjs <cache> <temp> (run under flock <cache>.lock)'); process.exit(2); }
  mergeInto(file, tmp);
}
