#!/usr/bin/env node
// owner-access doctor: abilities and pauses, both identities' sessions per service, separation of caches and profiles,
// and the same-box limit. Exit 1 on a hard problem; warnings alone exit 0.
import './oa-env.mjs';
import { userInfo } from 'node:os';
import { CONFIG_FILE, ABILITIES, loadConfig, abilityOn, paused } from './oa-config.mjs';
import { checkStamp, separationProblems } from './sessions.mjs';
import { kitEnv, ownerDelegate } from './kit-env.mjs';
import { settings } from './owner-session.mjs';
import { isM365Host } from './guards.mjs';

export const NEEDS = { owner_teams_read: ['teams'], owner_teams_send_approved: ['teams'], owner_mail_read: ['outlook'],
  owner_mail_send_approved: ['outlook'], owner_files: ['browser'], owner_web_pages: ['browser'], shared_mailbox_read: ['outlook'],
  shared_mailbox_drafts: ['outlook'], shared_mailbox_send: ['outlook'], channel_posts: ['teams'], mail_forward_rules: ['outlook', 'teams'],
  area_approvers: [] };

let cfg, bad = 0;
const say = (lvl, t) => { console.log(`${lvl.padEnd(4)} ${t}`); if (lvl === 'FAIL') bad++; };
try { cfg = loadConfig(); } catch (e) { say('FAIL', `${CONFIG_FILE}: ${e.message}`); process.exit(1); }
const env = kitEnv(), s = settings(cfg, env);
say(cfg.owner_access?.enabled === true ? 'on' : 'off', `owner access master switch (${CONFIG_FILE})`);
const on = Object.keys(ABILITIES).filter((a) => abilityOn(cfg, a));
for (const a of Object.keys(ABILITIES)) say(on.includes(a) ? (paused(s.state, a) ? 'PAUS' : 'on') : 'off', `${a}: ${ABILITIES[a]}`);
for (const p of separationProblems(s)) say('FAIL', p);
const services = [...new Set(on.flatMap((a) => NEEDS[a]))];
for (const svc of services) for (const [role, who] of [['being', s.beingUpn], ['owner', s.ownerUpn]]) {
  const p = checkStamp(s.state, role, svc, who);
  say(p ? 'WARN' : 'ok', p ? `${p}; abilities needing ${svc} stay blocked` : `${role} ${svc} session signed in on this box`);
}
// Browser abilities: the route fails at first use without playwright-core or with the example's placeholder hosts.
if (on.some((a) => NEEDS[a].includes('browser'))) {
  const hosts = ['my_host', 'root_host'].filter((k) => !isM365Host(cfg.owner_web?.[k] || ''));
  say(hosts.length ? 'FAIL' : 'ok', hosts.length ? `[owner_web] ${hosts.join(', ')} not set to your tenant's SharePoint address (owner-access.toml)` : '[owner_web] hosts set');
  let pw = true; try { await import('playwright-core'); } catch { pw = false; }
  say(pw ? 'ok' : 'FAIL', pw ? 'playwright-core installed' : 'playwright-core missing: npm install --prefix <kit> playwright-core');
}
if (on.some((a) => NEEDS[a].some((x) => x !== 'browser')) && !ownerDelegate(env)) say('WARN', 'API abilities are on but BEING_OWNER_DELEGATE=1 / OWNER_CACHE are not set in the kit .env');
// Same-box limit: on one OS user, anything running as the Being can read the owner's token cache and browser profile.
if (on.length && (!env.BEING_MODEL_USER || env.BEING_MODEL_USER === userInfo().username)) {
  say('WARN', 'same-box limit: the model runs as the kit user, so a run could read the owner\'s sessions directly. '
    + 'The checks stop mistakes, not a determined prompt injection. Use the two-user layout (teams-kit isolation/).');
}
process.exit(bad ? 1 : 0);
