// Film and TV scores are not part of the catalogue (Ben's call). MusicBrainz has no consistent
// film-score type, so the rule is reference data applied on read: it covers later imports and is
// reversible here. Concert composers who also score films (Glass, Richter, Nyman, Kilar) are
// deliberately not listed. Excluded tracks read as not classical with a reason, never hidden.

import { classicalEvidenceFor, type ClassicalEvidenceWork } from './musicbrainz-classical-evidence';
import { ancestry } from './musicbrainz-work-tree';

type FilmComposer = {
  name: string;
  mbid: string;
  spotifyId?: string;
};

export const FILM_COMPOSERS: FilmComposer[] = [
  { name: 'Alex Gibson', mbid: 'df5d57fc-b7f6-4f3c-a9ac-1757fee57d1b' },
  {
    name: 'Alfred Newman',
    mbid: 'dbe22c4f-6a21-4b7c-ad09-e4048d1065bc',
    spotifyId: '2e7myQwGa7Vyp7sss8brVC',
  },
  {
    name: 'Atli Örvarsson',
    mbid: 'e46cd9a1-56de-4748-b7fc-94c30564f858',
    spotifyId: '2fqgzLpPOMc7GMw9qcOfQT',
  },
  { name: 'Blake Neely', mbid: 'a40b969e-4329-494e-aacb-14370f75889d' },
  { name: 'Clay Duncan', mbid: 'adfe31fd-f42c-42af-9cec-278ee977eae5' },
  {
    name: 'Geoff Zanelli',
    mbid: 'e7330fc6-382d-4bc9-b23d-cc57966e687b',
    spotifyId: '0X5jj08FYkWPtmzUhhjOJd',
  },
  { name: 'Gore Verbinski', mbid: 'dc3ef6a4-ee5b-485b-a522-365d4359849a' },
  {
    name: 'Hans Zimmer',
    mbid: 'e6de1f3b-6484-491c-88dd-6d619f142abc',
    spotifyId: '0YC192cP3KPCRWx8zr8MfZ',
  },
  { name: 'Henry Jackman', mbid: 'e596591b-3031-4d50-ae40-020d0e7ebcef' },
  {
    name: 'Howard Shore',
    mbid: '9b58672a-e68e-4972-956e-a8985a165a1f',
    spotifyId: '0OcclcP5o8VKH2TRqSY2A7',
  },
  {
    name: 'James Horner',
    mbid: '679ec43c-bc04-4bb0-b619-2da702a214ba',
    spotifyId: '3PhL2Vdao2v8SS8AptuhAr',
  },
  {
    name: 'James Newton Howard',
    mbid: 'f6580b26-77f7-4a7b-8513-6db0476e8f21',
    spotifyId: '2M4eNCvV3CJUswavkhAQg2',
  },
  {
    name: 'John Barry',
    mbid: '661e20c8-3d82-4da2-94a2-97d9e11691c0',
    spotifyId: '7ctAOUlIAs7yuMODWE2Fyz',
  },
  // The composer, born 1932, not John Williams the guitarist, whose Bach and Barrios belong in the
  // catalogue.
  {
    name: 'John Williams',
    mbid: '53b106e7-0cc6-42cc-ac95-ed8d30a3a98e',
    spotifyId: '3dRfiJ2650SZu6GbydcHNb',
  },
  { name: 'Junkie XL', mbid: 'eb3f70ce-f226-428f-8d7f-046c8dbfd98f' },
  {
    name: 'Klaus Badelt',
    mbid: '74ba575f-3420-4d62-8e48-ac473d3c4282',
    spotifyId: '03GruNQP8X25PCoWzdvIGZ',
  },
  {
    name: 'Lorne Balfe',
    mbid: '0529a9e0-befb-4d9f-b6f9-1ccd7c83053e',
    spotifyId: '6dU7gPN2BhEPfO5QHLt7es',
  },
  { name: 'Matthew Margeson', mbid: '8d12f310-727f-44bb-9327-cc8907919698' },
  {
    name: 'Nicholas Britell',
    mbid: 'afa80039-cd8a-47ae-947e-538df896586f',
    spotifyId: '18oYqNtcLUHrqO7LfX7qni',
  },
  {
    name: 'Nick Glennie-Smith',
    mbid: 'b2cc1d81-8f46-41ca-bd1d-e9e8cb02f411',
    spotifyId: '0cM9EbovGFwSQlWjgHmdGd',
  },
  { name: 'Ramin Djawadi', mbid: 'f089f636-6b85-4e0e-a192-0d30ed2b44d1' },
  { name: 'Skip Henderson', mbid: 'fca18bbc-845f-42db-9c8e-060394062cf9' },
  {
    name: 'Stanley Myers',
    mbid: '0179bb0c-704a-4844-b7f3-35cee9c8b954',
    spotifyId: '6l6NgkV6IWYKlRN7jHCQmt',
  },
  { name: 'Tom Gire', mbid: 'f1412d19-580b-419a-b9a4-a286018b843b' },
  { name: 'Trevor Morris', mbid: 'b8634d0b-e1f8-4671-9ed9-21e9a03973ed' },
];

