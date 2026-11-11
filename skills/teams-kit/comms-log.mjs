// Append-only JSONL log of every message, under flock, plus one 0600 file per conversation (state/conversations/).
// node comms-log.mjs --append (one JSON entry on stdin) | --backfill (split comms.jsonl into conversation files, once)
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOG = process.env.BEING_COMMS_LOG || path.join(process.env.BEING_STATE_DIR || '.', 'comms.jsonl');
export const CONV_DIR = path.join(path.dirname(LOG), 'conversations');

// File-safe name; being-handle's RECENT CHAT uses the same rule (keep in step: conv_file in being-handle).
export const safeName = (s) => String(s).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 150);
export function conversationOf(e) {
  if (e.channel === 'hive') return 'hive-' + safeName(e.mind || e.from || 'unknown');
  if (e.chatId) return safeName(e.chatId);
  if (e.channel === 'mail') return 'mail';
  return null;   // e.g. a draft decision with no chat: global log only
}

function append(line, conv) {
  const cf = conv ? path.join(CONV_DIR, conv + '.jsonl') : '';
  const r = spawnSync('flock', [`${LOG}.lock`, 'sh', '-c',
    'umask 077; t=$(cat); printf "%s\\n" "$t" >>"$1"; [ -z "$2" ] || { mkdir -p "$3"; printf "%s\\n" "$t" >>"$2"; }', '_', LOG, cf, CONV_DIR],
  { input: line, stdio: ['pipe', 'ignore', 'ignore'], timeout: 10000 });
  if (r.error || r.status !== 0) {
    appendFileSync(LOG, line + '\n');
    if (cf) { mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 }); appendFileSync(cf, line + '\n', { mode: 0o600 }); }
  }
}

export function logComms(entry) {
  if (LOG === '/dev/null') return;
  mkdirSync(path.dirname(LOG), { recursive: true });
  const e = { loggedAt: new Date().toISOString(), ...entry };
  append(JSON.stringify(e), conversationOf(e));
}

export function backfill() {
  const mark = path.join(CONV_DIR, '.backfilled');
  if (LOG === '/dev/null' || existsSync(mark) || !existsSync(LOG)) return 0;
  mkdirSync(CONV_DIR, { recursive: true, mode: 0o700 });
  const by = new Map();
  for (const l of readFileSync(LOG, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    const c = conversationOf(e); if (!c) continue;
    if (!by.has(c)) by.set(c, []); by.get(c).push(l);
  }
  // Run it under the log's lock (flock <comms.jsonl>.lock node comms-log.mjs --backfill) so no live line lands in between.
  for (const [c, ls] of by) {
    const f = path.join(CONV_DIR, c + '.jsonl');
    const prior = existsSync(f) ? readFileSync(f, 'utf8') : '', have = new Set(prior.split('\n'));
    const older = ls.filter((l) => !have.has(l));   // lines already written live are not repeated
    writeFileSync(f, (older.length ? older.join('\n') + '\n' : '') + prior, { mode: 0o600 }); chmodSync(f, 0o600);
  }
  writeFileSync(mark, new Date().toISOString() + '\n', { mode: 0o600 });
  return by.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  if (cmd === '--append') logComms(JSON.parse(readFileSync(0, 'utf8')));
  else if (cmd === '--backfill') console.log(`backfilled ${backfill()} conversation file(s)`);
  else { console.error('usage: comms-log.mjs --append < entry.json | --backfill'); process.exit(2); }
}
