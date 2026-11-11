#!/usr/bin/env node
// Teams channels as the Being: list the teams and channels it is in, post to one (off unless BEING_CHANNEL_POST=1).
// list | post --team <id> --channel <id> [--subject S] [--attach-url U [--attach-name N]] [--dry-run] < body.md
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureHtml } from './fmt.mjs';
import { findSecrets } from './secrets.mjs';
import { PROMPT_MARK_RE } from './approval.mjs';

export function render(body, subject) {
  if (!String(body || '').trim()) throw new Error('empty message body on stdin');
  const payload = { body: { contentType: 'html', content: ensureHtml(body) } };
  if (subject) payload.subject = subject;
  if (PROMPT_MARK_RE.test(payload.body.content.replace(/<[^>]+>/g, ' '))) throw new Error('blocked: only draft-for-owner.mjs may post draft approval prompts');
  const leaked = findSecrets(`${subject || ''}\n${payload.body.content}`);
  if (leaked.length) throw new Error(`blocked: message looks like it contains secrets (${leaked.join(', ')})`);
  return payload;
}

export async function collect(request, url, scopes) {
  const out = [];
  while (url) { const page = await request(url, scopes); out.push(...(page.value || [])); url = page['@odata.nextLink']; }
  return out;
}

// Teams and channels with the Being's role in each; private and shared channels report their own membership.
export async function listChannels(request, me) {
  const rows = [];
  for (const team of await collect(request, '/me/joinedTeams', ['Team.ReadBasic.All'])) {
    const root = `/teams/${encodeURIComponent(team.id)}`;
    const mine = (await collect(request, `${root}/members`, ['TeamMember.Read.All'])).find((m) => m.userId === me.id);
    for (const ch of await collect(request, `${root}/channels`, ['Channel.ReadBasic.All'])) {
      let roles = mine?.roles || [];
      if (ch.membershipType && ch.membershipType !== 'standard') {
        roles = (await collect(request, `${root}/channels/${encodeURIComponent(ch.id)}/members`, ['ChannelMember.Read.All'])).find((m) => m.userId === me.id)?.roles || [];
      }
      rows.push({ teamId: team.id, teamName: team.displayName, channelId: ch.id, channelName: ch.displayName,
        membershipType: ch.membershipType || 'standard', teamRoles: mine?.roles || [], channelRoles: roles });
    }
  }
  return rows.sort((a, b) => Number(b.channelRoles.includes('owner')) - Number(a.channelRoles.includes('owner'))
    || a.teamName.localeCompare(b.teamName) || a.channelName.localeCompare(b.channelName));
}

// File card for a OneDrive/SharePoint item: Teams resolves it by the eTag GUID and WebDAV URL.
export async function attachmentCard(request, url, name) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('--attach-url needs an https sharing URL');
  const item = await request(`/shares/u!${Buffer.from(url).toString('base64url')}/driveItem?$select=name,eTag,webDavUrl`, ['Files.ReadWrite']);
  const id = /\{?([0-9A-Fa-f-]{36})/.exec(item.eTag || '')?.[1];
  if (!id || !item.webDavUrl) throw new Error('attachment has no eTag/webDavUrl');
  return { id, contentType: 'reference', contentUrl: item.webDavUrl, name: name || item.name };
}

export function parseArgs(argv) {
  const [command, ...rest] = argv, o = {};
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === '--dry-run') o.dryRun = true;
    else if (['--team', '--channel', '--subject', '--attach-url', '--attach-name'].includes(k) && rest[i + 1] && !rest[i + 1].startsWith('--')) o[k.slice(2)] = rest[++i];
    else throw new Error(`unknown or incomplete option: ${k}`);
  }
  return { command, o };
}

async function main() {
  const { command, o } = parseArgs(process.argv.slice(2));
  if (!['list', 'post'].includes(command)) throw Object.assign(new Error('usage: teams-channel.mjs list | post --team <id> --channel <id> [--subject S] [--attach-url U] [--dry-run] < body'), { code: 2 });
  let payload;
  if (command === 'post') {
    payload = render(readFileSync(0, 'utf8'), o.subject);
    if (o.dryRun) { console.log(JSON.stringify({ subject: payload.subject, htmlBytes: Buffer.byteLength(payload.body.content), attachment: o['attach-url'] ? 'not resolved offline' : null })); return; }
    if (!o.team || !o.channel) throw Object.assign(new Error('--team and --channel are required'), { code: 2 });
    const { kitEnv } = await import('./kit-env.mjs');
    if (kitEnv().BEING_CHANNEL_POST !== '1') throw Object.assign(new Error('blocked: channel posting is off (BEING_CHANNEL_POST=1 in .env)'), { code: 3 });
    const { currentScope } = await import('./scope.mjs');
    const { scope, why } = currentScope();
    if (scope !== 'full') throw Object.assign(new Error(`blocked: channel posts need a full-scope grant (this run: ${scope}, ${why})`), { code: 3 });
    const { standby } = await import('./graph.mjs');
    if (standby()) throw Object.assign(new Error('standby host: sending disabled'), { code: 3 });
  }
  const { connect, beingSender } = await import('./graph.mjs');
  const { logComms } = await import('./comms-log.mjs');
  const { me, tokenFor } = await connect({ ...beingSender(), sender: true, scopes: ['User.Read'] });
  // One token per call, for just the scope that call needs (team, channel and file scopes are consented separately).
  const request = async (url, scopes, { method, body } = {}) => {
    const r = await fetch(url.startsWith('http') ? url : `https://graph.microsoft.com/v1.0${url}`, { method: method || (body ? 'POST' : 'GET'),
      headers: { Authorization: `Bearer ${await tokenFor(scopes)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0].slice(0, 80)} (needs ${scopes.join(', ')}): ${t.slice(0, 160)}`);
    return t ? JSON.parse(t) : {};
  };
  if (command === 'list') { console.log(JSON.stringify(await listChannels(request, me), null, 2)); return; }
  const root = `/teams/${encodeURIComponent(o.team)}/channels/${encodeURIComponent(o.channel)}`;
  const ch = await request(root, ['Channel.ReadBasic.All']);   // a wrong id fails here, before anything is posted
  if (o['attach-url']) {
    const card = await attachmentCard(request, o['attach-url'], o['attach-name']);
    payload.attachments = [card]; payload.body.content += `<attachment id="${card.id}"></attachment>`;
  }
  const msg = await request(`${root}/messages`, ['ChannelMessage.Send'], { body: payload });
  logComms({ dir: 'out', kind: 'channel', chatId: `${o.team}/${o.channel}`, messageId: msg.id, to: ch.displayName, subject: o.subject,
    text: payload.body.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  console.log(JSON.stringify({ id: msg.id, webUrl: msg.webUrl }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(e.code || 1); });
}
