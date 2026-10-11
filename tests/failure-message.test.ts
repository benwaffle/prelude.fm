import assert from 'node:assert/strict';
import test from 'node:test';
import { failureMessage } from '../app/lib/use-server-query';

test('a failure message preserves the thrown message', () => {
  assert.equal(
    failureMessage(new Error('MusicBrainz rejected edit 42')),
    'MusicBrainz rejected edit 42',
  );
  assert.equal(failureMessage('gateway unavailable'), 'gateway unavailable');
  assert.equal(failureMessage(503), '503');
});
