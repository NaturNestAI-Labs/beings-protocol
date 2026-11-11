#!/usr/bin/env node
// Owner's browser session, read only: OneDrive/SharePoint files and Outlook/Teams web pages as text. GET-only API calls,
// no clicks, Microsoft 365 hosts only. Usage: README.md "owner-web".
import './oa-env.mjs';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readlinkSync, createWriteStream, chmodSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fail } from './graph.mjs';
import { preflight, ownerLane, settings } from './owner-session.mjs';
import { isM365Host, isLoginUrl, browserRequestAllowed } from './guards.mjs';
import { writeStamp } from './sessions.mjs';
import { logComms } from './comms-log.mjs';

const argv = process.argv.slice(2);
const opt = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const has = (f) => argv.includes(f);
const [cmd, arg] = argv;
const USAGE = 'usage: owner-web login [--being] | check [--being] | whoami [--being] [--stamp] | search <text> [--top N] | shared | '
  + 'ls <folder url> | get <url> [--save dir] | open <m365 url> [--wait S] [--shot f.png] [--max N]';
const SIGNIN = new Set(['login', 'check', 'whoami']);
if (!cmd || (!SIGNIN.has(cmd) && !['search', 'shared', 'ls', 'get', 'open'].includes(cmd))) fail(USAGE, 2);

// Sign-in commands run from owner-access-login (owner lane); read commands go through the full owner-access preflight.
let s;
if (SIGNIN.has(cmd)) {
  if (!ownerLane()) fail("blocked: only owner-lane runs may use the owner's browser (teammate lanes never)", 3);
  s = settings();
} else {
  s = preflight(cmd === 'open' ? 'owner_web_pages' : 'owner_files', { services: ['browser'] });
}
const role = SIGNIN.has(cmd) && has('--being') ? 'being' : 'owner';
const PROFILE = role === 'being' ? s.beingProfile : s.ownerProfile;
const expect = role === 'being' ? s.beingUpn : s.ownerUpn;
const web = s.cfg.owner_web || {};
const MY = (web.my_host || '').replace(/\/+$/, ''), ROOT = (web.root_host || '').replace(/\/+$/, '');
if (!isM365Host(MY) || !isM365Host(ROOT)) fail('set [owner_web] my_host and root_host in owner-access.toml (https://<org>-my.sharepoint.com, https://<org>.sharepoint.com)', 2);
const target = ['ls', 'get', 'open'].includes(cmd) ? arg : null;
if (target !== null && !isM365Host(target || '')) fail(`${cmd} is limited to https Microsoft 365 hosts`, 2);
const CHROME = web.chrome || process.env.OWNER_WEB_CHROME || 'google-chrome';

mkdirSync(PROFILE, { recursive: true, mode: 0o700 }); chmodSync(PROFILE, 0o700);
// SingletonLock points at host-pid; a live pid means another run holds the profile.
let lockPid = 0; try { lockPid = Number(readlinkSync(path.join(PROFILE, 'SingletonLock')).split('-').pop()); } catch {}
if (lockPid) { try { process.kill(lockPid, 0); fail(`browser busy (pid ${lockPid} holds the profile)`, 4); } catch (e) { if (e.code !== 'ESRCH') throw e; } }

// Playwright errors embed the call log (cookies): print the first line only.
const quiet = (e) => { console.error(String(e?.message || e).split('\n')[0]); process.exit(1); };
process.on('uncaughtException', quiet); process.on('unhandledRejection', quiet);
let chromium;
try { ({ chromium } = await import('playwright-core')); } catch { fail('playwright-core missing: npm install --prefix <kit> playwright-core', 1); }

const headless = cmd !== 'login';
// Outlook/Teams refuse the HeadlessChrome user agent; present the installed Chrome's version.
const major = (execFileSync(CHROME, ['--version']).toString().match(/(\d+)\./) || [])[1] || '130';
const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: execFileSync('sh', ['-c', 'command -v "$1"', '_', CHROME]).toString().trim() || CHROME,
  headless, acceptDownloads: false, viewport: headless ? { width: 1280, height: 900 } : null,
  userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
  args: ['--password-store=basic', '--no-first-run', '--no-default-browser-check'],
});
const done = async (code = 0) => { await ctx.close().catch(() => {}); process.exit(code); };
if (cmd !== 'login') await ctx.route('**/*', (r) => (browserRequestAllowed(r.request().method(), r.request().url(), r.request().postData() || '')
  ? r.fallback() : r.abort('blockedbyclient')));
const page = ctx.pages()[0] || await ctx.newPage();

