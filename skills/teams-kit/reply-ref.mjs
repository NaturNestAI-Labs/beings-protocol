// Teams "Reply" quote: a messageReference attachment pointing at the original chat message.
// get(path) must return parsed Graph JSON for GET https://graph.microsoft.com/v1.0<path>.
export async function replyRef(get, chatId, messageId) {
  const m = await get(`/chats/${chatId}/messages/${messageId}`);
  const preview = (m.body?.content || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const u = m.from?.user;
  const content = JSON.stringify({
    messageId: m.id, messagePreview: preview,
    messageSender: u ? { user: { id: u.id, displayName: u.displayName, userIdentityType: 'aadUser' } } : m.from,
  });
  return { attachment: { id: m.id, contentType: 'messageReference', content }, tag: `<attachment id="${m.id}"></attachment>` };
}

// The same quote from a teams-detect hit ({messageId, fromId, from, text}), without fetching the message again.
export function localRef(m) {
  const preview = String(m.text ?? m.preview ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const content = JSON.stringify({
    messageId: m.messageId, messagePreview: preview,
    messageSender: { user: { id: m.fromId, displayName: m.from, userIdentityType: 'aadUser' } },
  });
  return { attachment: { id: m.messageId, contentType: 'messageReference', content }, tag: `<attachment id="${m.messageId}"></attachment>` };
}

// BEING_REPLY_TO = {"<chatId>": "<messageId>"}: the message a work run is answering in each chat.
export function autoReplyTarget(chatId) {
  try { return JSON.parse(process.env.BEING_REPLY_TO || '{}')[chatId] || null; } catch { return null; }
}
