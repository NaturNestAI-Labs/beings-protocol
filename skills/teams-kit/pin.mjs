// Pinning chat messages and spotting document deliveries (teams-send-dm.mjs --pin, docs-index.mjs). Never throws.
const DOC_HOST = /https?:\/\/[^\s"'<>]*(?:sharepoint\.com|onedrive\.live\.com|1drv\.ms|notion\.(?:so|site|com))\b/i;
const DOC_EXT = /\.(?:pdf|xlsx|xls|docx|doc|pptx|ppt|csv)(?=$|[\s"'<>?#&),;:!]|\.(?!\w)|%22|%29)/i;
const GRAPH = 'https://graph.microsoft.com/v1.0';
export const PIN_SCOPES = ['ChatMessage.Send', 'Chat.ReadWrite'];

export function hasDocument(html = '', { attachUrl = null } = {}) {
  if (attachUrl) return true;
  const s = String(html).replace(/&amp;/g, '&');
  return DOC_HOST.test(s) || DOC_EXT.test(s);
}

// The owner's 1:1 with the Being: a oneOnOne chat whose members include the owner's UPN.
export function isOwnerDm(chat, members, ownerUpn) {
  const o = String(ownerUpn || '').toLowerCase();
  return !!o && chat?.chatType === 'oneOnOne' && (members || []).some((m) => String(m.email || '').toLowerCase() === o);
}

// Missing delegated scope for pinning, from the token's scp claim; null if the token is opaque.
export function missingPinScope(accessToken) {
  try {
    const scp = (JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString()).scp || '').split(' ');
    return PIN_SCOPES.some((s) => scp.includes(s)) ? null : PIN_SCOPES.join(' or ');
  } catch { return null; }
}

export async function pinMessage(fetchFn, accessToken, chatId, messageId) {
  const miss = missingPinScope(accessToken);
  if (miss) return { ok: false, error: `token lacks scope ${miss}` };
  try {
    const r = await fetchFn(`${GRAPH}/chats/${encodeURIComponent(chatId)}/pinnedMessages`, {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'message@odata.bind': `${GRAPH}/chats/${chatId}/messages/${messageId}` }),
    });
    return r.ok ? { ok: true, status: r.status } : { ok: false, status: r.status, error: (await r.text()).slice(0, 200) };
  } catch (e) { return { ok: false, error: e.message }; }
}

// Ids of the chat's pinned messages, or null when they cannot be read.
export async function pinnedIds(fetchFn, accessToken, chatId) {
  try {
    const r = await fetchFn(`${GRAPH}/chats/${encodeURIComponent(chatId)}/pinnedMessages?$expand=message`, { headers: { Authorization: `Bearer ${accessToken}` } });
    return r.ok ? ((await r.json()).value || []).map((p) => p.message?.id).filter(Boolean) : null;
  } catch { return null; }
}