// Visiting a host lets the saved sign-in mint that host's cookies silently.
const warm = async (origin) => {
  await page.goto(`${origin}/_layouts/15/viewlsts.aspx`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForURL((u) => !isLoginUrl(u.href), { timeout: 30000 }).catch(() => {});
  if (isLoginUrl(page.url())) { console.error(`signed out: run owner-access-login ${role} --browser`); await done(5); }
};
const api = async (url) => {
  const r = await ctx.request.get(url, { headers: { Accept: 'application/json;odata=nometadata' }, maxRedirects: 0 });
  if (!r.ok()) { console.error(`${r.status()} ${url.split('?')[0]}`); await done(1); }
  return r.json();
};
// Who-am-I for the browser session: the account SharePoint sees for these cookies.
const whoami = async () => {
  await warm(MY);
  const me = await api(`${MY}/_api/web/currentuser?$select=Email,UserPrincipalName`);
  const got = String(me.UserPrincipalName || me.Email || '').toLowerCase();
  if (got !== expect) { console.error(`browser session is ${got || 'unknown'}, not the ${role} (${expect}); refused`); await done(6); }
  return got;
};
const origin = (u) => new URL(u).origin;
const siteOf = (u) => { const p = new URL(u); const m = p.pathname.match(/^\/(sites|teams|personal)\/[^/]+/); return p.origin + (m ? m[0] : ''); };
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;

if (cmd === 'login') {
  await page.goto(`${MY}/`);
  console.log(`Sign in as the ${role} (${expect}) in this window, tick "Stay signed in", then close the window.`);
  await new Promise((r) => ctx.on('close', r));
  process.exit(0);
}
const who = await whoami();
if (cmd === 'check' || cmd === 'whoami') {
  if (has('--stamp')) writeStamp(s.state, { role, service: 'browser', account: who });
  console.log(`ok: ${role} browser session is ${who}`);
  await done();
}
logComms({ channel: 'owner-web', dir: 'in', kind: 'owner-read', command: cmd, target: target ? target.split('?')[0] : (cmd === 'search' ? arg : '') });

if (cmd === 'open') {
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(Number(opt('--wait') || 20) * 1000);
  if (isLoginUrl(page.url())) { console.error('signed out: run owner-access-login owner --browser'); await done(5); }
  if (opt('--shot')) await page.screenshot({ path: opt('--shot') });
  console.log(`# ${await page.title()}\n` + (await page.evaluate(() => document.body.innerText)).slice(0, Number(opt('--max') || 20000)));
} else if (cmd === 'search') {
  await warm(ROOT);
  const sel = "'Title,Path,Size,LastModifiedTime,FileType,IsContainer'";
  const j = await api(`${ROOT}/_api/search/query?querytext=${encodeURIComponent(lit(arg || ''))}&rowlimit=${Number(opt('--top') || 25)}&selectproperties=${encodeURIComponent(sel)}`);
  for (const row of j.PrimaryQueryResult?.RelevantResults?.Table?.Rows || []) {
    const c = Object.fromEntries(row.Cells.map((x) => [x.Key, x.Value]));
    console.log([c.IsContainer === 'true' ? 'dir ' : 'file', (c.LastModifiedTime || '').slice(0, 10), `${((c.Size || 0) / 1048576).toFixed(1)}MB`.padStart(8), c.Path].join('  '));
  }
} else if (cmd === 'shared') {
  const j = await api(`${MY}/_api/v2.0/me/drive/sharedWithMe`);
  for (const it of j.value || []) { const r = it.remoteItem || it; console.log([r.folder ? 'dir ' : 'file', (r.lastModifiedDateTime || '').slice(0, 10), r.webUrl].join('  ')); }
} else if (cmd === 'ls') {
  await warm(origin(target));
  const rel = decodeURIComponent(new URL(target).pathname);
  const base = `${siteOf(target)}/_api/web/GetFolderByServerRelativeUrl(${encodeURIComponent(lit(rel))})`;
  for (const f of (await api(`${base}/Folders`)).value) console.log(`dir   ${origin(target)}${f.ServerRelativeUrl}`);
  for (const f of (await api(`${base}/Files`)).value) console.log(`file  ${(f.TimeLastModified || '').slice(0, 10)}  ${(f.Length / 1048576).toFixed(1)}MB  ${origin(target)}${f.ServerRelativeUrl}`);
} else if (cmd === 'get') {
  await warm(origin(target));
  const u = new URL(target);
  // Sharing links (/:x:/...) take download=1; plain paths go through download.aspx.
  let url = /^\/:[a-z]:\//.test(u.pathname) ? (u.searchParams.set('download', '1'), u.href)
    : `${siteOf(target)}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(decodeURIComponent(u.pathname))}`;
  let r;
  // Redirects followed by hand so each host gets only its own cookies and never leaves Microsoft 365.
  for (let hop = 0; hop < 8; hop++) {
    if (!isM365Host(url)) { console.error('download redirected outside Microsoft 365; refused'); await done(2); }
    const cookie = (await ctx.cookies(url)).map((c) => `${c.name}=${c.value}`).join('; ');
    r = await fetch(url, { headers: { cookie }, redirect: 'manual' });
    if (r.status < 300 || r.status >= 400) break;
    url = new URL(r.headers.get('location'), url).href;
  }
  if (!r.ok) { console.error(`${r.status} download failed`); await done(1); }
  if (/text\/html/i.test(r.headers.get('content-type') || '') && !/\.html?$/i.test(u.pathname)) { console.error('got an HTML page, not the file (signed out?)'); await done(1); }
  const cd = r.headers.get('content-disposition') || '';
  const name = decodeURIComponent((cd.match(/filename\*=utf-8''([^;]+)/i) || cd.match(/filename="?([^";]+)/i) || [])[1] || path.basename(u.pathname) || 'download');
  const dir = opt('--save') || '.'; mkdirSync(dir, { recursive: true });
  const out = path.join(dir, path.basename(name));
  await pipeline(Readable.fromWeb(r.body), createWriteStream(out)); console.log(out);
}
await done();
