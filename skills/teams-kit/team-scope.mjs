// Teammate-lane reach (BEING_TEAM_SEND in the on-disk .env): "tenant" (default) lets a teammate lane also post to
// 1:1 and existing group chats whose members are all internal (same tenant, team domain, no guests); "chat" = own chat only.
import { kitEnv } from './kit-env.mjs';

export function teamConfig(env = kitEnv()) {
  const mode = String(env.BEING_TEAM_SEND || 'tenant').toLowerCase() === 'chat' ? 'chat' : 'tenant';
  const domain = String(env.BEING_TEAM_DOMAIN || String(env.BEING_UPN || '').split('@')[1] || '').toLowerCase();
  return { on: mode === 'tenant' && !!domain && !!env.M365_TENANT_ID, domain, tenant: env.M365_TENANT_ID || '' };
}

export function teamRecipient(email, cfg) {
  return !!cfg?.on && /^[^@\s#]+@[^@\s]+$/.test(email || '') && email.toLowerCase().split('@')[1] === cfg.domain;
}

// Existing chats only (new groups stay blocked by scope); every member internal, the Being among them.
export function teamChat(chat, members, me, cfg) {
  return !!cfg?.on && ['oneOnOne', 'group'].includes(chat?.chatType) && members.length >= 2
    && members.some((m) => m.userId === me.id)
    && members.every((m) => teamRecipient(m.email || '', cfg) && m.tenantId === cfg.tenant && !(m.roles || []).includes('guest'));
}
