import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AMBIGUOUS_BARCODE_REASON,
  barcodeReleaseSearchUrl,
  formatMbPickMeta,
  mbApiReleaseToPickHit,
  mbReleasePickHit,
  mbWorkPickHit,
} from '../app/lib/musicbrainz-pick';

test('a release hit names title, credit, date, country, tracks and MBID', () => {
  const hit = mbReleasePickHit({
    mbid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: 'The Planets',
    date: '1970',
    country: 'GB',
    artistNames: ['Holst', 'London Symphony Orchestra'],
    trackCount: 7,
    mediumCount: 1,
    comment: null,
  });
  assert.equal(hit.entity, 'release');
  assert.equal(hit.href, 'https://musicbrainz.org/release/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(formatMbPickMeta(hit), 'Holst, London Symphony Orchestra · 1970 · GB · 7 tracks');
  assert.equal(hit.comment, null);
  assert.equal(hit.mbid, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
});

test('fields we do not hold stay blank rather than being invented', () => {
  const hit = mbReleasePickHit({
    mbid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: 'Untitled',
    date: null,
    country: null,
    artistNames: [],
    trackCount: 0,
    mediumCount: 0,
  });
  assert.equal(formatMbPickMeta(hit), '');
  assert.equal(hit.credit, null);
  assert.equal(hit.detail, null);
});

test('a work hit lists composer, type, catalogue and MBID like the editor', () => {
  const hit = mbWorkPickHit({
    workMbid: '11111111-2222-3333-4444-555555555555',
    title: 'Symphony no. 5',
    type: 'Symphony',
    composerName: 'Ludwig van Beethoven',
    catalogues: [{ system: 'Op.', number: '67' }],
  });
  assert.equal(hit.href, 'https://musicbrainz.org/work/11111111-2222-3333-4444-555555555555');
  assert.equal(formatMbPickMeta(hit), 'Ludwig van Beethoven · Symphony · Op. 67');
  assert.equal(hit.mbid, '11111111-2222-3333-4444-555555555555');
});

test('an API release maps onto the same hit without inventing format or comment', () => {
  const hit = mbApiReleaseToPickHit({
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: 'Kindertotenlieder',
    date: '1958',
    country: 'DE',
    tracks: [
      {
        medium: 1,
        recording: { artistCredit: [{ name: 'Kathleen Ferrier' }] },
      },
    ],
  });
  assert.equal(hit.comment, null);
  assert.match(formatMbPickMeta(hit), /Kathleen Ferrier/);
});

test('the barcode search is an advanced barcode query, not a generic search box', () => {
  assert.equal(AMBIGUOUS_BARCODE_REASON, 'several releases share the barcode');
  const url = barcodeReleaseSearchUrl('00731453988228');
  assert.match(url, /type=release/);
  assert.match(url, /method=advanced/);
  assert.match(url, /barcode%3A731453988228/);
});
