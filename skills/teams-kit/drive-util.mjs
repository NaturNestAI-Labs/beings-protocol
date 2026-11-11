// OneDrive helpers shared by share-file.mjs, onedrive.mjs and link-guard.mjs (the Being's own drive, via graph.mjs g()).
import { statSync, openSync, readSync, closeSync } from 'node:fs';

export const enc = (p) => String(p).split('/').filter(Boolean).map(encodeURIComponent).join('/');
export const itemPath = (p) => (!enc(p) ? '/me/drive/root' : `/me/drive/root:/${enc(p)}`);
// A folder name from free text: no path separators or characters OneDrive refuses.
export const safeSegment = (s) => String(s || '').replace(/[\\/:*?"<>|#%]/g, '-').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 120);

export async function children(g, id) {
  const out = []; let url = `/me/drive/items/${id}/children?$top=200`;
  while (url) { const r = await g(url); out.push(...(r.value || [])); url = r['@odata.nextLink']; }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Who a permission is for: an email, a display name, or the link scope.
export const grantee = (p) => p.grantedToV2?.user?.email || p.grantedToV2?.siteUser?.loginName || p.grantedTo?.user?.displayName
  || (p.grantedToIdentitiesV2 || []).map((x) => x.user?.email || x.user?.displayName).filter(Boolean).join(',') || p.link?.scope || '?';

// Chunked upload session (any size; chunks are multiples of 320 KiB, read one at a time). Returns {item} or {conflict}.
// conflict: 'fail' | 'replace' | 'rename'. Transient 5xx and network errors are retried.
export async function uploadFile(g, local, remote, { conflict = 'fail', chunk = 16 * 327680, fetchFn = fetch, wait = 5000 } = {}) {
  const size = statSync(local).size, buf = Buffer.alloc(Math.min(chunk, Math.max(size, 1))), fd = openSync(local, 'r');
  try {
    let s;
    try { s = await g(`${itemPath(remote)}:/createUploadSession`, { body: { item: { '@microsoft.graph.conflictBehavior': conflict } } }); }
    catch (e) { if (/^(409|423)\b/.test(e.message)) return { conflict: e.message.slice(0, 160) }; throw e; }
    for (let at = 0; at < size || at === 0; at += chunk) {
      const n = size ? readSync(fd, buf, 0, Math.min(chunk, size - at), at) : 0;
      let r;
      for (let t = 1; ; t++) {
        r = await fetchFn(s.uploadUrl, { method: 'PUT', headers: { 'Content-Range': size ? `bytes ${at}-${at + n - 1}/${size}` : 'bytes */0' }, body: buf.subarray(0, n) })
          .catch((e) => ({ ok: false, status: 0, text: async () => String(e.message) }));
        if (r.ok || (r.status && r.status < 500) || t === 4) break;
        await new Promise((res) => setTimeout(res, wait * t));
      }
      if (r.status === 409 || r.status === 423) return { conflict: `${r.status} ${(await r.text()).slice(0, 160)}` };
      if (!r.ok) throw new Error(`upload failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
      if (r.status === 200 || r.status === 201) return { item: await r.json() };
      if (!size) break;
    }
    throw new Error('upload did not complete');
  } finally { closeSync(fd); }
}

// Invite people to an item: sign-in required, no invitation mail, never an anonymous link.
export const invite = (g, itemId, emails, role = 'read') => emails.length
  ? g(`/me/drive/items/${itemId}/invite`, { body: { recipients: emails.map((email) => ({ email })), roles: [role === 'write' ? 'write' : 'read'], requireSignIn: true, sendInvitation: false } })
  : null;

// People a run may share with: anyone under a full grant; otherwise the owner and members of the chats its grant lists.
export function shareRefusal(emails, { scope, owner, chatMembers = [] }) {
  if (scope === 'full') return null;
  if (scope === 'none') return 'this run\'s grant is not valid';
  const ok = new Set([owner, ...chatMembers].map((x) => String(x || '').toLowerCase()).filter(Boolean));
  const bad = emails.filter((e) => !ok.has(String(e).toLowerCase()));
  return bad.length ? `${scope.split(':')[0]} scope may share only with the owner and its chat members (not ${bad.join(', ')})` : null;
}
