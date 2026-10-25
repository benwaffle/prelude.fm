import { sql } from 'drizzle-orm';
import { db } from '../db';
import { jsonList } from '../db/chunked';
import { filmScoreExclusions } from '../film-score-exclusions';

// A track related to a work that has parts is usually the whole piece in one track (a toccata, a
// prelude and fugue), which is fine. These are the ones where the evidence says it is one part.
export type WholeWorkLink = {
  trackId: string;
  trackTitle: string;
  durationMs: number;
  recordingMbid: string;
  workMbid: string;
  workTitle: string | null;
  albumId: string;
  albumTitle: string;
  reason: 'number' | 'parts-on-album' | 'several-tracks';
};

// Mirrors WHOLES_OF_NUMBERS in musicbrainz-work-level: one track is a number, never the whole.
const WHOLES = [
  'Cantata',
  'Incidental music',
  'Mass',
  'Motet',
  'Opera',
  'Operetta',
  'Oratorio',
  'Passion',
  'Requiem',
  'Zarzuela',
];

type Row = Omit<WholeWorkLink, 'reason'> & {
  type: string | null;
  parentType: string | null;
  partsOnAlbum: number;
};

export async function wholeWorkLinks(
  scope: { albumIds?: readonly string[] } = {},
): Promise<WholeWorkLink[]> {
  const film = new Set((await filmScoreExclusions(scope.albumIds)).trackIds);
  const rows = await db.all<Row>(sql`
    select t.spotify_id as trackId, t.title as trackTitle, t.duration_ms as durationMs,
      tr.recording_mbid as recordingMbid, w.mbid as workMbid, w.title as workTitle,
      w.type as type, p.type as parentType, a.spotify_id as albumId, a.title as albumTitle,
      (select count(*) from spotify_track t2
        join track_recording tr2 on tr2.spotify_track_id = t2.spotify_id
        join mb_recording_work rw2 on rw2.recording_mbid = tr2.recording_mbid
        join mb_work part on part.mbid = rw2.work_mbid
        where t2.spotify_album_id = t.spotify_album_id and part.parent_mbid = w.mbid
      ) as partsOnAlbum
    from track_recording tr
    join mb_recording_work rw on rw.recording_mbid = tr.recording_mbid
    join mb_work w on w.mbid = rw.work_mbid
    left join mb_work p on p.mbid = w.parent_mbid
    join spotify_track t on t.spotify_id = tr.spotify_track_id
    join spotify_album a on a.spotify_id = t.spotify_album_id
    where exists (select 1 from mb_work c where c.parent_mbid = w.mbid)
      ${scope.albumIds ? sql`and t.spotify_album_id in (${jsonList(scope.albumIds)})` : sql``}
    order by w.title, a.title, t.disc_number, t.track_number`);

  // Several tracks of one album on one work are its movements when their lengths differ; three
  // equal lengths are three performances.
  const lengths = new Map<string, number[]>();
  for (const row of rows) {
    const key = `${row.albumId}:${row.workMbid}`;
    lengths.set(key, [...(lengths.get(key) ?? []), row.durationMs]);
  }
  const splitAcrossTracks = (row: Row) => {
    const group = lengths.get(`${row.albumId}:${row.workMbid}`)!;
    return group.length > 1 && Math.min(...group) < 0.8 * Math.max(...group);
  };

  return rows.flatMap(({ type, parentType, partsOnAlbum, ...row }) => {
    if (film.has(row.trackId)) return [];
    const reason: WholeWorkLink['reason'] | null =
      WHOLES.includes(type ?? '') || WHOLES.includes(parentType ?? '')
        ? 'number'
        : partsOnAlbum > 0
          ? 'parts-on-album'
          : splitAcrossTracks({ type, parentType, partsOnAlbum, ...row })
            ? 'several-tracks'
            : null;
    return reason ? [{ ...row, reason }] : [];
  });
}
