#!/usr/bin/env node
// Owner mail forwarding rules: forwards mail a rule covers to the one person who asked; logged and reported each time.
// Usage: [--dry-run] [--rule <name>] (sweep) | --rule <name> --to <addr> [--id <msgId>] [--owner-once] --go-chat <id> --go-msg <id>
import './oa-env.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fail } from './graph.mjs';
import { KIT, paused } from './oa-config.mjs';
import { openOwnerAccess, beingTeams, requireGo, logAsOwner, reportToOwner, esc } from './owner-session.mjs';
import { forwardRoute, guardedGraph } from './guards.mjs';
import { compileRule, pickRequester, extractCode, redactCodes, isForwardOf } from './forward-rules.mjs';
import { mintGrant, revokeGrant } from './scope.mjs';

const { values: o } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, rule: { type: 'string' }, to: { type: 'string' }, id: { type: 'string' },
  'owner-once': { type: 'boolean' }, 'go-chat': { type: 'string' }, 'go-msg': { type: 'string' } } });
const DRY = !!o['dry-run'];
const { s, owner } = await openOwnerAccess('mail_forward_rules', { services: ['outlook'], ownerScopes: { outlook: ['Mail.ReadWrite', 'Mail.Send'] } });
const rules = (s.cfg.forward_rules || []).map(compileRule).filter((r) => !o.rule || r.name === o.rule);
if (!rules.length) fail(o.rule ? `no forward rule named ${o.rule}` : 'no [[forward_rules]] in owner-access.toml', 2);
const access = { readIds: new Set(), forwardId: null };
const g = guardedGraph(owner.outlook.token, (url, method) => forwardRoute(url, method, access));
const being = await beingTeams(s);
const say = (t) => console.log(`${new Date().toISOString()} forward${DRY ? ' [dry-run]' : ''}: ${redactCodes(t)}`);
const hm = (iso) => new Date(iso).toISOString().slice(11, 16) + ' UTC';
const addr = (r) => String(r?.emailAddress?.address || '').toLowerCase();
const strip = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
const hash = (id) => createHash('sha256').update(id).digest('hex').slice(0, 12);
const tell = (html) => { if (DRY) say(`would tell the owner: ${strip(html)}`); else reportToOwner(s, redactCodes(html)); };
const DIR = path.join(s.state, 'owner-access', 'forward');
mkdirSync(DIR, { recursive: true, mode: 0o700 });

async function sentForwards(sinceIso) {
  return (await g(`/me/mailFolders/sentitems/messages?$top=250&$orderby=sentDateTime desc&$filter=sentDateTime ge ${sinceIso}&$select=subject,toRecipients,sentDateTime`)).value || [];
}

// Requests: mail to the owner from someone allowed to ask, and messages in the Being's own 1:1 chats.
async function findRequests(rule, sinceIso) {
  const reqs = [], ok = (e) => rule.mayAsk(e, { owner: s.ownerUpn, being: s.beingUpn });
  for (const m of (await g(`/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc&$filter=receivedDateTime ge ${sinceIso}&$select=from,subject,bodyPreview,receivedDateTime`)).value || []) {
    const kind = rule.ask(`${m.subject} ${m.bodyPreview}`);
    if (kind && ok(addr(m.from))) reqs.push({ email: addr(m.from), name: m.from.emailAddress.name || addr(m.from), via: 'mail', at: m.receivedDateTime, kind });
  }
  const chats = (await being.g(`/me/chats?$filter=chatType eq 'oneOnOne'&$expand=members&$top=50`)).value || [];
  for (const c of chats) {
    const members = new Map((c.members || []).map((x) => [x.userId, String(x.email || '').toLowerCase()]));
    for (const msg of (await being.g(`/chats/${encodeURIComponent(c.id)}/messages?$top=30`)).value || []) {
      if (msg.messageType !== 'message' || !msg.from?.user || Date.parse(msg.createdDateTime) < Date.parse(sinceIso)) continue;
      const email = members.get(msg.from.user.id) || '', kind = rule.ask(strip(msg.body?.content));
      if (kind && ok(email)) reqs.push({ email, name: msg.from.user.displayName || email, via: 'Teams', chatId: c.id, at: msg.createdDateTime, kind });
    }
  }
  return reqs;
}

