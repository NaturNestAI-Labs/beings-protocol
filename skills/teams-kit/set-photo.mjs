#!/usr/bin/env node
// Set the Being's own Microsoft 365 / Teams profile photo: set-photo.mjs <image.jpg|png> (up to 4 MB).
// Needs User.ReadWrite in the Being's sign-in: teams-login-device.mjs --add-scopes User.ReadWrite. Owner lane only.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { connect, fail, standby, beingSender } from './graph.mjs';
import { currentScope } from './scope.mjs';

const file = process.argv[2];
if (!file || !existsSync(file) || !statSync(file).isFile() || statSync(file).size > 4 * 1024 * 1024) fail('usage: set-photo.mjs <image.jpg|png> (file up to 4 MB)', 2);
const bytes = readFileSync(file);
const type = bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ? 'image/png'
  : bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ? 'image/jpeg' : null;
if (!type) fail('the photo must be a PNG or JPEG', 2);
const SENDER = beingSender();
if (standby()) fail('standby host: disabled', 3);
const { scope } = currentScope();
if (!['full', 'owner-only'].includes(scope)) fail(`blocked: ${scope.split(':')[0]} runs may not change the Being's profile`, 3);
const { me, tokenFor } = await connect({ ...SENDER, sender: true, scopes: ['User.Read'] });
let token;
try { token = await tokenFor(['User.ReadWrite']); } catch (e) { fail(`no User.ReadWrite consent (teams-login-device.mjs --add-scopes User.ReadWrite): ${e.message}`); }
const auth = { Authorization: `Bearer ${token}` };
const r = await fetch('https://graph.microsoft.com/v1.0/me/photo/$value', { method: 'PUT', headers: { ...auth, 'Content-Type': type }, body: bytes });
if (!r.ok) fail(`${r.status} ${(await r.text()).slice(0, 300)}`);
const meta = await fetch('https://graph.microsoft.com/v1.0/me/photo', { headers: auth }).then((x) => x.json()).catch(() => ({}));
console.log(`photo set for ${me.userPrincipalName}${meta.width ? `: ${meta.width}x${meta.height}` : ''}`);
