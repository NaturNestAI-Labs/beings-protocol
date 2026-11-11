// Route choice and the browser route's pure helpers (unit-tested). "graph" uses the owner's API session; "browser"
// uses the owner's browser profile, for tenants where an admin has not consented to the shared-mailbox or channel scopes.
import { OUTLOOK_API } from './guards.mjs';

export const ROUTES = ['graph', 'browser'];
const SECTION = { shared_mailbox_drafts: 'shared_mailbox', shared_mailbox_send: 'shared_mailbox', channel_posts: 'channel_posts' };

// [routes] <ability> overrides the section's `route`; default "graph". Anything else is a config error.
export function routeFor(cfg, ability) {
  if (!(ability in SECTION)) throw new Error(`${ability} has no browser route`);
  const r = cfg?.routes?.[ability] ?? cfg?.[SECTION[ability]]?.route ?? 'graph';
  if (!ROUTES.includes(r)) throw new Error(`route for ${ability} must be "graph" or "browser", not "${r}"`);
  return r;
}

const OPS = new Set(['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'and', 'or', 'not', 'asc', 'desc', 'true', 'false', 'null']);
const pascal = (w) => w[0].toUpperCase() + w.slice(1);
// A Graph-style path ("/users/x/mailFolders/drafts/messages?$select=subject") as an Outlook REST URL: same paths,
// PascalCase property names in $select, $orderby and $filter.
export function toOutlook(pathOrUrl) {
  if (pathOrUrl.startsWith('https://')) return pathOrUrl;
  const [p, q = ''] = pathOrUrl.split('?');
  if (!q) return `${OUTLOOK_API}${p}`;
  const fix = (v) => v.replace(/'[^']*'|\b[a-z][A-Za-z]*(\/[a-z][A-Za-z]*)*\b/g, (w) => (w.startsWith("'") || OPS.has(w) ? w : w.split('/').map(pascal).join('/')));
  const qs = [...new URLSearchParams(q)].map(([k, v]) => `${k}=${encodeURIComponent(['$select', '$orderby', '$filter'].includes(k) ? fix(v) : v)}`);
  return `${OUTLOOK_API}${p}?${qs.join('&').replace(/%2C/gi, ',')}`;
}

const ODATA_TYPES = [['#microsoft.graph.fileAttachment', '#Microsoft.OutlookServices.FileAttachment']];
const mapKeys = (v, f) => (Array.isArray(v) ? v.map((x) => mapKeys(x, f))
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k.startsWith('@') ? k : f(k), mapKeys(x, f)])) : v);
// Outlook REST answers in PascalCase; the tools work in Graph's camelCase.
export const camelize = (v) => mapKeys(v, (k) => k[0].toLowerCase() + k.slice(1));
export function pascalize(v) {
  const out = mapKeys(v, pascal);
  const fix = (x) => {
    if (Array.isArray(x)) x.forEach(fix);
    else if (x && typeof x === 'object') {
      for (const [g, o] of ODATA_TYPES) if (x['@odata.type'] === g) x['@odata.type'] = o;
      Object.values(x).forEach(fix);
    }
  };
  fix(out);
  return out;
}

// Outlook web keeps its MSAL tokens in localStorage. Picks the newest unexpired token for outlook.office.com that
// carries `scope`; null when there is none (signed out, or the web app never asked for that scope).
export function pickOutlookToken(entries, scope = 'Mail.ReadWrite.Shared', now = Date.now()) {
  let best = null;
  for (const [k, raw] of entries) {
    if (!/accesstoken/i.test(k)) continue;
    let v; try { v = JSON.parse(raw); } catch { continue; }
    const target = String(v.target || '');
    if (!/outlook\.office(365)?\.com/i.test(target) || !target.toLowerCase().split(/\s+/).some((t) => t.endsWith(`/${scope.toLowerCase()}`))) continue;
    const exp = Number(v.expiresOn || v.expires_on || 0) * 1000;
    if (!v.secret || (exp && exp < now + 60e3)) continue;
    if (!best || exp > best.exp) best = { secret: v.secret, exp };
  }
  return best ? best.secret : null;
}

// Wraps a guarded fetch for Outlook REST so callers keep Graph paths, bodies and field names.
export function outlookCall(guarded) {
  return async (url, opts = {}) => {
    const body = opts.body === undefined || Buffer.isBuffer(opts.body) ? opts.body : pascalize(opts.body);
    const r = await guarded(toOutlook(url), { ...opts, body });
    return r && typeof r === 'object' && !opts.raw ? camelize(r) : r;
  };
}

// Teams web link that opens one channel by id.
export const channelLink = (team, channel, name = 'channel') =>
  `https://teams.microsoft.com/l/channel/${encodeURIComponent(channel)}/${encodeURIComponent(name)}?groupId=${encodeURIComponent(team)}`;

// Post text for the Teams web composer: the body as plain text, then one line per uploaded file.
export function postText(post, links) {
  const body = post.body_text || String(post.body_html || '').replace(/<br\s*\/?>|<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
  return links.length ? `${body}\n\nFiles:\n${links.map((l) => `${l.name}: ${l.url}`).join('\n')}` : body;
}
