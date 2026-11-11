#!/usr/bin/env node
// Instant "seen" receipt: 👀 on the owner's new 1:1 messages before triage (teams-detect JSON on stdin; each once).
// --wait <fifo>: sign in first, then take the JSON as one line from the FIFO (being-teams keeps one waiting).
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { connect, stateDir, standby, beingSender } from './graph.mjs';
import { openTrigger, readLine } from './fifo-wait.mjs';

if (standby()) process.exit(0);
const OWNER = process.env.OWNER_OID || '';
const SEEN = path.join(stateDir(), 'seen-react-ids.txt');
const done = new Set(existsSync(SEEN) ? readFileSync(SEEN, 'utf8').split('\n').filter(Boolean) : []);
const SCOPES = ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'];
const wi = process.argv.indexOf('--wait');
const trigger = wi > 0 && process.argv[wi + 1] ? openTrigger(process.argv[wi + 1]) : null;
const early = trigger !== null ? await connect({ ...beingSender(), sender: true, scopes: SCOPES }) : null;
const input = JSON.parse((trigger !== null ? readLine(trigger) : readFileSync(0, 'utf8')) || '{}');
// Off by default: triage alone decides react/reply. BEING_SEEN_REACT=1 turns it back on.
if (process.env.BEING_SEEN_REACT !== '1') process.exit(0);
const todo = (input.messages || []).filter((m) => OWNER && m.fromId === OWNER && m.chatType === 'oneOnOne'
  && m.addressedBy !== 'reaction' && m.messageId && !done.has(m.messageId));
if (!todo.length) process.exit(0);

const { g } = early || await connect({ ...beingSender(), sender: true, scopes: SCOPES });
for (const m of todo) {
  try {
    await g(`/chats/${m.chatId}/messages/${m.messageId}/setReaction`, { body: { reactionType: '👀' } });
    appendFileSync(SEEN, m.messageId + '\n');
  } catch (e) { console.error(`seen ${m.messageId}: ${e.message}`); }
}
if (early) {   // stderr goes to loop.log: the 👀 time for the latency trail
  const d = new Date(), p = (n, w = 2) => String(n).padStart(w, '0'), o = -d.getTimezoneOffset();
  console.error(`${d.toLocaleString('sv').replace(' ', 'T')}.${p(d.getMilliseconds(), 3)}${o >= 0 ? '+' : '-'}${p(Math.trunc(Math.abs(o) / 60))}${p(Math.abs(o) % 60)} seen step done (${todo.length} marked, pre-connected)`);
}
