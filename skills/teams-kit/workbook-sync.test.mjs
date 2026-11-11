import test from 'node:test';
import assert from 'node:assert/strict';
import { col, grid } from './workbook-sync.mjs';

test('column letters and a padded text grid', () => {
  assert.deepEqual([1, 26, 27, 52, 703].map(col), ['A', 'Z', 'AA', 'AZ', 'AAA']);
  const g = grid([['a', 1], ['b'], [null, { x: 1 }, true]]);
  assert.equal(g.address, 'A1:C3');
  assert.deepEqual(g.values, [['a', '1', ''], ['b', '', ''], ['', '{"x":1}', 'true']]);
  assert.throws(() => grid([]), /non-empty/);
  assert.throws(() => grid(['x']), /non-empty/);
});