// Optional: the one-time code goes to the requester's 1:1 with the Being under a grant for that chat only, never logged.
function sendCode(rule, e, req, code) {
  if (!rule.codeDm || !code || !req.chatId || e.codeSent || Date.now() - Date.parse(e.received) > rule.codeFreshMs) return false;
  if (DRY) { say(`would send the code from ${e.hash} to ${req.email} in Teams`); return true; }
  e.codeSent = 'sending';
  const token = mintGrant(`chats:${req.chatId}`, { state: s.state, ttlHours: 0.1 });
  try {
    const r = spawnSync('node', [path.join(KIT, 'teams-send-dm.mjs'), '--chat', req.chatId, '--verbatim'], {
      input: `<p>Your sign-in code is ${code}. It expires soon; the mail itself is forwarded too.</p>`,
      env: { ...process.env, BEING_SEND_TOKEN: token, BEING_COMMS_LOG: '/dev/null' }, stdio: ['pipe', 'ignore', 'inherit'], timeout: 60000 });
    e.codeSent = r.status === 0 ? new Date().toISOString() : 'failed';
  } finally { revokeGrant(token, { state: s.state }); }
  logAsOwner('mail_forward_rules', { channel: 'teams', action: e.codeSent === 'failed' ? 'code-dm-failed' : 'code-dm', rule: rule.name, idHash: e.hash, to: req.email });
  return e.codeSent !== 'failed';
}

async function forward(rule, st, e, to, why, req) {
  if (rule.blocked(to) && !(o['owner-once'] && o.to)) {
    say(`refused ${e.hash} -> ${to}: on the block list`);
    logAsOwner('mail_forward_rules', { channel: 'mail', action: 'refused-blocked', rule: rule.name, idHash: e.hash, to });
    tell(`Did not forward the ${esc(rule.name)} mail (${hm(e.received)}) to ${esc(to)}: they are on the block list.`);
    return false;
  }
  if (DRY) { say(`would forward ${e.hash} "${e.subject}" -> ${to} (${why})`); return true; }
  let coded = false;
  if (req && rule.codeDm) {
    access.readIds.add(e.id);
    const m = await g(`/me/messages/${encodeURIComponent(e.id)}?$select=subject,body`, { headers: { Prefer: 'outlook.body-content-type="text"' } });
    coded = sendCode(rule, e, req, extractCode(m.subject, m.body?.content));
  }
  e.status = 'forwarding'; e.to = to; st.save();   // marked first: a crash never causes a second forward
  try {
    access.forwardId = e.id;
    await g(`/me/messages/${encodeURIComponent(e.id)}/forward`, { method: 'POST', body: { comment: 'Forwarded as requested.', toRecipients: [{ emailAddress: { address: to } }] } });
  } catch (err) {
    e.status = 'error'; e.error = err.message.slice(0, 160); st.save();
    tell(`Forwarding the ${esc(rule.name)} mail (${hm(e.received)}) to ${esc(to)} failed: ${esc(e.error.slice(0, 100))}.`);
    return false;
  } finally { access.forwardId = null; }
  e.status = 'forwarded'; e.forwardedAt = new Date().toISOString(); st.save();
  logAsOwner('mail_forward_rules', { channel: 'mail', action: 'forwarded', rule: rule.name, idHash: e.hash, subject: e.subject, to, why });
  tell(`Forwarded the ${esc(rule.name)} mail (${hm(e.received)}) to ${esc(to)} (${esc(why)}).${coded ? ' I also sent them the sign-in code in Teams.' : ''}`);
  return true;
}

