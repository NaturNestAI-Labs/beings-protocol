#!/usr/bin/env node
// graph-subscribe.mjs ensure|renew|status|delete: one delegated subscription on the Being's chats, 71 h, lifecycle URL.
// Identity from the kit .env; HOOK_PUBLIC/HOOK_STATE from env. Writes HOOK_STATE/health = ok|down (README.md).
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { kitEnv } from '../kit-env.mjs';

export const LIFETIME_MIN = 4320 - 60;        // chatMessage subscriptions last at most 3 days; keep an hour of margin
export const RENEW_BELOW_MS = 36 * 3600e3;     // renew once less than 36 h is left

// Pure: what to do with the current subscription.
export function plan(cmd, cur, now = Date.now()) {
  if (cmd === 'delete' || cmd === 'status') return cmd;
  if (!cur || cur.status !== 200) return 'create';
  if (cmd === 'renew' || Date.parse(cur.json.expirationDateTime) - now < RENEW_BELOW_MS) return 'renew';
  return 'keep';
}

async function main() {
  const disk = kitEnv();
  for (const k of ['BEING_UPN', 'BEING_CACHE', 'M365_CLIENT_ID', 'M365_TENANT_ID']) if (!process.env[k] && disk[k]) process.env[k] = disk[k];
  const { connect, need, beingSender } = await import('../graph.mjs');
  const cmd = process.argv[2] || 'ensure';
  if (!['ensure', 'renew', 'status', 'delete'].includes(cmd)) { console.error('usage: graph-subscribe.mjs ensure|renew|status|delete'); process.exit(2); }
  const STATE = process.env.HOOK_STATE || path.join(process.env.HOME, '.local/state/graph-webhook');
  const SUB = path.join(STATE, 'subscription.json'), HEALTH = path.join(STATE, 'health');
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
  let healthy = false;
  const health = (s, why = '') => { writeFileSync(HEALTH, `${s} ${new Date().toISOString()} ${why}\n`, { mode: 0o600 }); console.log(`health ${s} ${why}`); };
  // Any exit before the subscription is confirmed (graph.mjs fails with process.exit) marks the hook down.
  process.on('exit', (code) => { if (!healthy && code !== 0 && cmd !== 'status') health('down', `exit ${code}`); });

  const PUBLIC = need('HOOK_PUBLIC').replace(/\/$/, '');
  if (!/^https:\/\//.test(PUBLIC)) { console.error('HOOK_PUBLIC must be an https:// URL'); process.exit(2); }
  const id = beingSender();   // subscriptions are always the Being's own, never the owner's
  const { g, me } = await connect({ ...id, scopes: ['Chat.ReadWrite', 'User.Read'] });
  const call = async (method, url, body) => {
    try { return { status: method === 'POST' ? 201 : 200, json: await g(url, { method, body }) }; } catch (e) {
      return { status: parseInt(e.message, 10) || 0, json: {}, error: e.message.slice(0, 300) };
    }
  };
  const saved = existsSync(SUB) ? JSON.parse(readFileSync(SUB, 'utf8')) : null;
  const expiry = () => new Date(Date.now() + LIFETIME_MIN * 60e3).toISOString();

  let cur = saved ? await call('GET', `/subscriptions/${encodeURIComponent(saved.id)}`) : null;
  const step = plan(cmd, cur);
  if (step === 'status') { console.log(JSON.stringify({ status: cur?.status ?? 404, id: cur?.json?.id, expires: cur?.json?.expirationDateTime })); return; }
  if (step === 'delete') {
    if (saved) console.log('delete', (await call('DELETE', `/subscriptions/${encodeURIComponent(saved.id)}`)).status || 'done');
    if (existsSync(SUB)) unlinkSync(SUB);
    healthy = true; health('down', 'deleted');
    return;
  }
  if (step === 'renew') {
    const r = await call('PATCH', `/subscriptions/${encodeURIComponent(saved.id)}`, { expirationDateTime: expiry() });
    console.log('renew', r.status, r.json.expirationDateTime || r.error || '');
    cur = r.status === 200 ? r : null;
  }
  if (!cur || cur.status !== 200) {
    const clientState = readFileSync(path.join(STATE, 'client-state'), 'utf8').trim();
    const r = await call('POST', '/subscriptions', {
      changeType: 'created',
      resource: `/users/${me.id}/chats/getAllMessages`,
      notificationUrl: `${PUBLIC}/graph/notify`,
      lifecycleNotificationUrl: `${PUBLIC}/graph/lifecycle`,
      expirationDateTime: expiry(),
      clientState,
    });
    if (r.status !== 201) { health('down', `create failed: ${r.error || r.status}`); process.exit(1); }
    cur = r;
    console.log('created', r.json.id);
  }
  writeFileSync(SUB, JSON.stringify({ id: cur.json.id, expires: cur.json.expirationDateTime }) + '\n', { mode: 0o600 });
  healthy = true; health('ok', `expires ${cur.json.expirationDateTime}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) await main();
