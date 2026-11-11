import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToml, abilityOn, paused, pauseFile, approversFor, ABILITIES } from './oa-config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('parseToml: tables, arrays of tables, multi-line arrays, comments and # inside strings', () => {
  const t = parseToml(`# top
[owner_access]
enabled = true   # on
name = "a # not a comment"
lit = 'x\\y'
[abilities]
owner_files = true
[[forward_rules]]
name = "one"
subject_patterns = [
  "sign in",   # first
  "code",
]
window_hours = 3
[[forward_rules]]
name = "two"
`);
  assert.equal(t.owner_access.enabled, true);
  assert.equal(t.owner_access.name, 'a # not a comment');
  assert.equal(t.owner_access.lit, 'x\\y');
  assert.deepEqual(t.forward_rules.map((r) => r.name), ['one', 'two']);
  assert.deepEqual(t.forward_rules[0].subject_patterns, ['sign in', 'code']);
  assert.equal(t.forward_rules[0].window_hours, 3);
  assert.throws(() => parseToml('x = "open'), /unterminated/);
  assert.throws(() => parseToml('just words'), /expected key/);
});

test('the shipped example parses and every ability is present and off', () => {
  const t = parseToml(readFileSync(path.join(HERE, 'owner-access.toml.example'), 'utf8'));
  assert.equal(t.owner_access.enabled, false);
  assert.deepEqual(Object.keys(t.abilities).sort(), Object.keys(ABILITIES).sort());
  for (const v of Object.values(t.abilities)) assert.equal(v, false);
  assert.match(t.owner_access.owner_browser_profile, /owner-browser$/);
  assert.match(t.owner_access.being_browser_profile, /being-browser$/);
});

test('abilityOn needs the master switch and the ability, both literally true', () => {
  assert.equal(abilityOn({ owner_access: { enabled: true }, abilities: { owner_files: true } }, 'owner_files'), true);
  assert.equal(abilityOn({ owner_access: { enabled: false }, abilities: { owner_files: true } }, 'owner_files'), false);
  assert.equal(abilityOn({ owner_access: { enabled: true }, abilities: { owner_files: 'true' } }, 'owner_files'), false);
  assert.equal(abilityOn({}, 'owner_files'), false);
  assert.throws(() => abilityOn({}, 'send_anything'), /unknown ability/);
});

test('pause file: empty = paused, future time = paused, past time = running', () => {
  const st = mkdtempSync(path.join(tmpdir(), 'oa-pause-'));
  assert.equal(paused(st, 'owner_files'), false);
  mkdirSync(path.dirname(pauseFile(st, 'owner_files')), { recursive: true });
  writeFileSync(pauseFile(st, 'owner_files'), '');
  assert.equal(paused(st, 'owner_files'), true);
  writeFileSync(pauseFile(st, 'owner_files'), new Date(Date.now() + 3600e3).toISOString());
  assert.equal(paused(st, 'owner_files'), true);
  writeFileSync(pauseFile(st, 'owner_files'), new Date(Date.now() - 3600e3).toISOString());
  assert.equal(paused(st, 'owner_files'), false);
});

test('approvers: the owner always; named people only with area_approvers on, only for their area', () => {
  const cfg = { owner_access: { enabled: true }, abilities: {}, approvers: { sales: ['Lead@Example.com'] } };
  assert.deepEqual([...approversFor(cfg, 'sales', 'Owner@example.com')], ['owner@example.com']);
  cfg.abilities.area_approvers = true;
  assert.deepEqual([...approversFor(cfg, 'sales', 'owner@example.com')].sort(), ['lead@example.com', 'owner@example.com']);
  assert.deepEqual([...approversFor(cfg, 'channels', 'owner@example.com')], ['owner@example.com']);
});
