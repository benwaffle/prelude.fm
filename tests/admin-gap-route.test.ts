import assert from 'node:assert/strict';
import test from 'node:test';
import { adminGapHref, gapRoute } from '../app/admin/lib/gap-route';
import type { MusicBrainzGapCode } from '../app/lib/musicbrainz-library';

const EXPECTED_TAB: Record<MusicBrainzGapCode, 'inbox' | 'albums' | 'health' | null> = {
  'provider-track-not-fetched': null,
  'provider-album-not-fetched': null,
  'classification-unreviewed': null,
  'classification-uncertain': null,
  'classification-not-classical': null,
  'release-not-checked': 'albums',
  'release-missing': 'inbox',
  'release-ambiguous': 'inbox',
  'release-tracklist-misaligned': 'inbox',
  'release-cache-missing': 'albums',
  'release-title-missing': null,
  'release-date-missing': null,
  'release-spotify-streaming-url-missing': 'inbox',
  'release-track-position-mismatch': null,
  'recording-unanchored': null,
  'recording-anchor-conflict': 'inbox',
  'recording-cache-missing': null,
  'recording-stub': null,
  'recording-title-missing': null,
  'recording-work-missing': 'inbox',
  'work-cache-missing': null,
  'work-stub': null,
  'work-title-missing': null,
  'work-type-missing': null,
  'work-catalogue-missing': null,
  'work-composer-missing': null,
  'composer-cache-missing': null,
  'composer-name-missing': null,
  'work-hierarchy-parent-missing': null,
  'work-hierarchy-cycle': null,
  'work-level-ambiguous': null,
  'recording-credits-missing': null,
  'recording-credit-artist-missing': null,
};

test('every MusicBrainz gap has an explicit admin route or explicit null', () => {
  for (const [code, expectedTab] of Object.entries(EXPECTED_TAB) as [
    MusicBrainzGapCode,
    (typeof EXPECTED_TAB)[MusicBrainzGapCode],
  ][]) {
    assert.equal(gapRoute(code, { spotifyAlbumId: 'album-1' })?.tab ?? null, expectedTab, code);
  }
});

test('gap routes preserve real album focus and class in the admin URL', () => {
  const route = gapRoute('release-missing', { spotifyAlbumId: 'album / one' });
  assert.ok(route);
  assert.equal(adminGapHref(route), '/admin?tab=inbox&class=missing&album=album+%2F+one');
});

test('release not checked routes to the observable Albums filter', () => {
  const route = gapRoute('release-not-checked', { spotifyAlbumId: 'album-1' });
  assert.ok(route);
  assert.equal(adminGapHref(route), '/admin?tab=albums&filter=unchecked');
});

test('unanchored recordings get no ISRC action without eligibility evidence', () => {
  assert.equal(gapRoute('recording-unanchored', { spotifyAlbumId: 'album-1' }), null);
});
