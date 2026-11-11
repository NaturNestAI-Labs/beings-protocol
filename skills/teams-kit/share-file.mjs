#!/usr/bin/env node
// Upload a file to the Being's OneDrive under <BEING_SHARE_ROOT>/<topic> and grant named people access; prints its webUrl
// (use it with teams-send-dm.mjs --attach-url). Sign-in links only: never an "anyone" link.
//   share-file.mjs <file> --to a@x[,b@y] [--topic <Topic> | --folder <path>] [--edit] [--folder-link]
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { connect, need, fail, standby, beingSender } from './graph.mjs';
import { currentScope, allowedChats } from './scope.mjs';
import { findSecretsInFiles } from './secrets.mjs';
import { logComms } from './comms-log.mjs';
import { uploadFile, invite, safeSegment, shareRefusal } from './drive-util.mjs';

const args = process.argv.slice(2);
const take = (k) => { const i = args.indexOf(k); if (i === -1) return null; const v = args[i + 1] || ''; args.splice(i, 2); return v; };
const flag = (k) => { const i = args.indexOf(k); if (i === -1) return false; args.splice(i, 1); return true; };
const to = (take('--to') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const topic = safeSegment(take('--topic'));
const folderArg = take('--folder');
const EDIT = flag('--edit'), FOLDER_LINK = flag('--folder-link');
const file = args[0];
if (!file || !existsSync(file) || !statSync(file).isFile() || !to.length) fail('usage: share-file.mjs <file> --to a@x[,b@y] [--topic <Topic> | --folder <path>] [--edit] [--folder-link]', 2);
if (folderArg && /(^|\/)\.\.(\/|$)/.test(folderArg)) fail('--folder may not contain ..', 2);
const ROOT = process.env.BEING_SHARE_ROOT || 'Shared';
const folder = folderArg || `${ROOT}/${topic || 'General'}`;
if (statSync(file).size > 256 * 1024 * 1024) fail('file over 256 MB: too large to check for secrets; split it or ask the owner', 2);
const leaked = findSecretsInFiles([file]);
if (leaked.length) fail(`blocked: the file looks like it contains secrets (${leaked.join(', ')}); not shared`, 3);
const SENDER = beingSender();
if (standby()) fail('standby host: sharing disabled', 3);
const OWNER = (process.env.OWNER_UPN || need('OWNER_UPN')).toLowerCase();

const { scope, why } = currentScope();
if (scope === 'none') fail(`blocked: this run's grant is not valid (${why}); not shared`, 3);
const { g } = await connect({ ...SENDER, sender: true, scopes: ['Files.ReadWrite', 'Chat.ReadWrite', 'User.Read'] });
try {
  // Scoped runs share only with the owner and the people in the chats their grant lists.
  const chatMembers = [];
  if (scope !== 'full') for (const c of allowedChats(scope)) chatMembers.push(...((await g(`/chats/${encodeURIComponent(c)}/members`)).value || []).map((m) => m.email));
  const refused = shareRefusal(to, { scope, owner: OWNER, chatMembers });
  if (refused) fail(`blocked: ${refused}; not shared`, 3);

  let name = path.basename(file);
  let { item, conflict } = await uploadFile(g, file, `${folder}/${name}`, { conflict: 'replace' });
  if (conflict) {   // a locked file or a stuck earlier upload of the same name does not clear by retrying
    const ext = path.extname(name);
    name = `${path.basename(name, ext)}-${new Date().toISOString().replace(/\D/g, '').slice(0, 12)}${ext}`;
    console.error(`name in use on OneDrive (${conflict}); uploading as ${name}`);
    ({ item, conflict } = await uploadFile(g, file, `${folder}/${name}`, { conflict: 'fail' }));
    if (conflict) fail(`upload blocked twice (${conflict})`, 4);
  }
  // The owner always gets edit rights; everyone else read-only unless --edit.
  const others = to.filter((e) => e !== OWNER);
  const grant = async (id) => { await invite(g, id, [OWNER], 'write'); await invite(g, id, others, EDIT ? 'write' : 'read'); };
  await grant(item.id);
  console.log(item.webUrl);
  if (FOLDER_LINK) { await grant(item.parentReference.id); console.log((await g(`/me/drive/items/${item.parentReference.id}`)).webUrl); }
  logComms({ dir: 'out', kind: 'shared-file', to, text: `${folder}/${name} (${EDIT ? 'edit' : 'read'})`, url: item.webUrl });
  console.error(`shared ${folder}/${name}: edit ${[OWNER, ...(EDIT ? others : [])].join(', ')}${EDIT || !others.length ? '' : `; read ${others.join(', ')}`}`);
} catch (e) { fail(`share-file: ${e.message}`); }
