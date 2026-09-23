import assert from 'node:assert/strict';
import test from 'node:test';
import { adminFailureMessage } from '../app/admin/components/AdminFailure';

test('admin failure preserves the thrown message', () => {
  assert.equal(
    adminFailureMessage(new Error('MusicBrainz rejected edit 42')),
    'MusicBrainz rejected edit 42',
  );
  assert.equal(adminFailureMessage('gateway unavailable'), 'gateway unavailable');
  assert.equal(adminFailureMessage(503), '503');
});