for (const rule of rules) {
  if (paused(s.state, `forward-${rule.name}`)) { say(`${rule.name}: paused`); continue; }
  const F = path.join(DIR, `${rule.name}.json`);
  const st = existsSync(F) ? JSON.parse(readFileSync(F, 'utf8')) : { held: {} };
  st.save = () => { if (DRY) return; const { save, ...data } = st; writeFileSync(`${F}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(`${F}.tmp`, F); };
  const sent = await sentForwards(new Date(Date.now() - rule.windowMs - rule.keepMs).toISOString());
  const forwardsOf = (subj) => sent.filter((x) => isForwardOf(x.subject, subj));

  if (o.to) {   // the owner named the person, with a go "forward <rule> <address>"
    const to = o.to.toLowerCase();
    if (!rule.mayAsk(to, { owner: s.ownerUpn, being: s.beingUpn })) fail(`refused: ${to} is not someone this rule may forward to`, 2);
    await requireGo(s, { area: 'mail_forward_rules', expect: `forward ${rule.name} ${to}${o['owner-once'] ? ' once' : ''}`, chatId: o['go-chat'], msgId: o['go-msg'] });
    const e = o.id ? st.held[o.id] : Object.values(st.held).filter((x) => ['held', 'expired'].includes(x.status)).sort((a, b) => b.received.localeCompare(a.received))[0];
    if (!e) fail('no held mail for this rule', 2);
    if (e.status === 'forwarding') fail(`refused: ${e.hash} has an unconfirmed forward; check Sent Items first`, 2);
    if (forwardsOf(e.subject).some((x) => (x.toRecipients || []).map(addr).includes(to))) { say(`${e.hash} already forwarded to ${to}`); process.exit(0); }
    process.exit((await forward(rule, st, e, to, 'owner named the recipient', null)) ? 0 : 1);
  }

  const startedAt = new Date().toISOString();
  const from = new Date(Date.parse(st.watermark || new Date(Date.now() - rule.windowMs).toISOString()) - 5 * 60e3).toISOString();
  for (const m of (await g(`/me/mailFolders/inbox/messages?$top=50&$orderby=receivedDateTime desc&$filter=receivedDateTime gt ${from}&$select=id,subject,from,receivedDateTime`)).value || []) {
    if (rule.covers({ from: addr(m.from), subject: m.subject })) st.held[m.id] ||= { id: m.id, hash: hash(m.id), subject: m.subject, received: m.receivedDateTime, status: 'new' };
  }
  for (const [id, e] of Object.entries(st.held)) if (Date.now() - Date.parse(e.received) > rule.keepMs) delete st.held[id];
  const open = Object.values(st.held).filter((e) => ['new', 'held', 'forwarding'].includes(e.status));
  if (open.length) {
    const earliest = Math.min(...open.map((e) => Date.parse(e.received)));
    const reqs = await findRequests(rule, new Date(earliest - rule.windowMs).toISOString());
    for (const e of open) {
      const fwd = forwardsOf(e.subject);
      if (e.status === 'forwarding') {   // crashed mid-forward: confirm from Sent Items, never resend
        e.status = fwd.length ? 'forwarded' : 'error'; st.save();
        if (!fwd.length) tell(`I may not have forwarded the ${esc(rule.name)} mail (${hm(e.received)}) to ${esc(e.to)}. Please check.`);
        continue;
      }
      if (fwd.length) { e.status = 'already-forwarded'; st.save(); say(`${e.hash}: already forwarded, skip`); continue; }
      const served = (q) => sent.some((x) => /^(fw|fwd):/i.test(x.subject || '') && (x.toRecipients || []).map(addr).includes(q.email) && Date.parse(x.sentDateTime) > Date.parse(q.at));
      const { requester, who } = pickRequester(rule, reqs, e.received, { served });
      const expired = Date.now() - Date.parse(e.received) > rule.windowMs;
      if (requester && !expired) { await forward(rule, st, e, requester.email, `${requester.via} request at ${hm(requester.at)}`, requester); continue; }
      if (expired) { e.status = 'expired'; st.save(); say(`${e.hash}: no single requester in the window, stopped watching`); continue; }
      if (e.status === 'new') {
        e.status = 'held'; st.save();
        tell(`A ${esc(rule.name)} mail arrived at ${hm(e.received)}; ${who.length ? `several people asked (${esc(who.map((q) => q.name).join(', '))})` : 'no one has asked'}. Holding it; tell me who should get it.`);
      }
    }
  }
  st.watermark = startedAt; st.save();
}
