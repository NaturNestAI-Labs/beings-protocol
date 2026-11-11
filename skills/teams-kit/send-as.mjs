// Sending as another person who granted it (not the owner): off unless BEING_ALLOW_SEND_AS=1 in the kit .env on disk.
// Each account has its own named cache under state/send-as/, and every send needs an owner-approved draft (approve.mjs).
import { existsSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { kitEnv, ownerMatch } from './kit-env.mjs';
import { fingerprint } from './approval.mjs';

export const APPROVAL_TTL_MS = 10 * 60e3;
const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };
export const sendAsCache = (upn, env = kitEnv()) =>
  path.join(env.BEING_STATE_DIR || '', 'send-as', `${String(upn).toLowerCase().replace(/[^a-z0-9._@-]/g, '_')}.json`);

// The named cache for upn, or an error string. Settings come from the on-disk .env only, never from process env.
export function sendAsAccount(upn, env = kitEnv()) {
  const want = String(upn || '').trim().toLowerCase();
  if (env.BEING_ALLOW_SEND_AS !== '1') return 'sending as another account is off (BEING_ALLOW_SEND_AS=1 in .env)';
  if (!want || !env.BEING_STATE_DIR) return 'no account or no BEING_STATE_DIR';
  if (ownerMatch({ upn: want }, env)) return 'the owner is sent as only through approve.mjs';
  if (want === String(env.BEING_UPN || '').toLowerCase()) return 'that is the Being itself';
  const listed = String(env.BEING_SEND_AS_UPNS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!listed.includes(want)) return `${want} is not in BEING_SEND_AS_UPNS`;
  if (existsSync(path.join(env.BEING_STATE_DIR, 'send-as.stop'))) return 'paused (state/send-as.stop)';
  const cache = sendAsCache(want, env);
  if (!existsSync(cache)) return `no sign-in for ${want} (teams-login-device.mjs --upn ${want} --cache ${cache})`;
  if (statSync(cache).mode & 0o077) return `${cache} must be mode 600`;
  if ([env.BEING_CACHE, env.OWNER_CACHE].filter(Boolean).map(real).includes(real(cache))) return 'the send-as cache must be its own file';
  return { upn: want, cache };
}

// An approved send-as draft, checked again just before it is sent. Returns an error string, or null.
export function checkSendAsDraft(d, upn, now = Date.now()) {
  if (!d || d.kind !== 'teams') return 'not a Teams draft';
  if (String(d.as || '').toLowerCase() !== String(upn).toLowerCase()) return 'draft is not for this account';
  if (d.status !== 'approved-as') return `draft is ${d.status || 'not approved'}`;
  const at = Date.parse(d.approvedAt || '');
  if (!(at <= now) || now - at > APPROVAL_TTL_MS) return 'approval is missing or older than 10 minutes';
  if (fingerprint(d) !== d.fingerprint) return 'draft changed after the owner approved it';
  if (!d.chatId || !String(d.text || '').trim()) return 'draft has no chat or text';
  return null;
}
