import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseValue, kitEnv, ownerMatch, ownerDelegate } from './kit-env.mjs';

const dir = () => mkdtempSync(path.join(tmpdir(), 'kitenv-'));
const envFile = (lines) => { const f = path.join(dir(), '.env'); writeFileSync(f, lines.join('\n')); return f; };

test('values parse the way bash sources them', () => {
  assert.equal(parseValue(`'Sam O'\\''Brien'   # owner`), "Sam O'Brien");
  assert.equal(parseValue(`"A \\"q\\" \\$HOME"`), 'A "q" $HOME');
  assert.equal(parseValue('nova                 # name'), 'nova');
  assert.equal(parseValue(''), '');
  const e = kitEnv(envFile(["OWNER_NAME='Sam O'\\''Brien & Co'", 'OWNER_UPN=Sam@Example.test  # x', 'export BEING_OWNER_DELEGATE=1']));
  assert.deepEqual([e.OWNER_NAME, e.OWNER_UPN, e.BEING_OWNER_DELEGATE], ["Sam O'Brien & Co", 'Sam@Example.test', '1']);
});

test('owner delegate sign-in is off unless explicitly enabled', () => {
  assert.equal(ownerDelegate({ OWNER_CACHE: '/x/owner.json' }), false);
  assert.equal(ownerDelegate({ BEING_OWNER_DELEGATE: '1' }), false);
  assert.equal(ownerDelegate({ BEING_OWNER_DELEGATE: '1', OWNER_CACHE: '/x/owner.json' }), true);
  assert.equal(ownerDelegate(kitEnv(envFile(['BEING_OWNER_DELEGATE=0', 'OWNER_CACHE=/x/owner.json']))), false);
});

test('owner identity matches by UPN, cache path (realpath) or object id', () => {
  const d = dir(), cache = path.join(d, 'owner.json'), link = path.join(d, 'link.json'), copy = path.join(d, 'copy.json');
  writeFileSync(cache, '{}'); symlinkSync(cache, link); copyFileSync(cache, copy);
  const env = { OWNER_UPN: 'sam@example.test', OWNER_CACHE: cache, OWNER_OID: 'aaaa-1' };
  assert.equal(ownerMatch({ upn: ' SAM@example.test ' }, env), 'upn');
  assert.equal(ownerMatch({ upn: 'nova@example.test', cache: link }, env), 'cache');
  assert.equal(ownerMatch({ upn: 'nova@example.test', cache: path.join(d, '.', 'owner.json') }, env), 'cache');
  assert.equal(ownerMatch({ oid: 'AAAA-1' }, env), 'oid');
  assert.equal(ownerMatch({ upn: 'nova@example.test', cache: copy, oid: 'bbbb-2' }, env), null);
});
