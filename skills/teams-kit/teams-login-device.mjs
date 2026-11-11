#!/usr/bin/env node
// Device-code sign-in for one identity into its own 0600 MSAL cache; refuses any other account.
// Usage: README.md "Script reference".
import { renameSync, unlinkSync } from 'node:fs';
import { userInfo } from 'node:os';
import { msal, fail } from './graph.mjs';
import { kitEnv, ownerMatch } from './kit-env.mjs';

const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i === -1 ? null : a[i + 1]; };
const UPN = (opt('--upn') || '').toLowerCase(), CACHE = opt('--cache');
if (!UPN || !CACHE) fail('usage: teams-login-device.mjs --upn <user@your-tenant> --cache <file> [--scopes a,b,c] [--add-scopes a,b]', 2);
const DEFAULT_SCOPES = ['Chat.ReadWrite', 'ChatMessage.Send', 'Chat.Create', 'User.Read', 'Files.ReadWrite',
  'Presence.ReadWrite', 'Mail.ReadWrite', 'Mail.Send'];
// --scopes narrows the grant, e.g. a read-mostly delegate sign-in for the owner.
// The owner's delegate sign-in is off unless BEING_OWNER_DELEGATE=1 is set in the kit's .env.
const kenv = kitEnv();
if (ownerMatch({ upn: UPN, cache: CACHE }, kenv)) {
  if (kenv.BEING_OWNER_DELEGATE !== '1') fail('REFUSED: owner sign-in is off. Read GUARDRAILS.md "Threat model", then set BEING_OWNER_DELEGATE=1 in .env', 2);
  const sameUser = !kenv.BEING_MODEL_USER || kenv.BEING_MODEL_USER === userInfo().username;
  console.error(`\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!! WARNING: signing in AS THE OWNER (${UPN}). This token can send as them.
!! ${sameUser ? 'The model runs as this OS user: a prompt-injected run can read this token. Use it only on a\n!! two-user host (GUARDRAILS.md "Threat model"); being-teams doctor will fail until then.' : `Keep ${CACHE} unreadable to ${kenv.BEING_MODEL_USER}; run being-teams doctor after sign-in.`}
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!\n`);
}
// --add-scopes extends the list with optional ones, e.g. User.ReadWrite (set-photo.mjs), ChannelMessage.Send
// (teams-channel.mjs) or Mail.Read.Shared (mail.mjs --mailbox).
const list = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
const SCOPES = [...new Set([...(opt('--scopes') ? list(opt('--scopes')) : DEFAULT_SCOPES), ...list(opt('--add-scopes'))])];

// Sign in into a temp cache and swap it in only on the right account: a wrong-account sign-in must never
// destroy the working identity.
const TMP = `${CACHE}.login-tmp`;
try { unlinkSync(TMP); } catch {}
const r = await msal(TMP).acquireTokenByDeviceCode({ scopes: SCOPES, deviceCodeCallback: (m) => console.log(`${m.message}\nUse a private window and "Use another account": sign in as ${UPN}, nobody else.`) });
const got = (r.account?.username || '').toLowerCase();
if (got !== UPN) {
  try { unlinkSync(TMP); } catch {}
  fail(`REFUSED: signed in as ${got}, expected ${UPN}. Existing sign-in left untouched.`, 2);
}
renameSync(TMP, CACHE);
console.log(`ok: ${got} (object id ${r.account?.localAccountId || 'see teams-read.mjs --whoami'})`);
