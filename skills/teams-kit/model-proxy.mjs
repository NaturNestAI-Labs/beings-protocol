#!/usr/bin/env node
// model-proxy: lets a sandboxed teammate run use the model without holding the kit user's login (isolation/README.md).
// env PROXY_KEY = this run's key; PROXY_SOCKET = a unix socket to listen on (else 127.0.0.1). Prints "ready <port|unix>".
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const KEY = process.env.PROXY_KEY || '';
const CRED = process.env.BEING_PROXY_CRED || path.join(os.homedir(), '.claude', '.credentials.json');
const UPSTREAM = new URL(process.env.BEING_PROXY_UPSTREAM || 'https://api.anthropic.com');
if (KEY.length < 32) { console.error('model-proxy: PROXY_KEY missing or short'); process.exit(2); }
delete process.env.PROXY_KEY;

const readCred = () => { try { return JSON.parse(fs.readFileSync(CRED, 'utf8')).claudeAiOauth || {}; } catch { return {}; } };
function accessToken() {
  let o = readCred();
  if (!o.accessToken || (o.expiresAt || 0) - Date.now() < 5 * 60e3) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'model-proxy-'));
    spawnSync(process.env.BEING_PROXY_CLAUDE || 'claude', ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', 'ok'],
      { cwd: d, stdio: 'ignore', timeout: 120e3 });
    fs.rmSync(d, { recursive: true, force: true });
    o = readCred();
  }
  return o.accessToken || '';
}
const keyOk = (h) => {
  const got = Buffer.from(String(h['x-api-key'] || String(h.authorization || '').replace(/^Bearer\s+/i, '')));
  const want = Buffer.from(KEY);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

const srv = http.createServer((req, res) => {
  if (!keyOk(req.headers)) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"model-proxy: bad key"}'); return; }
  const tok = accessToken();
  if (!tok) { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"error":"model-proxy: no kit login"}'); return; }
  const h = { ...req.headers };
  for (const k of ['host', 'authorization', 'x-api-key', 'connection', 'proxy-authorization']) delete h[k];
  h.authorization = `Bearer ${tok}`;
  const beta = String(h['anthropic-beta'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!beta.includes('oauth-2025-04-20')) beta.push('oauth-2025-04-20');
  h['anthropic-beta'] = beta.join(',');
  const up = (UPSTREAM.protocol === 'http:' ? http : https).request({ hostname: UPSTREAM.hostname, port: UPSTREAM.port || (UPSTREAM.protocol === 'http:' ? 80 : 443), method: req.method, path: req.url, headers: h }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers); r.pipe(res);
  });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(502); res.end(`model-proxy: upstream ${e.code || e.message}`); });
  req.pipe(up);
});
const SOCK = process.env.PROXY_SOCKET || '';
if (SOCK) {
  try { fs.unlinkSync(SOCK); } catch { /* not there */ }
  process.umask(0o177);   // 0600: only the kit user (bwrap runs as the kit user) can connect
  srv.listen(SOCK, () => { process.stdout.write('ready unix\n'); });
  process.on('exit', () => { try { fs.unlinkSync(SOCK); } catch { /* gone */ } });
} else srv.listen(0, '127.0.0.1', () => { process.stdout.write(`ready ${srv.address().port}\n`); });
process.on('SIGTERM', () => process.exit(0));
