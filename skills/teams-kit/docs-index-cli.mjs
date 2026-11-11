#!/usr/bin/env node
// Docs index in the owner's 1:1, posted and edited as the Being only (optional: BEING_DOCS_INDEX=1).
// post <seed.json> | refresh | verify. Seed: { pinnedEntry?, entries: [{ date, links: [{ name, url }], what }] } (newest first).
import { readFileSync } from 'node:fs';
import { connect, need, fail, standby, stateDir, beingSender } from './graph.mjs';
import { isOwnerDm, pinMessage, pinnedIds } from './pin.mjs';
import { findSecrets } from './secrets.mjs';
import { logComms } from './comms-log.mjs';
import { enabled, renderIndex, addEntry, loadState, saveState, patchMessage, ensurePinned, maxEntries } from './docs-index.mjs';

const [cmd, arg] = process.argv.slice(2);
if (!['post', 'refresh', 'verify'].includes(cmd)) fail('usage: docs-index-cli.mjs post <seed.json> | refresh | verify', 2);
if (!enabled()) fail('docs index is off (BEING_DOCS_INDEX=1 to turn it on)', 2);
const SENDER = beingSender();
if (standby() && cmd !== 'verify') fail('standby host: sending disabled', 3);
const OWNER = need('OWNER_UPN').toLowerCase(), DIR = stateDir();
const { g, token } = await connect({ ...SENDER, sender: true, scopes: ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'] });

// The owner's 1:1 with the Being, found by membership (no stored chat id needed).
async function ownerChat() {
  const cs = await g(`/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`);
  return cs.value.find((c) => isOwnerDm(c, c.members, OWNER)) || fail('owner 1:1 not found');
}
const guard = (html) => { const l = findSecrets(html); if (l.length) fail(`blocked: index looks like it contains secrets (${l.join(', ')}); nothing sent`, 3); };

try {
  if (cmd === 'post') {
    const seed = JSON.parse(readFileSync(arg || fail('post needs a seed file', 2), 'utf8'));
    const chat = await ownerChat();
    // Seed entries go through addEntry too, so the caps apply from the start.
    let state = { chatId: chat.id, pinnedEntry: seed.pinnedEntry || null, entries: [] }; const rolled = [];
    for (const e of [...(seed.entries || [])].reverse()) { const r = addEntry(state, e); state = r.state; rolled.push(...r.rolled); }
    const html = renderIndex(state); guard(html);
    const msg = await g(`/chats/${chat.id}/messages`, { body: { body: { contentType: 'html', content: html } } });
    saveState(DIR, { ...state, messageId: msg.id, createdAt: msg.createdDateTime, updatedAt: new Date().toISOString() }, rolled);
    logComms({ dir: 'out', kind: 'message', chatId: chat.id, messageId: msg.id, to: OWNER, text: `Docs index (${state.entries.length} entries)` });
    const p = await pinMessage(fetch, token, chat.id, msg.id);
    console.log(`posted docs index ${msg.id} (${state.entries.length} entries, ${rolled.length} archived); ${p.ok ? 'pinned' : `pin failed: ${p.error}`}`);
  } else if (cmd === 'refresh') {
    const state = loadState(DIR) || fail('no saved docs index (post first)');
    const html = renderIndex(state); guard(html);
    const p = await patchMessage(fetch, token, state.chatId, state.messageId, html);
    if (!p.ok) fail(`PATCH failed: ${p.status} ${p.error}`);
    console.log(`refreshed ${state.messageId} (${state.entries.length}/${maxEntries()} entries); pin: ${JSON.stringify(await ensurePinned(fetch, token, state.chatId, state.messageId))}`);
  } else {
    const state = loadState(DIR);
    const ids = (await pinnedIds(fetch, token, state?.chatId || (await ownerChat()).id)) || [];
    console.log(`pinned: ${ids.join(', ') || 'none'}; index ${state?.messageId || '-'} ${ids.includes(state?.messageId) ? 'is' : 'is NOT'} pinned`);
    process.exit(ids.includes(state?.messageId) ? 0 : 1);
  }
} catch (e) { fail(`docs-index: ${e.message}`); }
