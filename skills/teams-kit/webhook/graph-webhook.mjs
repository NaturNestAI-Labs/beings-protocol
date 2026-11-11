#!/usr/bin/env node
// Graph change-notification receiver: answers validation, checks clientState, queues ids only, touches the kick file.
// Env: HOOK_STATE (dir with client-state; default ~/.local/state/graph-webhook), HOOK_PORT (8790). Listens on 127.0.0.1.
import http from 'node:http';
import { readFileSync, appendFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_BODY = 1 << 20;
const MAX_TOKEN = 2048;
const ROUTES = { '/graph/notify': 'notify', '/graph/lifecycle': 'lifecycle' };
const digest = (s) => createHash('sha256').update(String(s ?? '')).digest();

export const defaultState = () => process.env.HOOK_STATE || path.join(process.env.HOME, '.local/state/graph-webhook');

export function readSecret(state) {
  const s = readFileSync(path.join(state, 'client-state'), 'utf8').trim();
  if (s.length < 32) throw new Error('client-state must be at least 32 characters');
  return s;
}

// Equal-length digests: the comparison time does not depend on where or whether the strings differ.
export const clientStateOk = (got, secret) => typeof got === 'string' && timingSafeEqual(digest(got), digest(secret));

// One notification batch -> HTTP status. Only ids and resource paths are kept, never message content.
export function accept(kind, body, { state, secret, log = () => {} }) {
  let value;
  try { value = JSON.parse(body).value; } catch { return 400; }
  if (!Array.isArray(value)) return 400;
  let good = 0;
  for (const n of value) {
    if (!n || !clientStateOk(n.clientState, secret)) { log(kind, 'drop: bad clientState'); continue; }
    const at = new Date().toISOString();
    const ev = kind === 'lifecycle'
      ? { at, kind, event: String(n.lifecycleEvent || ''), subscriptionId: String(n.subscriptionId || '') }
      : { at, kind, changeType: String(n.changeType || ''), resource: String(n.resource || ''),
          id: String(n.resourceData?.id || ''), subscriptionId: String(n.subscriptionId || '') };
    appendFileSync(path.join(state, kind === 'lifecycle' ? 'lifecycle.jsonl' : 'queue.jsonl'), JSON.stringify(ev) + '\n', { mode: 0o600 });
    log(kind, ev.event || ev.changeType, ev.subscriptionId);
    good++;
  }
  if (good) writeFileSync(path.join(state, 'kick'), new Date().toISOString() + '\n', { mode: 0o600 });
  return 202;
}

export function createHookServer({ state = defaultState(), log = () => {} } = {}) {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const secret = readSecret(state);
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const kind = ROUTES[url.pathname];
    if (!kind || req.method !== 'POST') { res.writeHead(404).end(); req.resume(); return; }
    const token = url.searchParams.get('validationToken');   // URLSearchParams already decodes it
    if (token !== null) {
      if (token.length > MAX_TOKEN) { res.writeHead(400).end(); req.resume(); return; }
      log(kind, 'validation handshake');
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end(token);
      req.resume();
      return;
    }
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { if (!res.writableEnded) res.writeHead(413).end(); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      if (!res.writableEnded) res.writeHead(accept(kind, Buffer.concat(chunks).toString('utf8'), { state, secret, log })).end();
    });
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.HOOK_PORT || 8790);
  const log = (...a) => console.log(new Date().toISOString(), ...a);
  let server;
  try { server = createHookServer({ log }); } catch (e) { console.error(e.message); process.exit(1); }
  server.listen(port, '127.0.0.1', () => log(`listening 127.0.0.1:${port}`));
}
