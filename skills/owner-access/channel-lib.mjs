// Channel-post batches (pure, unit-tested): manifest checks, the batch fingerprint the approver types, plan operations
// and the message HTML. channel-posts.mjs does the I/O.
import { BATCH_RE, planOf, fingerprint } from './ledger.mjs';

const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// File and folder names safe for SharePoint: no path parts, no reserved characters or device names.
export function safeName(v) {
  const n = String(v).normalize('NFC').replace(/[<>:"/\\|?*#%\x00-\x1f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 140);
  if (!n || /^\.+$/.test(n) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(n)) throw new Error(`unsafe name: ${v}`);
  return n;
}

export const channelKey = (m) => `${m.team}/${m.channel}`.toLowerCase();

// Manifest: { batch, team, channel, folder?, created, posts: [{ title, body_html | body_text, files: [abs paths] }] }.
export function validateChannelManifest(m, allowed = []) {
  if (!m || typeof m !== 'object' || !BATCH_RE.test(m.batch || '')) throw new Error('manifest needs a batch name');
  if (!m.team || !m.channel) throw new Error('manifest needs team and channel ids');
  if (!allowed.map((x) => String(x).toLowerCase()).includes(channelKey(m))) throw new Error('channel is not in [channel_posts] allowed');
  if (!Date.parse(m.created || '')) throw new Error('manifest needs a created time');
  if (!Array.isArray(m.posts) || !m.posts.length) throw new Error('manifest has no posts');
  const titles = new Set(), names = new Set();
  m.posts.forEach((p, i) => {
    if (!p?.title?.trim() || p.title.length > 250) throw new Error(`post ${i + 1}: title is required (max 250)`);
    if (titles.has(p.title.trim().toLowerCase())) throw new Error(`post ${i + 1}: duplicate title`);
    titles.add(p.title.trim().toLowerCase());
    if (!p.body_html && !p.body_text) throw new Error(`post ${i + 1}: body_html or body_text is required`);
    for (const f of p.files || []) {
      if (typeof f !== 'string' || !f.startsWith('/')) throw new Error(`post ${i + 1}: files must be absolute paths`);
      const n = safeName(f.split('/').pop()).toLowerCase();
      if (names.has(n)) throw new Error(`post ${i + 1}: file name ${n} used twice in this batch`);
      names.add(n);
    }
  });
  return { ...m, folder: safeName(m.folder || m.batch) };
}

// hashes: { "<abs path>": sha256 }. The fingerprint covers the manifest and every file's bytes.
export const batchFingerprint = (m, hashes) => fingerprint({ m, hashes });

export function channelPlan(m, hashes) {
  const ops = [];
  m.posts.forEach((p, i) => {
    for (const f of p.files || []) ops.push({ kind: 'file', post: i, name: safeName(f.split('/').pop()), source: f, sha256: hashes[f] });
    ops.push({ kind: 'post', post: i, title: p.title.trim() });
  });
  return planOf(m.batch, ops);
}

// Reference attachments: Teams wants the driveItem's eTag GUID as the attachment id, and a matching tag in the body.
export const etagGuid = (etag) => (/\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?/i.exec(String(etag)) || [])[1] || null;
export function messageBody(post, items) {
  const text = post.body_html || `<p>${esc(post.body_text).replace(/\r?\n/g, '<br>')}</p>`;
  const atts = items.map((it) => {
    const id = etagGuid(it.eTag);
    if (!id) throw new Error(`no attachment id for ${it.name}`);
    return { id, contentType: 'reference', contentUrl: it.webUrl, name: it.name };
  });
  return { subject: post.title.trim(), body: { contentType: 'html', content: text + atts.map((a) => `<attachment id="${a.id}"></attachment>`).join('') }, attachments: atts };
}

export const OFFICE = /\.(docx|xlsx|pptx)$/i;

// Browser route target: the channel's SharePoint folder URL from the manifest (`browser_folder`), which must be listed in
// [channel_posts] browser_folders. Returns { site, folder } (folder = server-relative path).
export function browserTarget(m, allowedFolders = []) {
  const want = String(m.browser_folder || '').replace(/\/+$/, '');
  if (!want) throw new Error('browser route needs browser_folder (the channel folder URL) in the manifest');
  if (!allowedFolders.map((x) => String(x).replace(/\/+$/, '').toLowerCase()).includes(want.toLowerCase())) throw new Error('browser_folder is not in [channel_posts] browser_folders');
  const u = new URL(want);
  const site = /^\/(sites|teams)\/[^/]+/.exec(u.pathname);
  if (u.protocol !== 'https:' || !site || u.search || u.hash) throw new Error('browser_folder must be https://<host>/sites/<site>/<library>/<folder>');
  const folder = decodeURIComponent(u.pathname);
  if (/(^|\/)\.{1,2}(\/|$)/.test(folder) || folder.split('/').length < 4) throw new Error('browser_folder must be a folder inside the site');
  return { site: u.origin + site[0], folder };
}
