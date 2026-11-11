#!/usr/bin/env node
// whoami.mjs --upn <upn> --cache <file> --scopes a,b [--label <text>]: check one headless session signs in silently,
// with those scopes, as exactly that account (never "first account in cache"). Used by verify.sh. Never sends.
import { connect, fail } from './graph.mjs';

const args = process.argv.slice(2);
const opt = (f) => { const i = args.indexOf(f); return i === -1 ? '' : args[i + 1] || ''; };
const upn = opt('--upn'), cache = opt('--cache'), label = opt('--label') || 'session';
const scopes = opt('--scopes').split(',').map((s) => s.trim()).filter(Boolean);
if (!upn || !cache || !scopes.length) fail('usage: whoami.mjs --upn <upn> --cache <file> --scopes a,b [--label <text>]', 2);
const { me } = await connect({ upn, cache, scopes });
console.log(`${label}: signed in as ${me.userPrincipalName} (${scopes.filter((s) => s !== 'User.Read').join(', ')})`);
