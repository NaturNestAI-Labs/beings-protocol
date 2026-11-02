#!/usr/bin/env node
// Open an attachment from a detected message (attachments[].url): inline images and OneDrive/SharePoint file cards.
// Usage and exit codes: README.md "Script reference". The token is only ever sent to Microsoft Graph.
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connect, need, fail } from './graph.mjs';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--out');
// One folder per chat lane, so a teammate lane can open only its own chat's files (team-fence checks the same name).
const laneDir = (lane = '') => (lane.startsWith('team:') ? `team-${createHash('sha1').update(lane.slice(5)).digest('hex').slice(0, 10)}` : 'owner');
const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(need('BEING_STATE_DIR'), 'attachments', laneDir(process.env.BEING_LANE));
const MAX = 25 * 1024 * 1024;
if (!url) fail('usage: teams-fetch-attachment.mjs <attachment url> [--out <dir>]', 2);

let u;
try { u = new URL(url); } catch { fail(`not a URL: ${url.slice(0, 80)}`, 2); }
const graphImage = u.hostname === 'graph.microsoft.com' && /\/hostedContents\/[^/]+\/\$value$/.test(u.pathname);
const fileCard = u.protocol === 'https:' && /(^|\.)sharepoint\.com$|(^|\.)onedrive\.live\.com$|^1drv\.ms$/.test(u.hostname);
if (!graphImage && !fileCard) fail(`refused: ${u.hostname} is not a Teams image or a OneDrive/SharePoint file`, 2);

const { tokenFor } = await connect({ upn: need('BEING_UPN'), scopes: ['Chat.Read', 'User.Read'] });
const notShared = () => {
  console.error(`NOT_SHARED: ${need('BEING_UPN')} cannot open this file. Ask the sender to share it with you, then retry.`);
  process.exit(3);
};
async function get(target, scopes) {
  let token;
  try { token = await tokenFor(scopes); } catch (e) { fail(`no ${scopes[0]} consent for this app: ${e.message}`); }
  const r = await fetch(target, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 403 || r.status === 404) notShared();
  if (!r.ok) fail(`${r.status} fetching the attachment`);
  if (Number(r.headers.get('content-length') || 0) > MAX) fail('attachment over 25 MB; ask for a smaller copy');
  return r;
}
const safe = (n) => (n || 'attachment').replace(/[^\w.-]+/g, '_').slice(0, 120);

let res, name;
if (graphImage) {
  res = await get(u.href, ['Chat.Read']);
  const ext = (res.headers.get('content-type') || '').split('/')[1]?.split(';')[0] || 'bin';
  name = `image-${Date.now()}.${safe(ext)}`;
} else {
  // Shared-link form of the URL (Graph "shares" API): resolves anything the Being can open, refuses the rest.
  const share = 'u!' + Buffer.from(u.href).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const meta = await (await get(`https://graph.microsoft.com/v1.0/shares/${share}/driveItem?$select=name,size,file`, ['Files.Read.All'])).json();
  if (!meta.file) fail('that link is a folder, not a file', 2);
  if ((meta.size || 0) > MAX) fail('attachment over 25 MB; ask for a smaller copy');
  res = await get(`https://graph.microsoft.com/v1.0/shares/${share}/driveItem/content`, ['Files.Read.All']);
  name = safe(meta.name);
}
const buf = Buffer.from(await res.arrayBuffer());
if (buf.length > MAX) fail('attachment over 25 MB; ask for a smaller copy');
mkdirSync(out, { recursive: true, mode: 0o700 });
const file = path.join(out, `${Date.now()}-${name}`);
writeFileSync(file, buf, { mode: 0o600 });
console.log(JSON.stringify({ file, bytes: buf.length, type: res.headers.get('content-type') || '' }));
