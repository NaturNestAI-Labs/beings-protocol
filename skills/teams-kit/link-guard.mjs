#!/usr/bin/env node
// "Anyone with the link" shares on the Being's OneDrive: find them, and with --strip remove them.
// The runner calls sweep() (or: link-guard.mjs sweep [--path <folder>] [--strip]) on a timer; exit 10 = links found.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { children, itemPath } from './drive-util.mjs';

export const directLinks = (perms = []) => perms.filter((p) => p.link && !p.inheritedFrom);
export const anonymousLinks = (perms = []) => directLinks(perms).filter((p) => p.link.scope === 'anonymous');

// Walks root (default the whole drive) with g() from graph.mjs. Returns { checked, found: [{ path, type, removed }] }.
export async function sweep(g, { root = '/', strip = false, max = 5000, log = () => {} } = {}) {
  const found = []; let checked = 0;
  const visit = async (it, p) => {
    if (++checked > max) throw new Error(`more than ${max} items under ${root}; narrow --path`);
    const perms = (await g(`/me/drive/items/${it.id}/permissions`)).value || [];
    for (const pm of anonymousLinks(perms)) {
      let removed = false;
      if (strip) { await g(`/me/drive/items/${it.id}/permissions/${pm.id}`, { method: 'DELETE' }); removed = true; }
      found.push({ path: p, type: pm.link.type, removed });
      log(`${removed ? 'removed' : 'found'} anyone-link (${pm.link.type}): ${p}`);
    }
    if (it.folder) for (const ch of await children(g, it.id)) await visit(ch, `${p === '/' ? '' : p}/${ch.name}`);
  };
  await visit(await g(itemPath(root)), root);
  return { checked, found };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2), at = a.indexOf('--path');
  if (a[0] !== 'sweep') { console.error('usage: link-guard.mjs sweep [--path <folder>] [--strip]'); process.exit(2); }
  const { connect, beingSender, standby, fail } = await import('./graph.mjs');
  const strip = a.includes('--strip');
  if (strip && standby()) fail('standby host: read-only', 3);
  const { g } = await connect({ ...beingSender(), sender: strip, scopes: ['Files.ReadWrite', 'User.Read'] });
  try {
    const r = await sweep(g, { root: at === -1 ? '/' : a[at + 1] || '/', strip, log: (l) => console.log(l) });
    console.error(`checked ${r.checked} item(s); ${r.found.length} anyone-link(s)${strip ? ' removed' : ''}`);
    process.exit(r.found.length && !strip ? 10 : 0);
  } catch (e) { fail(`link-guard: ${e.message}`); }
}
