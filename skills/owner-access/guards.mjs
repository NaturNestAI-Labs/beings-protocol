// Request guards for the as-owner tools (pure, unit-tested). Every network call goes through one of these first.

// Microsoft 365 web hosts owner-web may open or fetch from.
const M365 = /(^|\.)(sharepoint\.com|office\.com|office365\.com|microsoft365\.com|cloud\.microsoft|teams\.microsoft\.com|outlook\.com)$/i;
export const isM365Host = (url) => {
  try { const u = new URL(url); return u.protocol === 'https:' && !u.username && !u.password && M365.test(u.hostname); } catch { return false; }
};
// Sign-in hosts the browser is redirected through; reaching one means the session is signed out.
export const isLoginUrl = (url) => /(^|\.)login\.(microsoftonline\.com|live\.com)$/i.test((() => { try { return new URL(url).hostname; } catch { return ''; } })());

export const OWNER_WEB_READ = new Set(['check', 'whoami', 'search', 'shared', 'ls', 'get', 'open']);

// Browser requests while a read command runs. Outlook web reads through POSTs, so POST stays open, but known write
// actions (send, mark read, move, delete, create) and every PUT/PATCH/DELETE/MERGE are aborted.
const MUTATE = /\/s(end|endmail)\b|SendItem|action=(UpdateItem|MarkAllItemsAsRead|MarkItemsAsRead|DeleteItem|MoveItem|CreateItem|SetReadFlag|SendItem)|\b(DeleteItem|MoveItem|CreateItem|UpdateItem|SetReadFlag)\b/i;
export function browserRequestAllowed(method, url, body = '') {
  const m = String(method).toUpperCase();
  if (['PUT', 'PATCH', 'DELETE', 'MERGE'].includes(m)) return false;
  if (m !== 'POST') return !MUTATE.test(url);
  return !MUTATE.test(url) && !MUTATE.test(String(body).slice(0, 20000));
}

export const GRAPH = 'https://graph.microsoft.com/v1.0';
// Outlook REST, used by the browser route with the owner's Outlook web token.
export const OUTLOOK_API = 'https://outlook.office.com/api/v2.0';
const lc = (s) => String(s).toLowerCase();
const parse = (url, base = GRAPH) => { const u = new URL(url); return { u, path: decodeURIComponent(u.pathname).slice(new URL(base).pathname.length).toLowerCase() }; };

// Read-only shared mailbox: GET of the listed folders' message lists (and their paging links) only.
export function inboxReadRoute(mailbox, url, method, folders = ['inbox', 'junkemail']) {
  if (method !== 'GET' || !url.startsWith(GRAPH)) return false;
  const { path } = parse(url), root = `/users/${lc(mailbox)}`;
  return folders.some((f) => path === `${root}/mailfolders/${lc(f)}/messages`);
}

