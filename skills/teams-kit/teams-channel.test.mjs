// teams-channel.mjs: rendering and guards, paging, roles per channel type, file cards, offline dry run, posting gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { render, collect, listChannels, attachmentCard, parseArgs } from './teams-channel.mjs';

const CLI = fileURLToPath(new URL('./teams-channel.mjs', import.meta.url));

test('markdown renders; empty bodies, secrets and approval prompts are refused', () => {
  assert.match(render('**Hello**\n\n[Doc](https://example.com/a)', 'Topic').body.content, /<b>Hello<\/b>/);
  assert.equal(render('hello', 'Topic').subject, 'Topic');
  assert.throws(() => render('  '), /empty/);
  assert.throws(() => render('-----BEGIN RSA PRIVATE KEY-----'), /secrets/);
  assert.throws(() => render('Draft D2 · fingerprint 0123456789ab'), /draft-for-owner/);
});

test('paging follows nextLink; options parse strictly', async () => {
  const pages = { '/a': { value: [1], '@odata.nextLink': '/b' }, '/b': { value: [2] } };
  assert.deepEqual(await collect(async (u) => pages[u], '/a', []), [1, 2]);
  assert.deepEqual(parseArgs(['post', '--team', 't', '--channel', 'c', '--dry-run']), { command: 'post', o: { team: 't', channel: 'c', dryRun: true } });
  assert.throws(() => parseArgs(['post', '--team']), /incomplete/);
  assert.throws(() => parseArgs(['post', '--bogus', 'x']), /unknown/);
});

test('team roles for standard channels, channel membership for private ones; owners first', async () => {
  const replies = {
    '/me/joinedTeams': [{ id: 't', displayName: 'Team' }],
    '/teams/t/members': [{ userId: 'me', roles: ['owner'] }],
    '/teams/t/channels': [{ id: 'b', displayName: 'Private', membershipType: 'private' }, { id: 'a', displayName: 'General', membershipType: 'standard' }],
    '/teams/t/channels/b/members': [{ userId: 'me', roles: [] }],
  };
  const rows = await listChannels(async (u) => ({ value: replies[u] }), { id: 'me' });
  assert.deepEqual(rows.map((r) => [r.channelName, r.channelRoles]), [['General', ['owner']], ['Private', []]]);
});

test('file card reuses the eTag GUID and WebDAV URL; http and credentials in the URL are refused', async () => {
  const card = await attachmentCard(async (url, scopes) => {
    assert.match(url, /^\/shares\/u!/); assert.deepEqual(scopes, ['Files.ReadWrite']);
    return { name: 'file.pdf', eTag: '"{12345678-1234-1234-1234-123456789abc},1"', webDavUrl: 'https://example.com/file.pdf' };
  }, 'https://example.com/share');
  assert.deepEqual(card, { id: '12345678-1234-1234-1234-123456789abc', contentType: 'reference', contentUrl: 'https://example.com/file.pdf', name: 'file.pdf' });
  await assert.rejects(attachmentCard(async () => ({}), 'https://example.com/share'), /eTag/);
  await assert.rejects(attachmentCard(async () => ({}), 'http://example.com/share'), /https/);
});

test('dry run works offline; a real post is refused before sign-in unless switched on with a full grant', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [CLI, ...args], { input: 'Hello', encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const dry = run(['post', '--dry-run', '--subject', 'Test']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).htmlBytes, 12);
  const off = run(['post', '--team', 't', '--channel', 'c']);
  assert.equal(off.status, 3); assert.match(off.stderr, /BEING_CHANNEL_POST/);
  assert.equal(run(['bogus']).status, 2);
});
