import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { getReleaseWithRecordings, musicBrainzApi } from '../app/lib/musicbrainz';
import {
  resetMusicBrainzGatewayForTests,
  setMusicBrainzBudgetStore,
} from '../app/lib/musicbrainz-gateway';
import type { MusicBrainzBudgetStore } from '../app/lib/musicbrainz-budget';

/**
 * A real payload, trimmed to two tracks.
 *
 * The point of pinning a recorded response rather than a hand-written one is
 * that the whole request-efficiency argument rests on this single `inc` list
 * returning recordings, ISRCs, work relationships and credits together. If
 * MusicBrainz ever stops doing that, a hand-written fixture would keep
 * passing.
 */
const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/mb-release.json', import.meta.url)), 'utf8'),
);

const countingStore: MusicBrainzBudgetStore = {
  async claimSlot() {
    return 0;
  },
  async spend() {
    return 1;
  },
  async refund() {},
  async usage() {
    return {};
  },
  async controls() {
    return {};
  },
};

function withFetch(body: unknown, status = 200) {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    return new Response(status === 404 ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}

test.beforeEach(() => {
  setMusicBrainzBudgetStore(countingStore);
  resetMusicBrainzGatewayForTests({ minIntervalMs: 0 });
});

test.after(() => setMusicBrainzBudgetStore(null));

test('one release request yields recordings, ISRCs, works and credits', async () => {
  const fetchStub = withFetch(fixture);
  try {
    const release = await getReleaseWithRecordings('1afe97b5-d8ab-40c4-a9fd-5b38ed14e2ba');

    assert.equal(fetchStub.calls.length, 1, 'the whole release must cost one request');
    assert.ok(release);
    assert.equal(release.barcode, '0709869024256');
    assert.equal(release.date, '2013-11-18');
    assert.equal(release.tracks.length, 2);
    assert.deepEqual(release.urlRelations, []);

    const [first] = release.tracks;
    assert.equal(first.medium, 1);
    assert.equal(first.position, 1);
    assert.equal(first.recording.isrcs[0], 'FRZ131321010');
    assert.equal(first.recording.works.length, 1);
    assert.match(first.recording.works[0].title, /Concerto for 2 Violins in A minor/);

    const roles = first.recording.credits.map((credit) => credit.role);
    assert.ok(roles.includes('performing orchestra'));
    assert.ok(roles.includes('instrument'));
  } finally {
    fetchStub.restore();
  }
});

test('an instrument credit keeps its instrument, and other roles invent none', async () => {
  const fetchStub = withFetch(fixture);
  try {
    const release = await getReleaseWithRecordings('any');
    const credits = release!.tracks[0].recording.credits;

    const violin = credits.find((credit) => credit.role === 'instrument');
    assert.equal(violin?.instrument, 'violin');

    // `engineer` carries an `assistant` attribute; reading that as an
    // instrument would invent a credit that does not exist.
    const engineer = credits.find((credit) => credit.role === 'engineer');
    assert.equal(engineer?.instrument, null);
  } finally {
    fetchStub.restore();
  }
});

test('release URL relationships retain their type identity and ended state', async () => {
  const linkedFixture = structuredClone(fixture);
  linkedFixture.relations.unshift({
    type: 'free streaming',
    'type-id': '08445ccf-7b99-4438-9f9a-fb9ac18099ee',
    direction: 'forward',
    'target-type': 'url',
    ended: false,
    begin: null,
    end: null,
    attributes: [],
    url: {
      id: 'url-id',
      resource: 'https://open.spotify.com/album/example',
    },
  });
  linkedFixture.relations.unshift({
    type: 'purchase for download',
    'type-id': '74fc2ea1-3c7c-4b9e-9b7c-21c73669ec68',
    direction: 'forward',
    'target-type': 'url',
    ended: true,
    begin: '2013',
    end: '2020',
    attributes: ['some attribute'],
    url: {
      id: 'other-url-id',
      resource: 'https://example.com/download',
    },
  });

  const fetchStub = withFetch(linkedFixture);
  try {
    const release = await getReleaseWithRecordings('any');
    assert.deepEqual(release?.urlRelations, [
      {
        url: 'https://example.com/download',
        relationshipType: 'purchase for download',
        relationshipTypeId: '74fc2ea1-3c7c-4b9e-9b7c-21c73669ec68',
        ended: true,
        begin: '2013',
        end: '2020',
        attributes: ['some attribute'],
      },
      {
        url: 'https://open.spotify.com/album/example',
        relationshipType: 'free streaming',
        relationshipTypeId: '08445ccf-7b99-4438-9f9a-fb9ac18099ee',
        ended: false,
        begin: null,
        end: null,
        attributes: [],
      },
    ]);
  } finally {
    fetchStub.restore();
  }
});

test('a release MusicBrainz does not hold is absent, not an error', async () => {
  const fetchStub = withFetch(null, 404);
  try {
    assert.equal(await getReleaseWithRecordings('missing'), null);
  } finally {
    fetchStub.restore();
  }
});

test('the API source asks for the release on the channel it was built with', async () => {
  const fetchStub = withFetch(fixture);
  try {
    const source = musicBrainzApi('interactive');
    assert.equal(source.name, 'musicbrainz-api:interactive');
    const release = await source.releaseWithRecordings('1afe97b5');
    assert.equal(release?.tracks.length, 2);
    assert.match(
      fetchStub.calls[0],
      /inc=recordings\+recording-level-rels\+work-rels\+artist-rels\+artist-credits\+isrcs\+url-rels/,
    );
  } finally {
    fetchStub.restore();
  }
});