/** Titles that say so are recognised by `SOUNDTRACK_TITLE` and need no entry here. */
export const SOUNDTRACK_ALBUMS: Record<string, string> = {
  '2vj3iA2LvtvPKL8G0ZqEkm': 'Crimson Tide',
  '0yhQBaWmkWfbfpkUrbahAC': 'Live In Prague (Hans Zimmer in concert)',
  '241F2pNbl6OIJPixynRuiu': "Pirates of the Caribbean: At World's End",
  '2RkWo1xomg2mBR8ydABsab': 'Pirates of the Caribbean: On Stranger Tides',
  '3lgT2CiZOJCoLRJx2BZwDZ': 'Snow White & The Huntsman',
  '4GuLx38y1727p45spIvslr': 'The Da Vinci Code',
  '2Jqqt4hlvKdQpPWjpLg33L': 'The Lone Ranger',
};

const SOUNDTRACK_TITLE =
  /soundtrack|motion picture|original score|music from the (?:[\w®.'’-]+ )*(?:series|film|movie)/i;

const FILM_COMPOSER_BY_MBID = new Map(FILM_COMPOSERS.map((composer) => [composer.mbid, composer]));
const FILM_COMPOSER_BY_SPOTIFY_ID = new Map(
  FILM_COMPOSERS.flatMap((composer) =>
    composer.spotifyId ? [[composer.spotifyId, composer] as const] : [],
  ),
);

export function isSoundtrackAlbum(album: { spotifyAlbumId: string; title: string }): boolean {
  return album.spotifyAlbumId in SOUNDTRACK_ALBUMS || SOUNDTRACK_TITLE.test(album.title);
}

/** Every film-score reason starts with this, so a reader can tell them apart. */
export const FILM_SCORE_REASON = 'film score, left out of the catalogue';

export function isFilmScoreReason(reason: string | null | undefined): boolean {
  return reason?.startsWith(FILM_SCORE_REASON) ?? false;
}

export type FilmScoreWork = ClassicalEvidenceWork & { composerMbid: string | null };

export type FilmScoreTrack = {
  workMbids: string[];
  spotifyArtistIds: string[];
  album: { spotifyAlbumId: string; title: string } | null;
};

export function filmScoreReason(
  track: FilmScoreTrack,
  workByMbid: Map<string, FilmScoreWork>,
  catalogedWorkMbids: Set<string>,
): string | null {
  for (const workMbid of track.workMbids) {
    for (const work of ancestry(workMbid, workByMbid)) {
      const composer = work.composerMbid && FILM_COMPOSER_BY_MBID.get(work.composerMbid);
      if (composer) {
        return `${FILM_SCORE_REASON}: MusicBrainz credits ${composer.name}, who writes for film and TV`;
      }
    }
  }
  for (const artistId of track.spotifyArtistIds) {
    const composer = FILM_COMPOSER_BY_SPOTIFY_ID.get(artistId);
    if (composer) {
      return `${FILM_SCORE_REASON}: Spotify credits ${composer.name}, who writes for film and TV`;
    }
  }
  if (track.album && isSoundtrackAlbum(track.album)) {
    const evidence = classicalEvidenceFor(track.workMbids, workByMbid, catalogedWorkMbids);
    if (evidence.state !== 'classical') {
      return `${FILM_SCORE_REASON}: on the soundtrack album "${track.album.title}" and ${evidence.reason}`;
    }
  }
  return null;
}