// Shared-mailbox drafts: read the Drafts folder, create a draft, edit or attach to the Being's own draft ids, read Sent
// Items in send mode, and send only the ids of an approved batch. Anything else (delete, move, reply-all) is refused.
export function draftsRoute(mailbox, url, method, { own = new Set(), sendIds = new Set(), sentItems = false, base = GRAPH } = {}) {
  if (!url.startsWith(`${base}/`)) return false;
  const { u, path } = parse(url, base), root = `/users/${lc(mailbox)}`;
  const ids = (set) => new Set([...set].map(lc));
  const msg = (p) => { const m = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/messages/([^/]+)(/.*)?$`).exec(p); return m ? [m[1], m[2] || ''] : null; };
  const hit = msg(path);
  if (method === 'POST' && hit && hit[1] === '/send' && !u.search) return ids(sendIds).has(hit[0]);
  if (/\/(send|sendmail|reply|replyall|forward|move|copy)$/.test(path)) return false;
  if (method === 'GET') {
    if (path === `${root}/mailfolders/drafts` || path === `${root}/mailfolders/drafts/messages`) return true;
    if (base === OUTLOOK_API && path === '/me') return true;   // who-am-I for the browser route's token
    if (sentItems && path === `${root}/mailfolders/sentitems/messages`) return true;
    return !!hit && ids(own).has(hit[0]) && ['', '/attachments'].includes(hit[1]);
  }
  if (method === 'POST') return (path === `${root}/messages` && !u.search) || (!!hit && ids(own).has(hit[0]) && hit[1] === '/attachments');
  if (method === 'PATCH') return !!hit && ids(own).has(hit[0]) && hit[1] === '' && !u.search;
  return false;
}

// Channel posts: one allowed team/channel; read it, post top-level messages there, and write files in its folder only.
export function channelRoute({ team, channel, driveId, folderId }, url, method) {
  if (!url.startsWith(GRAPH)) return false;
  const { u, path } = parse(url), ch = `/teams/${lc(team)}/channels/${lc(channel)}`;
  if (method === 'GET') {
    if ([ch, `${ch}/filesfolder`, `${ch}/messages`].includes(path)) return true;
    return !!driveId && path.startsWith(`/drives/${lc(driveId)}/items/`);
  }
  if (method === 'POST' && path === `${ch}/messages` && !u.search) return true;
  if (!driveId || !folderId) return false;
  const inFolder = path.startsWith(`/drives/${lc(driveId)}/items/${lc(folderId)}:/`) && !/(^|\/)\.\.(\/|:|$)/.test(path);
  if (method === 'PUT') return inFolder && path.endsWith(':/content');
  if (method === 'POST') return inFolder && path.endsWith(':/createuploadsession');
  return false;
}

// Owner mail forwarding: read the inbox and Sent Items lists, read only mails a rule covers, forward only the chosen one.
export function forwardRoute(url, method, { readIds = new Set(), forwardId = null } = {}) {
  if (!url.startsWith(GRAPH)) return false;
  const { u, path } = parse(url);
  const m = /^\/me\/messages\/([^/]+)(\/forward)?$/.exec(path);
  if (method === 'GET') {
    if (['/me', '/me/mailfolders/inbox/messages', '/me/mailfolders/sentitems/messages'].includes(path)) return true;
    return !!m && !m[2] && new Set([...readIds].map(lc)).has(m[1]);
  }
  return method === 'POST' && !!m && m[2] === '/forward' && !u.search && !!forwardId && lc(forwardId) === m[1];
}

// Graph calls through a route guard; refused routes never reach the network.
export function guardedGraph(token, allow, fetcher = fetch, base = GRAPH) {
  return async (url, { method = 'GET', body, headers = {}, raw = false, allow404 = false } = {}) => {
    const full = url.startsWith('https://') ? url : `${base}${url}`;
    // A body with the default GET is a caller bug (a create sent as a read); fail loudly, never send it.
    if (body !== undefined && ['GET', 'HEAD'].includes(method)) throw new Error(`refused: ${method} with a body; pass the intended method`);
    if (!allow(full, method)) throw new Error(`refused: ${method} ${full.replace(base, '').split('?')[0]} is outside this tool's allowlist`);
    const isBuf = Buffer.isBuffer(body);
    const r = await fetcher(full, { method, redirect: 'error', headers: { Authorization: `Bearer ${token}`,
      ...(body !== undefined && { 'Content-Type': isBuf ? 'application/octet-stream' : 'application/json' }), ...headers },
    body: body === undefined ? undefined : isBuf ? body : JSON.stringify(body) });
    if (allow404 && r.status === 404) return null;
    if (raw) { if (!r.ok) throw new Error(`${r.status} ${method} ${full.slice(0, 90)}`); return r; }
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${method} ${full.replace(base, '').slice(0, 90)}: ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : {};
  };
}

// Browser route, SharePoint REST with the owner's cookies: only the allowed channel folder (and its subfolders). Upload
// without overwrite, create a subfolder, read files back; never delete, move, recycle or touch another site or folder.
const spLiteral = (s) => { const m = /\('((?:[^']|'')*)'\)/.exec(s); return m ? m[1].replace(/''/g, "'") : null; };
export function sharePointRoute({ site, folder }, url, method, body) {
  const base = `${String(site).replace(/\/+$/, '')}/_api/`;
  if (!isM365Host(site) || !url.startsWith(base)) return false;
  const route = decodeURIComponent(url.slice(base.length).split('?')[0]);
  const root = String(folder).replace(/\/+$/, '');
  const inside = (p) => p !== null && (p === root || p.startsWith(`${root}/`)) && !/(^|\/)\.{1,2}(\/|$)/.test(p);
  if (/\b(delete|recycle|moveto|copyto|checkout|checkin|undocheckout|listitemallfields)\b/i.test(route)) return false;
  if (method === 'GET') return route === 'web/currentuser'
    || (/^web\/getfilebyserverrelativeurl\(/i.test(route) && /^web\/getfilebyserverrelativeurl\('(?:[^']|'')*'\)(\/\$value)?$/i.test(route) && inside(spLiteral(route)))
    || (/^web\/getfolderbyserverrelativeurl\('(?:[^']|'')*'\)(\/(files|folders))?$/i.test(route) && inside(spLiteral(route)));
  if (method !== 'POST') return false;
  if (route === 'contextinfo') return true;
  if (route.toLowerCase() === 'web/folders') { try { return inside(JSON.parse(body || '{}').ServerRelativeUrl); } catch { return false; } }
  const add = /^web\/getfolderbyserverrelativeurl\('((?:[^']|'')*)'\)\/files\/add\(url='((?:[^']|'')*)',overwrite=false\)$/i.exec(route);
  return !!add && inside(add[1].replace(/''/g, "'")) && !/[\\/]/.test(add[2]) && !/^\.+$/.test(add[2]);
}

// Browser route, Teams web: the page may post only into the batch's own channel; no deletes; mail actions refused.
export function teamsWebAllowed(method, url, { channel }) {
  const m = String(method).toUpperCase();
  if (m === 'DELETE' || m === 'PATCH') return false;
  if (!browserRequestAllowed(m === 'PUT' ? 'GET' : m, url)) return false;
  let p = '';
  try { p = decodeURIComponent(new URL(url).pathname).toLowerCase(); } catch { return false; }
  const conv = /\/conversations\/([^/]+)\/messages(\/|$)/.exec(p);
  if (conv && ['POST', 'PUT'].includes(m)) return conv[1] === String(channel).toLowerCase() && !conv[2];
  return true;
}
