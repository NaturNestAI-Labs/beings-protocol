#!/usr/bin/env node
// The Being's own OneDrive (owner lane only; teammate runs share files with share-file.mjs). Paths are drive-relative.
//   tree <path> | perms <path> | url <path> | get <path> <localFile> | links <path> [--strip-anonymous]
//   mkdir <parent> <name> | move <path> <destFolder> [newName] | upload <localFile> <remotePath> | delete <path>
//   invite <path> <email[,email]> [read|write] | revoke <path> <email>
import { writeFileSync, existsSync, statSync } from 'node:fs';
import { connect, fail, standby, beingSender } from './graph.mjs';
import { currentScope } from './scope.mjs';
import { findSecretsInFiles } from './secrets.mjs';
import { logComms } from './comms-log.mjs';
import { itemPath, children, grantee, uploadFile, invite } from './drive-util.mjs';
import { directLinks, sweep } from './link-guard.mjs';

const [cmd, a, b, c] = process.argv.slice(2);
const READ = ['tree', 'perms', 'url', 'get', 'links'], WRITE = ['mkdir', 'move', 'upload', 'delete', 'invite', 'revoke'];
if (![...READ, ...WRITE].includes(cmd) || !a) fail('usage: onedrive.mjs tree|perms|url|links <path> | get <path> <file> | mkdir <parent> <name> | move <path> <dest> [name] | upload <file> <remote> | delete <path> | invite <path> <emails> [read|write] | revoke <path> <email>', 2);
const strip = cmd === 'links' && b === '--strip-anonymous';
const writes = WRITE.includes(cmd) || strip;
const SENDER = beingSender();
if (writes && standby()) fail('standby host: read-only', 3);
const { scope, why } = currentScope();
if (!['full', 'owner-only'].includes(scope)) fail(`blocked: onedrive.mjs is for the owner lane (${scope}${scope === 'none' ? `: ${why}` : ''}); teammate runs use share-file.mjs`, 3);
const { g } = await connect({ ...SENDER, sender: writes, scopes: ['Files.ReadWrite', 'User.Read'] });
const item = (p) => g(itemPath(p));
const done = (kind, text) => logComms({ dir: 'out', kind: `onedrive-${kind}`, text });

try {
  if (cmd === 'tree') {
    const walk = async (it, rel) => {
      for (const ch of await children(g, it.id)) {
        const p = rel ? `${rel}/${ch.name}` : ch.name, h = ch.file?.hashes || {};
        console.log([ch.folder ? 'D' : 'F', ch.size, ch.lastModifiedDateTime, h.sha256Hash || h.sha1Hash || h.quickXorHash || '-', p].join('\t'));
        if (ch.folder) await walk(ch, p);
      }
    };
    await walk(await item(a), '');
  } else if (cmd === 'perms') {
    const it = await item(a);
    for (const p of (await g(`/me/drive/items/${it.id}/permissions`)).value || []) {
      console.log([p.roles.join(','), grantee(p), p.inheritedFrom ? 'inherited' : 'direct', p.link ? `link:${p.link.scope}/${p.link.type}` : ''].join('\t'));
    }
  } else if (cmd === 'url') {
    console.log((await item(a)).webUrl);
  } else if (cmd === 'get') {
    if (!b) fail('get needs a local file', 2);
    const it = await item(a);
    if (!it['@microsoft.graph.downloadUrl']) fail(`${a} is not a file`, 2);
    const r = await fetch(it['@microsoft.graph.downloadUrl']);
    if (!r.ok) fail(`download failed: ${r.status}`);
    writeFileSync(b, Buffer.from(await r.arrayBuffer()));
    console.log('downloaded', a, statSync(b).size);
  } else if (cmd === 'links') {
    if (strip) await sweep(g, { root: a, strip: true, log: (l) => { console.log(l); done('link-removed', l); } });
    else {
      const walk = async (it, p) => {
        for (const pm of directLinks((await g(`/me/drive/items/${it.id}/permissions`)).value || [])) console.log([p, it.folder ? 'D' : 'F', pm.link.scope, pm.link.type, pm.roles.join(',')].join('\t'));
        if (it.folder) for (const ch of await children(g, it.id)) await walk(ch, `${p}/${ch.name}`);
      };
      await walk(await item(a), a);
    }
  } else if (cmd === 'mkdir') {
    if (!b) fail('mkdir needs a name', 2);
    const parent = await item(a);
    const r = await g(`/me/drive/items/${parent.id}/children`, { body: { name: b, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' } });
    console.log(r.webUrl); done('mkdir', `${a}/${b}`);
  } else if (cmd === 'move') {
    if (!b) fail('move needs a destination folder', 2);
    const it = await item(a), dest = await item(b);
    const r = await g(`/me/drive/items/${it.id}`, { method: 'PATCH', body: { parentReference: { id: dest.id }, ...(c ? { name: c } : {}), '@microsoft.graph.conflictBehavior': 'fail' } });
    console.log('moved', a, '->', `${b}/${r.name}`); done('move', `${a} -> ${b}/${r.name}`);
  } else if (cmd === 'upload') {
    if (!b || !existsSync(a) || !statSync(a).isFile()) fail('upload needs an existing local file and a remote path', 2);
    if (statSync(a).size <= 256 * 1024 * 1024) {
      const leak = findSecretsInFiles([a]);
      if (leak.length) fail(`blocked: the file looks like it contains secrets (${leak.join(', ')}); not uploaded`, 3);
    } else fail('file over 256 MB: too large to check for secrets', 2);
    const { item: up, conflict } = await uploadFile(g, a, b, { conflict: 'fail' });
    if (conflict) fail(`${b} already exists or is locked (${conflict})`, 4);
    console.log('uploaded', b, up.size); done('upload', b);
  } else if (cmd === 'delete') {
    const it = await item(a);
    await g(`/me/drive/items/${it.id}`, { method: 'DELETE' });
    console.log('deleted (recycle bin)', a); done('delete', a);
  } else if (cmd === 'invite') {
    const emails = (b || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!emails.length || (c && !['read', 'write'].includes(c))) fail('invite needs emails and read|write', 2);
    await invite(g, (await item(a)).id, emails, c || 'read');
    console.log('granted', c || 'read', 'on', a, 'to', emails.join(', ')); done('invite', `${a}: ${c || 'read'} to ${emails.join(', ')}`);
  } else if (cmd === 'revoke') {
    if (!b) fail('revoke needs an email', 2);
    const it = await item(a), who = b.toLowerCase();
    const mine = ((await g(`/me/drive/items/${it.id}/permissions`)).value || []).filter((p) => !p.inheritedFrom && (p.grantedToV2?.user?.email || '').toLowerCase() === who);
    for (const p of mine) await g(`/me/drive/items/${it.id}/permissions/${p.id}`, { method: 'DELETE' });
    console.log('revoked', mine.length, 'direct permission(s) on', a, 'for', b); done('revoke', `${a}: ${b}`);
  }
} catch (e) { fail(`onedrive: ${e.message}`); }
