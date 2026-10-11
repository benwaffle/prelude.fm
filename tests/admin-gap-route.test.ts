import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminPage } from '../app/admin/lib/admin-url';
import { adminGapHref, gapRoute } from '../app/admin/lib/gap-route';
import type { MusicBrainzGapCode } from '../app/lib/musicbrainz-library';

const EXPECTED_PAGE: Record<MusicBrainzGapCode, AdminPage | null> = {
  'provider-track-not-fetched': null,
  'provider-album-not-fetched': null,
  'classification-unreviewed': null,
  'classification-uncertain': null,
  'classification-not-classical': null,
  'release-not-checked': 'albums',
  'release-missing': 'missing',
  'release-ambiguous': 'missing',
  'release-tracklist-misaligned': 'misaligned',
  'release-cache-missing': 'albums',
  'release-title-missing': null,
  'release-date-missing': null,
  'release-spotify-streaming-url-missing': 'streaming',
  'release-track-position-mismatch': null,
  'recording-unanchored': null,
  'recording-anchor-conflict': 'contested',
  'recording-cache-missing': null,
  'recording-stub': null,
  'recording-title-missing': null,
  'recording-work-missing': 'work',
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
  'work-linked-by-us': null,
  'recording-credits-missing': null,
  'recording-credit-artist-missing': null,
};

test('every MusicBrainz gap has an explicit admin route or explicit null', () => {
  for (const [code, expectedPage] of Object.entries(EXPECTED_PAGE) as [
    MusicBrainzGapCode,
    (typeof EXPECTED_PAGE)[MusicBrainzGapCode],
  ][]) {
    assert.equal(gapRoute(code, { spotifyAlbumId: 'album-1' })?.page ?? null, expectedPage, code);
  }
});

test('gap routes preserve real album focus and class in the admin URL', () => {
  const route = gapRoute('release-missing', { spotifyAlbumId: 'album / one' });
  assert.ok(route);
  assert.equal(adminGapHref(route), '/admin?page=missing&album=album+%2F+one');
});

test('release not checked routes to the observable Albums filter', () => {
  const route = gapRoute('release-not-checked', { spotifyAlbumId: 'album-1' });
  assert.ok(route);
  assert.equal(adminGapHref(route), '/admin?page=albums&filter=unchecked');
});

test('unanchored recordings get no ISRC action without eligibility evidence', () => {
  assert.equal(gapRoute('recording-unanchored', { spotifyAlbumId: 'album-1' }), null);
});
