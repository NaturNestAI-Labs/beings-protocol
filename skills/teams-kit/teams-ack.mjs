#!/usr/bin/env node
// Apply triage decisions (none | react | reply) read from stdin; exit 1 if any failed. Usage: README.md "Script reference".
// --preconnect: sign in first, then wait for stdin (being-handle starts it while the model is still deciding).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { connect, stateDir, standby, fail, beingSender } from './graph.mjs';
import { logComms } from './comms-log.mjs';
import { replyRef, localRef } from './reply-ref.mjs';
import { toHtml } from './fmt.mjs';
import { findSecrets } from './secrets.mjs';

const SENDER = beingSender();
if (standby()) fail('standby host: acknowledgements disabled', 3);
const ACKED = path.join(stateDir(), 'acked-ids.txt');
// Same pattern as being-handle's QUESTION: '?', an English question word at the start, a Hinglish one anywhere.
const QUESTION = /\?|^\s*(why|what|how|when|where|who|which|did|does|do|is|are|was|can|could|will|would|should)\b|\b(kya|kyu|kyun|kyon|kaise|kaisa|kab|kaun|kahan|kidhar|kitna|kitni|kitne|btao|batao|bata|bataiye|bolo|hai kya)\b/i;
const EMOJI = new Set(['👍', '❤️', '😆', '😮', '🙏', '🔥', '✅', '🎉', '👀', '💯', '🚀', '🙌', '👌', '😊', '💪']);
// People who asked for words instead of reactions (one sender object id per line).
const NO_REACT_F = path.join(stateDir(), 'no-react.txt');
const NO_REACT = new Set(existsSync(NO_REACT_F) ? readFileSync(NO_REACT_F, 'utf8').split('\n').map((s) => s.split('#')[0].trim()).filter(Boolean) : []);

const SCOPES = ['Chat.ReadWrite', 'ChatMessage.Send', 'User.Read'];
const early = process.argv.includes('--preconnect') ? await connect({ ...SENDER, sender: true, scopes: SCOPES }) : null;
const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const byMsg = new Map((input.actions || []).map((a) => [a.messageId, a]));
const acked = new Set(existsSync(ACKED) ? readFileSync(ACKED, 'utf8').split('\n').filter(Boolean) : []);
// --deferred: held next-step lines (being-handle ack_flush) for messages already acked; sent as replies, logged 'ack-deferred'.
const DEFERRED = process.argv.includes('--deferred');
const todo = (input.messages || []).filter((m) => m.messageId && m.addressedBy !== 'reaction' && (DEFERRED || !acked.has(m.messageId)));
if (!todo.length) process.exit(0);

const { g } = early || await connect({ ...SENDER, sender: true, scopes: SCOPES });
let failed = 0;
for (const m of todo) {
  if (!DEFERRED) logComms({ dir: 'in', chatId: m.chatId, chatType: m.chatType, topic: m.topic, from: m.from, at: m.at,
    messageId: m.messageId, text: m.text ?? m.preview, attachments: m.attachments });
  // No decision: 👍 in a 1:1, but never on a question (being-handle's guard, repeated here: silence until the work step answers).
  const d = byMsg.get(m.messageId) || { action: m.chatType === 'oneOnOne' && !QUESTION.test(m.text ?? m.preview ?? '') ? 'react' : 'none', fallback: true };
  // People who asked for no reactions get triage's own words, or nothing: a canned line reads as dismissive.
  // Where a held line will follow, nothing now.
  if (d.action === 'react' && NO_REACT.has(m.fromId)) {
    if (d.deferredText || !d.text?.trim()) Object.assign(d, { action: 'none', text: '' });
    else Object.assign(d, { action: 'reply' });
  }
  const leaked = d.action === 'reply' ? findSecrets(d.text) : [];
  if (leaked.length) {   // a triage reply that quotes .env or a credential is dropped; the work run still answers
    logComms({ dir: 'ack', kind: 'blocked-secret', chatId: m.chatId, messageId: m.messageId, error: leaked.join(', ') });
    Object.assign(d, { action: 'none', text: '' });
  }
  try {
    if (d.action === 'react') {
      await g(`/chats/${m.chatId}/messages/${m.messageId}/setReaction`, { body: { reactionType: EMOJI.has(d.emoji) ? d.emoji : '👍' } });
      logComms({ dir: 'ack', kind: d.fallback ? 'reaction-fallback' : 'reaction', chatId: m.chatId, messageId: m.messageId, to: m.from });
    } else if (d.action === 'reply' && d.text?.trim()) {
      const plain = { body: { contentType: 'html', content: toHtml(d.text.trim()) } };
      let body = plain;
      try {
        // The detect hit already carries the sender and text: build the quote locally and skip a Graph round trip.
        const ref = m.fromId && m.from && (m.text ?? m.preview) ? localRef(m) : await replyRef(g, m.chatId, m.messageId);
        body = { body: { contentType: 'html', content: ref.tag + plain.body.content }, attachments: [ref.attachment] };
      } catch (e) { console.error(`quote ${m.messageId} unavailable: ${e.message}`); }
      const sent = await g(`/chats/${m.chatId}/messages`, { body })
        .catch((e) => { if (body === plain) throw e; console.error(`quoted reply rejected (${e.message}); sending plain`); return g(`/chats/${m.chatId}/messages`, { body: plain }); });
      logComms({ dir: 'out', kind: DEFERRED ? 'ack-deferred' : 'ack-reply', chatId: m.chatId, messageId: sent.id, replyTo: m.messageId, to: m.from, text: d.text.trim() });
    } else {
      logComms({ dir: 'ack', kind: 'none', chatId: m.chatId, messageId: m.messageId, to: m.from });
    }
    acked.add(m.messageId);
  } catch (e) {
    failed++;
    logComms({ dir: 'ack', kind: 'error', chatId: m.chatId, messageId: m.messageId, error: e.message });
    console.error(`ack ${m.messageId} failed: ${e.message}`);
  }
}
writeFileSync(ACKED, [...acked].slice(-5000).join('\n') + '\n');
process.exit(failed ? 1 : 0);
