import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseMatchDebugQuery } from '@/app/admin/lib/match-debug-query';

test('reads links and identifiers before falling back to a title search', () => {
  assert.deepEqual(
    parseMatchDebugQuery('https://open.spotify.com/album/6lt9WnAym79u0D5DP88ZWX?si=x'),
    { kind: 'spotify', id: '6lt9WnAym79u0D5DP88ZWX' },
  );
  assert.deepEqual(parseMatchDebugQuery('3OVygGRqVF5GQFmm3R4VCU'), {
    kind: 'spotify',
    id: '3OVygGRqVF5GQFmm3R4VCU',
  });
  assert.deepEqual(
    parseMatchDebugQuery('https://musicbrainz.org/work/1D51E560-2a59-4e97-8943-13052b6adc03'),
    { kind: 'mbid', mbid: '1d51e560-2a59-4e97-8943-13052b6adc03' },
  );
  assert.deepEqual(parseMatchDebugQuery('fr-z11-86-03476'), {
    kind: 'isrc',
    isrc: 'FRZ118603476',
  });
  assert.deepEqual(parseMatchDebugQuery(' 5099963167351 '), {
    kind: 'barcode',
    digits: '5099963167351',
  });
  assert.deepEqual(parseMatchDebugQuery('Schmerzenskinderlieder'), {
    kind: 'text',
    text: 'Schmerzenskinderlieder',
  });
  assert.equal(parseMatchDebugQuery('   '), null);
});
