// link-guard.mjs and drive-util.mjs: anyone-link detection and sweep, paths, sharing limits, chunked upload (Graph mocked).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { directLinks, anonymousLinks, sweep } from './link-guard.mjs';
import { enc, itemPath, safeSegment, shareRefusal, uploadFile, grantee } from './drive-util.mjs';

const perms = [
  { id: 'u', roles: ['write'], grantedToV2: { user: { email: 'o@example.test' } } },
  { id: 'a', roles: ['write'], link: { scope: 'anonymous', type: 'edit' } },
  { id: 'o', roles: ['read'], link: { scope: 'organization', type: 'view' } },
  { id: 'i', roles: ['read'], link: { scope: 'anonymous', type: 'view' }, inheritedFrom: { id: 'parent' } },
];

test('only direct anyone-links count', () => {
  assert.deepEqual(directLinks(perms).map((p) => p.id), ['a', 'o']);
  assert.deepEqual(anonymousLinks(perms).map((p) => p.id), ['a']);
  assert.deepEqual(anonymousLinks([]), []);
  assert.equal(grantee(perms[0]), 'o@example.test'); assert.equal(grantee(perms[1]), 'anonymous');
});

const drive = () => {
  const items = { root: { id: 'root', folder: {} }, f1: { id: 'f1', name: 'Docs', folder: {} }, x: { id: 'x', name: 'a.pdf' }, y: { id: 'y', name: 'b.pdf' } };
  const kids = { root: ['f1', 'y'], f1: ['x'] };
  const perm = { root: [], f1: [], x: [perms[1], perms[3]], y: [perms[2]] };
  const deleted = [];
  const g = async (url, { method } = {}) => {
    if (method === 'DELETE') { deleted.push(url); return {}; }
    if (url === '/me/drive/root') return items.root;
    let m = /^\/me\/drive\/items\/(\w+)\/children/.exec(url); if (m) return { value: (kids[m[1]] || []).map((k) => items[k]) };
    m = /^\/me\/drive\/items\/(\w+)\/permissions$/.exec(url); if (m) return { value: perm[m[1]] };
    throw new Error(`unexpected ${url}`);
  };
  return { g, deleted };
};

test('sweep reports anyone-links and removes them only with strip', async () => {
  let d = drive();
  const r = await sweep(d.g, {});
  assert.equal(r.checked, 4);
  assert.deepEqual(r.found, [{ path: '/Docs/a.pdf', type: 'edit', removed: false }]);
  assert.equal(d.deleted.length, 0);
  d = drive();
  assert.deepEqual((await sweep(d.g, { strip: true })).found.map((f) => f.removed), [true]);
  assert.deepEqual(d.deleted, ['/me/drive/items/x/permissions/a']);
  await assert.rejects(sweep(drive().g, { max: 2 }), /narrow --path/);
});

test('paths are encoded per segment; topic names lose characters OneDrive refuses', () => {
  assert.equal(enc('/Shared/Q3 plan/a#b.pdf'), 'Shared/Q3%20plan/a%23b.pdf');
  assert.equal(itemPath('/'), '/me/drive/root'); assert.equal(itemPath('Shared/x'), '/me/drive/root:/Shared/x');
  assert.equal(safeSegment(' ../Plan: v2/final? '), '-Plan- v2-final-');
  assert.ok(!safeSegment('a/../b').includes('/'));
});

test('scoped runs share only with the owner and their chat members; full runs with anyone', () => {
  assert.equal(shareRefusal(['x@example.test'], { scope: 'full', owner: 'sam@example.test' }), null);
  assert.equal(shareRefusal(['Kim@example.test', 'sam@example.test'], { scope: 'chats:c1', owner: 'sam@example.test', chatMembers: ['kim@example.test'] }), null);
  assert.match(shareRefusal(['pat@example.test'], { scope: 'chats:c1', owner: 'sam@example.test', chatMembers: ['kim@example.test'] }), /not pat@example\.test/);
  assert.match(shareRefusal(['sam@example.test'], { scope: 'none', owner: 'sam@example.test' }), /not valid/);
});

test('uploadFile sends 320 KiB-aligned ranges, retries 5xx, and reports conflicts', async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'up-')), 'f.bin'); writeFileSync(f, Buffer.alloc(700 * 1024, 1));
  const ranges = []; let fails = 1;
  const g = async (url, { body }) => { assert.match(url, /^\/me\/drive\/root:\/Shared\/f\.bin:\/createUploadSession$/); assert.equal(body.item['@microsoft.graph.conflictBehavior'], 'fail'); return { uploadUrl: 'https://upload.example.test/s' }; };
  const fetchFn = async (url, { headers }) => {
    if (fails-- > 0) return { ok: false, status: 503, text: async () => 'busy' };
    ranges.push(headers['Content-Range']);
    const last = headers['Content-Range'].endsWith(`-${700 * 1024 - 1}/${700 * 1024}`);
    return { ok: true, status: last ? 201 : 202, json: async () => ({ id: 'i1', size: 700 * 1024 }) };
  };
  const r = await uploadFile(g, f, 'Shared/f.bin', { chunk: 327680, fetchFn, wait: 1 });
  assert.equal(r.item.id, 'i1');
  assert.deepEqual(ranges, ['bytes 0-327679/716800', 'bytes 327680-655359/716800', 'bytes 655360-716799/716800']);
  const busy = await uploadFile(async () => { throw new Error('409 /me/drive: nameAlreadyExists'); }, f, 'Shared/f.bin', { fetchFn });
  assert.match(busy.conflict, /^409/);
});
