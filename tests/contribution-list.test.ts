import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTRIBUTION_PAGE_SIZE,
  hasMoreToLoad,
  nextListLimit,
  pageSlice,
  shownOfTotalLabel,
} from '../app/lib/contribution-list';

test('the heading names the slice until the list can reach the total', () => {
  assert.equal(shownOfTotalLabel(40, 202), 'showing 40 of 202');
  assert.equal(shownOfTotalLabel(202, 202), '202');
  assert.equal(shownOfTotalLabel(0, 0), '0');
  assert.equal(shownOfTotalLabel(0, 202), 'showing 0 of 202');
});

test('load more grows the slice until it meets the count, never past it', () => {
  assert.equal(hasMoreToLoad(40, 202), true);
  assert.equal(hasMoreToLoad(202, 202), false);
  assert.equal(nextListLimit(40, 202), 80);
  assert.equal(nextListLimit(200, 202), 202);
  assert.equal(nextListLimit(202, 202), 202);
  assert.equal(CONTRIBUTION_PAGE_SIZE, 40);
  assert.deepEqual(pageSlice(['a', 'b', 'c', 'd'], 2, 0), ['a', 'b']);
  assert.deepEqual(pageSlice(['a', 'b', 'c', 'd'], 2, 2), ['c', 'd']);
});
