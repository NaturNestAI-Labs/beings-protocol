import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boxId, writeStamp, checkStamp, stampFile, separationProblems } from './sessions.mjs';

test('box id is stable per machine-id and never the raw id', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'oa-box-'));
  writeFileSync(path.join(d, 'a'), 'abc\n'); writeFileSync(path.join(d, 'b'), 'xyz\n');
  assert.equal(boxId(path.join(d, 'a')), boxId(path.join(d, 'a')));
  assert.notEqual(boxId(path.join(d, 'a')), boxId(path.join(d, 'b')));
  assert.ok(!boxId(path.join(d, 'a')).includes('abc'));
});

test('stamps: missing, wrong account, signed in on another box, ok', () => {
  const st = mkdtempSync(path.join(tmpdir(), 'oa-st-'));
  assert.match(checkStamp(st, 'owner', 'outlook', 'owner@example.com'), /not signed in/);
  writeStamp(st, { role: 'owner', service: 'outlook', account: 'Owner@example.com', box: 'here' });
  assert.equal(checkStamp(st, 'owner', 'outlook', 'owner@example.com', { box: 'here' }), null);
  assert.match(checkStamp(st, 'owner', 'outlook', 'someone@example.com', { box: 'here' }), /expected/);
  assert.match(checkStamp(st, 'owner', 'outlook', 'owner@example.com', { box: 'other' }), /another box/);
  assert.match(checkStamp(st, 'being', 'teams', 'being@example.com'), /not signed in/);
  assert.throws(() => writeStamp(st, { role: 'admin', service: 'teams', account: 'x' }), /bad session/);
  mkdirSync(path.dirname(stampFile(st, 'being', 'teams')), { recursive: true });
  writeFileSync(stampFile(st, 'being', 'teams'), '{oops');
  assert.match(checkStamp(st, 'being', 'teams', 'being@example.com'), /unreadable/);
});

test('separation: one cache, overlapping or misnamed profiles and one account are refused', () => {
  const d = mkdtempSync(path.join(tmpdir(), 'oa-sep-'));
  const ok = { beingCache: path.join(d, 'being-cache.json'), ownerCache: path.join(d, 'owner-cache.json'),
    beingProfile: path.join(d, 'being-browser'), ownerProfile: path.join(d, 'owner-browser'), beingUpn: 'being@example.com', ownerUpn: 'owner@example.com' };
  assert.deepEqual(separationProblems(ok), []);
  assert.match(separationProblems({ ...ok, ownerCache: ok.beingCache }).join(), /share one token cache/);
  assert.match(separationProblems({ ...ok, ownerUpn: 'BEING@example.com' }).join(), /same account/);
  assert.match(separationProblems({ ...ok, beingProfile: path.join(ok.ownerProfile, 'being-x') }).join(), /overlap/);
  assert.match(separationProblems({ ...ok, ownerProfile: path.join(d, 'browser') }).join(), /must start with owner-/);
  writeFileSync(ok.ownerCache, '{}', { mode: 0o644 });
  assert.match(separationProblems(ok).join(), /owner token cache is readable by others/);
});
