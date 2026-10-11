import assert from 'node:assert/strict';
import test from 'node:test';
import { titlesAreCompatible } from '../app/lib/metadata-matching';

test('recognizes equivalent title variants', () => {
  assert.equal(titlesAreCompatible('Requiem in D minor', 'Requiem in D Minor, K. 626'), true);
});
