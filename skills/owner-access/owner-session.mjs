// The only way owner-access scripts reach the owner's sessions. Built on graph.mjs; opens the owner cache or browser
// profile only for the approved scripts below, after the ability, pause, lane, sign-in and who-am-I checks.
import './oa-env.mjs';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { connect, fail, standby } from './graph.mjs';
import { kitEnv, ownerDelegate, mailCache } from './kit-env.mjs';
import { currentScope } from './scope.mjs';
import { logComms } from './comms-log.mjs';
import { KIT, loadConfig, abilityOn, paused, pauseFile, approversFor } from './oa-config.mjs';
import { checkGo, readGo, usedGos, markUsed, approvalAgeError } from './go-approval.mjs';
import { SCOPES, checkStamp, separationProblems } from './sessions.mjs';

export const APPROVED_SCRIPTS = new Set(['owner-web.mjs', 'shared-mailbox-drafts.mjs', 'shared-inbox-monitor.mjs',
  'channel-posts.mjs', 'mail-forward-rules.mjs']);
const WRITES = new Set(['shared_mailbox_drafts', 'shared_mailbox_send', 'channel_posts', 'mail_forward_rules']);

const real = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

export function settings(cfg = loadConfig(), env = kitEnv()) {
  const state = env.BEING_STATE_DIR || path.join(KIT, 'state');
  const prof = (v, d) => { const p = v || d; return path.isAbsolute(p) ? p : path.join(KIT, p); };
  return {
    state, env, cfg,
    beingUpn: (env.BEING_UPN || '').toLowerCase(), ownerUpn: (env.OWNER_UPN || '').toLowerCase(),
    beingCache: env.BEING_CACHE || '', ownerCache: env.OWNER_CACHE || '',
    beingProfile: prof(cfg.owner_access?.being_browser_profile || env.BEING_BROWSER_PROFILE, 'state/being-browser'),
    ownerProfile: prof(cfg.owner_access?.owner_browser_profile || env.OWNER_BROWSER_PROFILE, 'state/owner-browser'),
  };
}

// Owner lane = a valid handler grant of full, owner-only or routine scope. Teammate grants, bad grants and no grant: refused.
export function ownerLane(scope = currentScope()) {
  return scope.why === 'grant' && (['full', 'owner-only'].includes(scope.scope) || scope.scope.startsWith('routine:'));
}

// Checks that need no network. Returns { s } or exits: 2 caller, 3 lane, 4 ability off, 5 paused, 6 sign-in missing.
export function preflight(ability, { services, caller = process.argv[1] } = {}) {
  const name = path.basename(caller || '');
  if (!APPROVED_SCRIPTS.has(name) || real(path.dirname(caller)) !== real(KIT)) fail(`blocked: ${name || 'this process'} may not open the owner's sessions`, 2);
  if (!ownerLane()) fail("blocked: only owner-lane runs may use the owner's sessions (teammate lanes never)", 3);
  const s = settings();
  if (!abilityOn(s.cfg, ability)) fail(`owner access "${ability}" is off; switch it on in owner-access.toml`, 4);
  if (paused(s.state, ability)) fail(`owner access "${ability}" is paused (${pauseFile(s.state, ability)})`, 5);
  if (WRITES.has(ability) && standby()) fail('standby host: as-owner actions disabled', 3);
  const sep = separationProblems(s);
  if (sep.length) fail(`blocked: ${sep.join('; ')}`, 6);
  if (!s.beingUpn || !s.ownerUpn) fail('BEING_UPN and OWNER_UPN must be set in the kit .env', 6);
  for (const svc of services) {
    for (const [role, who] of [['being', s.beingUpn], ['owner', s.ownerUpn]]) {
      const p = checkStamp(s.state, role, svc, who);
      if (p) fail(`owner access stays off until both sessions are signed in: ${p}`, 6);
    }
  }
  if (services.some((x) => x !== 'browser') && !ownerDelegate(s.env)) fail('owner API sign-in is off (BEING_OWNER_DELEGATE=1 and OWNER_CACHE in the kit .env)', 6);
  return s;
}

// Opens the sessions an ability needs. API services: a who-am-I (/me) for the Being and the owner per service, each from
// its own cache. ownerScopes: extra owner scopes per service; guards.mjs wraps the owner's token for each call.
export async function openOwnerAccess(ability, { services, ownerScopes = {} } = {}) {
  const s = preflight(ability, { services });
  const out = { s, being: {}, owner: {} };
  for (const svc of services.filter((x) => x !== 'browser')) {
    const bc = svc === 'outlook' ? (mailCache('being', s.env) || s.beingCache) : s.beingCache;
    const oc = svc === 'outlook' ? (mailCache('owner', s.env) || s.ownerCache) : s.ownerCache;
    out.being[svc] = await connect({ upn: s.beingUpn, cache: bc, scopes: SCOPES.being[svc] });
    const scopes = [...new Set([...SCOPES.owner[svc], ...(ownerScopes[svc] || [])])];
    out.owner[svc] = await connect({ upn: s.ownerUpn, cache: oc, scopes });
  }
  return out;
}

// Every as-owner action: one comms-log line (kind as-owner) and a short report to the owner from the Being's account.
export function logAsOwner(ability, entry) {
  logComms({ channel: entry.channel || 'owner-access', dir: 'out', ...entry, kind: 'as-owner', ability });
}
export function reportToOwner(s, html) {
  const chat = s.cfg.owner_access?.report_chat;
  const r = spawnSync('node', [path.join(KIT, 'teams-send-dm.mjs'), '--verbatim', ...(chat ? ['--chat', chat] : [])],
    { input: `<p>${html}</p>`, stdio: ['pipe', 'ignore', 'inherit'], timeout: 60000 });
  if (r.status !== 0) console.error('owner report failed; the action is in the comms log');
  return r.status === 0;
}

export const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// The Being's own Teams session (who-am-I checked), for reading its chats and go messages.
export const beingTeams = (s) => connect({ upn: s.beingUpn, cache: s.beingCache, scopes: SCOPES.being.teams });

// Checks a "go" typed by an approver for `area` in their 1:1 with the Being, read with the Being's own Teams session.
// Marks it used, so one go approves one action. Exits 3 when it does not check out.
export async function requireGo(s, { area, expect, chatId, msgId, notBefore, verify, receipt = false }) {
  if (!chatId || !msgId) fail(`needs --go-chat <chat id> --go-msg <message id> of "${expect}" typed by an approver`, 2);
  const being = await beingTeams(s);
  let got;
  try { got = await readGo(being.g, chatId, msgId); } catch (e) { fail(`go message unreadable: ${e.message}`, 3); }
  const r = checkGo({ ...got, beingUpn: s.beingUpn, approvers: approversFor(s.cfg, area, s.ownerUpn), expect,
    used: usedGos(s.state), notBefore });
  if (r.error) fail(`blocked: ${r.error}; nothing done`, 3);
  if (verify) await verify({ ...got, g: being.g });
  markUsed(s.state, msgId);
  if (!receipt) return r.approver;
  return { approver: r.approver, assertFresh() {
    const error = approvalAgeError(got.msg.createdDateTime);
    if (error) throw new Error(error);
  }, async recheck() {
    const current = await readGo(being.g, chatId, msgId);
    const checked = checkGo({ ...current, beingUpn: s.beingUpn, approvers: approversFor(s.cfg, area, s.ownerUpn), expect, notBefore });
    if (checked.error) throw new Error(checked.error);
    if (current.msg.createdDateTime !== got.msg.createdDateTime) throw new Error('approval changed');
    if (verify) await verify({ ...current, g: being.g });
  } };
}
