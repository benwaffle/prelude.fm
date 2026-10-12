import type { Track } from '@spotify/web-api-ts-sdk';
import type { MbRelease, MusicBrainzSource } from '../../app/lib/musicbrainz-source';

export function fakeSource(answers: Partial<MusicBrainzSource>): MusicBrainzSource {
  return {
    name: 'fake',
    releasesByBarcode: async () => [],
    searchReleases: async () => [],
    releaseWithRecordings: async () => null,
    releaseRecordingIds: async () => [],
    recordingsByIsrc: async () => new Map(),
    recordingWorks: async () => [],
    recordingDetail: async () => null,
    work: async () => null,
    artist: async () => null,
    ...answers,
  };
}

const ALBUM = {
  id: 'album-1',
  name: 'Mozart: Piano Sonatas',
  uri: 'spotify:album:album-1',
  release_date: '1990-05-01',
  popularity: 33,
  images: [{ url: 'https://example.test/cover.jpg', width: 640, height: 640 }],
};

function spotifyTrack(index: number): Track {
  return {
    id: `track-${index}`,
    name: `Piano Sonata no. 16: movement ${index}`,
    uri: `spotify:track:track-${index}`,
    duration_ms: 200_000 + index,
    disc_number: 1,
    track_number: index,
    popularity: 40,
    external_ids: { isrc: `GBAAA000000${index}` },
    artists: [{ id: 'artist-1', name: 'Mitsuko Uchida' }],
  } as unknown as Track;
}

const SPOTIFY_ALBUM = { album: ALBUM, tracks: [spotifyTrack(1), spotifyTrack(2)] };
export const readAlbum = async () => SPOTIFY_ALBUM;

export function release(options = { works: true }): MbRelease {
  return {
    id: 'release-1',
    title: 'Mozart: Piano Sonatas',
    barcode: '0000000000001',
    date: '1990-05-01',
    country: 'GB',
    tracks: [1, 2].map((position) => ({
      medium: 1,
      position,
      title: `Movement ${position}`,
      length: 200_000 + position,
      recording: {
        id: `rec-${position}`,
        title: `Movement ${position}`,
        length: 200_000 + position,
        isrcs: [`GBAAA000000${position}`],
        works: options.works
          ? [{ id: `part-${position}`, title: `K. 545: movement ${position}` }]
          : [],
        credits: [
          {
            artistId: 'mb-uchida',
            name: 'Mitsuko Uchida',
            role: 'instrument',
            instrument: 'piano',
          },
        ],
        artistCredit: [{ artistId: 'mb-uchida', name: 'Mitsuko Uchida' }],
      },
    })),
  };
}

export function workTree(id: string) {
  if (id === 'sonata') {
    return {
      id: 'sonata',
      title: 'Piano Sonata no. 16 in C major, K. 545',
      type: 'Sonata',
      relations: [
        {
          type: 'composer',
          direction: 'backward' as const,
          artist: { id: 'mb-mozart', name: 'Wolfgang Amadeus Mozart' },
        },
        {
          type: 'part of',
          direction: 'forward' as const,
          'target-type': 'series',
          series: { id: 'series-k', name: 'Köchel-Verzeichnis', type: 'Catalogue' },
          'attribute-values': { number: 'K. 545' },
        },
      ],
    };
  }
  const position = id.endsWith('1') ? 1 : 2;
  return {
    id,
    title: `K. 545: movement ${position}`,
    type: null,
    relations: [
      {
        type: 'parts',
        direction: 'backward' as const,
        'target-type': 'work',
        'ordering-key': position,
        work: { id: 'sonata', title: 'Piano Sonata no. 16 in C major, K. 545' },
      },
    ],
  };
}

export const artist = async (id: string) =>
  id === 'mb-mozart'
    ? {
        id,
        name: 'Wolfgang Amadeus Mozart',
        'sort-name': 'Mozart, Wolfgang Amadeus',
        type: 'Person',
        'life-span': { begin: '1756-01-27', end: '1791-12-05' },
      }
    : { id, name: 'Mitsuko Uchida', 'sort-name': 'Uchida, Mitsuko', type: 'Person' };

export const ALBUM_ROW = {
  spotifyId: 'album-1',
  title: 'Mozart: Piano Sonatas',
  year: 1990,
  popularity: 33,
  images: null,
  upc: '0000000000001',
  mbReleaseId: null,
  mbReleaseCandidates: null,
  mbCheckedAt: null,
};

export function providerTrackRows() {
  return SPOTIFY_ALBUM.tracks.map((track) => ({
    spotifyId: track.id,
    title: track.name,
    trackNumber: track.track_number,
    discNumber: track.disc_number,
    durationMs: track.duration_ms,
    popularity: track.popularity,
    spotifyAlbumId: ALBUM.id,
    isrc: track.external_ids?.isrc ?? null,
  }));
}
