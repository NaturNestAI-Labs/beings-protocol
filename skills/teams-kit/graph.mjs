// Shared Microsoft Graph access: one MSAL cache per identity, sender pinned by UPN and checked against /me.
import { PublicClientApplication } from '@azure/msal-node';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ownerMatch } from './kit-env.mjs';
import { writeCache } from './cache-write.mjs';
// A Graph read that hangs (seen: 5 min header waits) would stall the watcher loop; writes are never cut short.
export const GRAPH_TIMEOUT_MS = Number(process.env.BEING_GRAPH_TIMEOUT_MS) || 20000;

export const need = (k) => {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}; see .env.example`); process.exit(1); }
  return v;
};
export const fail = (msg, code = 1) => { console.error(msg); process.exit(code); };
export const stateDir = () => need('BEING_STATE_DIR');
// A standby host (a copy waiting for cutover) may read but never send.
export const standby = () => existsSync(path.join(stateDir(), 'STANDBY'));

export { strip } from './strip.mjs';

// Every sender except approve.mjs posts only as the Being: refuse the owner's UPN, cache file or object id (exit 3).
export function refuseOwner(id) {
  const why = ownerMatch(id);
  if (why) fail(`blocked: sender resolves to the owner (${why}); only approve.mjs sends as the owner, nothing sent`, 3);
}
export function beingSender() {
  const id = { upn: need('BEING_UPN'), cache: need('BEING_CACHE') };
  refuseOwner(id);
  return id;
}

export function msal(cache) {
  return new PublicClientApplication({
    auth: { clientId: need('M365_CLIENT_ID'), authority: `https://login.microsoftonline.com/${need('M365_TENANT_ID')}` },
    cache: { cachePlugin: {
      beforeCacheAccess: async (c) => { if (existsSync(cache)) c.tokenCache.deserialize(readFileSync(cache, 'utf8')); },
      // Entra rotates refresh tokens on silent refresh: without write-back the next run fails.
      // Atomic and merged under flock: other processes share this file (cache-write.mjs, review #12).
      afterCacheAccess: async (c) => { if (c.cacheHasChanged) writeCache(cache, c.tokenCache.serialize()); },
    } },
  });
}

// Graph client for exactly `upn` (never "first account in cache"), verified with /me before returning.
export async function connect({ upn, scopes, cache = need('BEING_CACHE'), sender = false }) {
  const want = upn.toLowerCase();
  if (sender) refuseOwner({ upn, cache });
  const app = msal(cache);
  const accounts = await app.getTokenCache().getAllAccounts();
  const account = accounts.find((a) => (a.username || '').toLowerCase() === want);
  if (!account) fail(`${want} not in token cache; run teams-login-device.mjs first`);
  const tokenFor = async (s) => (await app.acquireTokenSilent({ account, scopes: s })).accessToken;
  let token;
  try { token = await tokenFor(scopes); } catch (e) { fail(`silent auth failed for ${want}: ${e.message}`); }
  const g = async (url, { method, body, headers } = {}) => {
    const r = await fetch(url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Reads only: a timed-out write may still have happened, so it is never cut short (and never retried here).
      ...(body === undefined && (!method || method === 'GET') ? { signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS) } : {}),
    });
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 80)}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : {};
  };
  const me = await g('/me').catch((e) => fail(`/me failed: ${e.message}`));
  if ((me.userPrincipalName || '').toLowerCase() !== want) fail(`token resolves to ${me.userPrincipalName}, not ${want}; aborting`);
  if (sender) refuseOwner({ oid: me.id });
  return { g, me, token, tokenFor };
}
