#!/usr/bin/env node
// Soft-delete messages the Being itself sent (anyone else's are refused): teams-delete-msg.mjs <chatId> <messageId>...
// Scoped runs may delete only in chats their grant lets them post to.
import { connect, fail, standby, beingSender, need } from './graph.mjs';
import { currentScope, allowedChats } from './scope.mjs';
import { logComms } from './comms-log.mjs';
import { isOwnerDm } from './pin.mjs';

const [chatId, ...ids] = process.argv.slice(2);
if (!chatId || !ids.length) fail('usage: teams-delete-msg.mjs <chatId> <messageId> [messageId...]', 2);
const SENDER = beingSender();
if (standby()) fail('standby host: disabled', 3);
const { scope, why } = currentScope();
if (scope === 'none') fail(`blocked: this run's grant is not valid (${why})`, 3);
const { g, me } = await connect({ ...SENDER, sender: true, scopes: ['Chat.ReadWrite', 'User.Read'] });
const chat = encodeURIComponent(chatId);
if (scope !== 'full' && !allowedChats(scope).includes(chatId)) {
  const c = await g(`/chats/${chat}?$expand=members`).catch((e) => fail(`cannot resolve chat: ${e.message}`));
  if (!isOwnerDm(c, c.members, need('OWNER_UPN'))) fail(`blocked: ${scope.split(':')[0]} scope (chat ${chatId})`, 3);
}
let rc = 0;
for (const id of ids) {
  try {
    const m = await g(`/chats/${chat}/messages/${encodeURIComponent(id)}`);
    if (m.from?.user?.id !== me.id) { console.error(`skip ${id}: not sent by ${me.userPrincipalName}`); rc = 1; continue; }
    if (m.deletedDateTime) { console.log(`${id}: already deleted`); continue; }
    await g(`/users/${me.id}/chats/${chat}/messages/${encodeURIComponent(id)}/softDelete`, { body: {} });
    logComms({ dir: 'out', kind: 'deleted', chatId, messageId: id });
    console.log(`${id}: deleted`);
  } catch (e) { console.error(`${id}: ${e.message}`); rc = 1; }
}
process.exit(rc);
