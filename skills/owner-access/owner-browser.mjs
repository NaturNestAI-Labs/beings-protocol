// Browser route: opens the owner's browser profile headless (preflight already passed), with a request guard on every
// page request, and checks who is signed in before anything else happens.
import { execFileSync } from 'node:child_process';
import { readlinkSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { isLoginUrl, guardedGraph, OUTLOOK_API } from './guards.mjs';
import { pickOutlookToken, outlookCall } from './browser-route.mjs';

export async function launchOwnerBrowser(s, { guard }) {
  const profile = s.ownerProfile;
  mkdirSync(profile, { recursive: true, mode: 0o700 }); chmodSync(profile, 0o700);
  // SingletonLock points at host-pid; a live pid means another run holds the profile.
  let pid = 0; try { pid = Number(readlinkSync(path.join(profile, 'SingletonLock')).split('-').pop()); } catch {}
  if (pid) { try { process.kill(pid, 0); throw new Error(`browser busy (pid ${pid} holds the owner profile)`); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  let chromium;
  try { ({ chromium } = await import('playwright-core')); } catch { throw new Error('playwright-core missing: npm install --prefix <kit> playwright-core'); }
  const chrome = s.cfg.owner_web?.chrome || process.env.OWNER_WEB_CHROME || 'google-chrome';
  const exe = execFileSync('sh', ['-c', 'command -v "$1"', '_', chrome]).toString().trim();
  const major = (execFileSync(exe, ['--version']).toString().match(/(\d+)\./) || [])[1] || '130';
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: exe, headless: true, acceptDownloads: false, viewport: { width: 1400, height: 1000 },
    userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    args: ['--password-store=basic', '--no-first-run', '--no-default-browser-check'],
  });
  await ctx.route('**/*', (r) => (guard(r.request().method(), r.request().url(), r.request().postData() || '') ? r.fallback() : r.abort('blockedbyclient')));
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page, close: () => ctx.close().catch(() => {}) };
}

// Who-am-I for the browser session: the account SharePoint sees for these cookies must be the owner.
export async function sharePointWhoAmI(ctx, origin, expect) {
  const r = await ctx.request.get(`${origin}/_api/web/currentuser?$select=Email,UserPrincipalName`, { headers: { Accept: 'application/json;odata=nometadata' }, maxRedirects: 0 });
  if (!r.ok()) throw new Error(`browser who-am-I failed (HTTP ${r.status()}); sign in again: owner-access-login owner --browser`);
  const me = await r.json(), got = String(me.UserPrincipalName || me.Email || '').toLowerCase();
  if (got !== String(expect).toLowerCase()) throw new Error(`browser session is ${got || 'unknown'}, not the owner; refused`);
}

// Shared mailbox through Outlook web: borrows the web app's own token for the mailbox scope (the page is closed at once),
// checks /me is the owner, and returns a Graph-shaped client limited by `allow` (guards.draftsRoute with OUTLOOK_API).
export async function outlookFromBrowser(s, { mailbox, scope, allow, browserGuard }) {
  const b = await launchOwnerBrowser(s, { guard: browserGuard });
  let entries;
  try {
    // The Drafts view, so loading the page never opens (and marks read) an inbox message.
    await b.page.goto(`https://outlook.office.com/mail/${encodeURIComponent(mailbox)}/drafts`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await b.page.waitForTimeout(15000);
    if (isLoginUrl(b.page.url())) throw new Error('signed out of Outlook web: owner-access-login owner --browser');
    entries = await b.page.evaluate(() => Object.keys(localStorage).filter((k) => /accesstoken/i.test(k)).map((k) => [k, localStorage.getItem(k)]));
  } finally { await b.close(); }
  const token = pickOutlookToken(entries, scope);
  if (!token) throw new Error(`Outlook web has no token for ${scope}; open the shared mailbox once in Outlook web as the owner`);
  const call = outlookCall(guardedGraph(token, allow, fetch, OUTLOOK_API));
  const me = await call('/me');
  if (String(me.emailAddress || '').toLowerCase() !== s.ownerUpn) throw new Error(`Outlook web session is ${me.emailAddress || 'unknown'}, not the owner; refused`);
  return call;
}
