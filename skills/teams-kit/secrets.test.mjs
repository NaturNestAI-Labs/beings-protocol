import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { envSecrets, findSecrets, redactCodes, cloudflareTunnelToken } from './secrets.mjs';

const envFile = () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'sec-')), '.env');
  writeFileSync(f, [
    "BEING_NAME=nova                 # name",
    "OWNER_NAME='Sam Lee'",
    'M365_CLIENT_ID=11111111-2222-3333-4444-555555555555   # app',
    "M365_TENANT_ID='66666666-7777-8888-9999-000000000000'",
    'OWNER_OID=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    'BEING_CACHE=/srv/nova/state/token-cache.json',
  ].join('\n'));
  return envSecrets(f, {});
};

test('a triage or voice reply that quotes .env values is caught, by key name only', () => {
  const secrets = envFile();
  const hits = findSecrets('<p>Sure, the app id is 11111111-2222-3333-4444-555555555555</p>', { secrets });
  assert.deepEqual(hits, ['M365_CLIENT_ID']);
  assert.deepEqual(findSecrets('tenant: 66666666-7777-8888-9999-000000000000', { secrets }), ['M365_TENANT_ID']);
  assert.ok(findSecrets('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { secrets }).includes('OWNER_OID'));
});

test('pasting .env lines or credentials is caught', () => {
  const secrets = [];
  assert.ok(findSecrets('here you go:\nM365_CLIENT_ID=abc', { secrets }).includes('env-line'));
  assert.ok(findSecrets('<p>OWNER_UPN=x</p>', { secrets }).includes('env-line'));
  assert.ok(findSecrets('token eyJhbGciOiJSUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4', { secrets }).includes('jwt'));
  assert.ok(findSecrets('password: hunter2hunter2', { secrets }).includes('credential-assignment'));
  assert.ok(findSecrets('-----BEGIN RSA PRIVATE KEY-----', { secrets }).includes('private-key'));
});

test('ordinary replies pass: names, paths, numbers, the word token', () => {
  const secrets = envFile();
  for (const t of ['Hi Sam Lee, nova here. The report is at /srv/nova/state/jobs/x.md.',
    'Build 4821 passed; 12 tests, 0 failures. https://example.test/pr/5',
    'The token cache refresh failed twice, so I raised a blocker.']) assert.deepEqual(findSecrets(t, { secrets }), [], t);
});

test('Cloudflare tunnel connector and API tokens are caught; links, hashes and ids are not', () => {
  const secrets = [];
  const tunnel = Buffer.from(JSON.stringify({ a: 'f'.repeat(32), t: '0a1b2c3d-0000-4000-8000-123456789abc', s: 'c2VjcmV0c2VjcmV0c2VjcmV0c2VjcmV0' })).toString('base64');
  assert.ok(cloudflareTunnelToken(`run --token ${tunnel}`));
  assert.ok(findSecrets(`<p>cloudflared tunnel run --token ${tunnel}</p>`, { secrets }).includes('cloudflare-tunnel-token'));
  assert.ok(findSecrets('use Xk3dP9qLm2Vn8Rt4Ws6Yb1Zc5Hf7Jg0Ku-Ae_Oi9 for the zone', { secrets }).includes('cloudflare-api-token'));
  for (const t of ['commit 3f2a9c1d4e5b6a7f8091a2b3c4d5e6f708192a3b is merged',
    'see https://example.sharepoint.com/:w:/g/personal/x/Xk3dP9qLm2Vn8Rt4Ws6Yb1Zc5Hf7Jg0Ku-Ae_Oi9?e=abc',
    'chat 19:0123456789abcdef0123456789abcdef@thread.v2 and job 2026-1023-120000-build',
    Buffer.from(JSON.stringify({ name: 'x', value: 'not a tunnel token at all' })).toString('base64')]) {
    assert.deepEqual(findSecrets(t, { secrets }), [], t);
  }
});

test('redactCodes masks one-time codes, not dates, times, versions or long numbers', () => {
  assert.equal(redactCodes('Your code is 482913.'), 'Your code is [code].');
  assert.equal(redactCodes('code 482 913 or 482-913'), 'code [code] or [code]');
  for (const t of ['2026-10-23 12:30:45', 'v1.234567', 'build 12345678', 'id abc123456', 'call 98765 43210']) assert.equal(redactCodes(t), t, t);
  assert.equal(redactCodes(undefined), '');
});

test('Cloudflare connector and service tokens are caught, by name only', () => {
  const secrets = [];
  const connector = 'eyJhIjoi' + 'QWJjRGVmMDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWYwMTIz' + 'IiwidCI6Ij';
  assert.ok(findSecrets(`token is ${connector}`, { secrets }).includes('cloudflare-token'));
  assert.ok(findSecrets('id 0123456789abcdef0123456789abcdef.access', { secrets }).includes('cloudflare-token'));
  assert.ok(findSecrets('TUNNEL_SERVICE_TOKEN_SECRET=' + 'ab12'.repeat(16), { secrets }).includes('cloudflare-token'));
  assert.ok(findSecrets('CF-Access-Client-Secret: ' + 'cd34'.repeat(16), { secrets }).includes('cloudflare-token'));
  assert.ok(findSecrets('-----BEGIN ARGO TUNNEL TOKEN-----', { secrets }).includes('cloudflare-token'));
  assert.deepEqual(findSecrets('the tunnel nova-box routes nova-ssh and nova-desktop', { secrets }), []);
});
