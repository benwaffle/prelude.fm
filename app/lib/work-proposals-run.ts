/**
 * Proposes works for library recordings MusicBrainz links to none, and
 * stores the proposals so that opening the Inbox never spends requests.
 *
 * Every request goes through the gateway on the `backfill` channel: nobody is
 * waiting on a sweep, and anything a person is waiting on should go first.
 * An album costs one request per family work (a parent of works its other
 * tracks perform, that parent's parent, and that collection's other members,
 * capped at `MAX_FAMILY_FETCHES`), plus one work search per track the family
 * does not answer with high confidence.
 *
 * Reads MusicBrainz and writes only `mb_work_proposal`. Submits nothing.
 */
import { inArray, sql } from 'drizzle-orm';
import { db } from './db';
import { filmScoreExclusions } from './film-score-exclusions';
import { mbWorkProposal } from './db/schema';
import { composerOf, mbGet, type MbRelation, type MbWork } from './musicbrainz';
import type { MusicBrainzChannel } from './musicbrainz-gateway';
import { titleWords } from './release-seed';
import {
  flagSharedProposals,
  proposeWork,
  type AlbumSibling,
  type ProposalCandidate,
  type ProposalTarget,
  type WorkProposal,
} from './work-proposals';

const CHANNEL: MusicBrainzChannel = 'backfill';
/** Family works read per album; a large collection says so rather than spending more. */
export const MAX_FAMILY_FETCHES = 25;
const SEARCH_LIMIT = 8;
const MAX_SEARCH_WORDS = 12;
const MAX_SEARCH_ARTISTS = 4;

export type ProposalGap = {
  recordingMbid: string;
  title: string;
  /** The Spotify album the recording is grouped under (the first, when it is on several). */
  albumId: string;
  albumTitle: string;
  releaseMbid: string | null;
  medium: number | null;
  position: number | null;
  artistNames: string[];
};

export type Counter = { requests: number };

/** Library recordings with no work relationship, one row per recording. */
export async function loadProposalGaps(): Promise<ProposalGap[]> {
  // Film scores are not part of the catalogue (see `film-scores`).
  const film = await filmScoreExclusions();
  const notFilm =
    film.trackIds.length === 0
      ? sql``
      : sql`and t.spotify_id not in (${sql.join(
          film.trackIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const rows = await db.all<{
    recording_mbid: string;
    title: string;
    album_id: string;
    album_title: string;
    release_mbid: string | null;
    medium: number | null;
    position: number | null;
    artists: string | null;
  }>(sql`
    with first_album as (
      select tr.recording_mbid, min(t.spotify_album_id) as album_id
      from track_recording tr
      join spotify_track t on t.spotify_id = tr.spotify_track_id
      where not exists (
        select 1 from mb_recording_work w where w.recording_mbid = tr.recording_mbid
      )
      ${notFilm}
      group by tr.recording_mbid
    ),
    gap as (
      select f.recording_mbid, a.spotify_id as album_id, a.title as album_title,
        a.mb_release_id as release_mbid
      from first_album f
      join spotify_album a on a.spotify_id = f.album_id
    )
    select gap.recording_mbid, rec.title, gap.album_id, gap.album_title, gap.release_mbid,
      rt.medium, rt.position,
      (select group_concat(distinct sa.name) from track_recording tr2
        join track_artists ta on ta.spotify_track_id = tr2.spotify_track_id
        join spotify_artist sa on sa.spotify_id = ta.spotify_artist_id
        where tr2.recording_mbid = gap.recording_mbid) as artists
    from gap
    join mb_recording rec on rec.mbid = gap.recording_mbid
    left join mb_release_track rt on rt.release_mbid = gap.release_mbid
      and rt.recording_mbid = gap.recording_mbid
    group by gap.recording_mbid
    order by gap.release_mbid, rt.medium, rt.position, gap.recording_mbid
  `);
  return rows.map((row) => ({
    recordingMbid: row.recording_mbid,
    title: row.title,
    albumId: row.album_id,
    albumTitle: row.album_title,
    releaseMbid: row.release_mbid,
    medium: row.medium,
    position: row.position,
    artistNames: (row.artists ?? '').split(',').filter(Boolean),
  }));
}

type SiblingRow = {
  medium: number;
  position: number;
  parentMbid: string | null;
  grandparentMbid: string | null;
  orderingKey: number | null;
  composerName: string | null;
};

/** Tracks on the release that already perform a cached work, with that work's place in its family. */
async function loadSiblings(releaseMbid: string): Promise<SiblingRow[]> {
  const rows = await db.all<{
    medium: number;
    position: number;
    parent_mbid: string | null;
    grandparent_mbid: string | null;
    ordering_key: number | null;
    composer_name: string | null;
  }>(sql`
    select rt.medium, rt.position, w.parent_mbid, p.parent_mbid as grandparent_mbid,
      w.ordering_key, ar.name as composer_name
    from mb_release_track rt
    join mb_recording_work rw on rw.recording_mbid = rt.recording_mbid
    join mb_work w on w.mbid = rw.work_mbid
    left join mb_work p on p.mbid = w.parent_mbid
    left join mb_artist ar on ar.mbid = coalesce(w.composer_mbid, p.composer_mbid)
    where rt.release_mbid = ${releaseMbid}
  `);
  return rows.map((row) => ({
    medium: row.medium,
    position: row.position,
    parentMbid: row.parent_mbid,
    grandparentMbid: row.grandparent_mbid,
    orderingKey: row.ordering_key,
    composerName: row.composer_name,
  }));
}

type ChildPart = { id: string; title: string; orderingKey: number | null };

function childParts(work: MbWork): ChildPart[] {
  return (work.relations ?? [])
    .filter(
      (relation: MbRelation) =>
        relation.type === 'parts' && relation.direction === 'forward' && relation.work,
    )
    .map((relation) => ({
      id: relation.work!.id,
      title: relation.work!.title,
      orderingKey: relation['ordering-key'] ?? null,
    }));
}

async function readWork(counter: Counter, mbid: string): Promise<MbWork | null> {
  counter.requests++;
  return mbGet<MbWork>(`/work/${mbid}?inc=work-rels+artist-rels&fmt=json`, CHANNEL);
}

/**
 * Parts of the works the album's linked tracks belong to, and of their
 * collection's other members.
 *
 * The parent is read rather than trusted from the cache because the cache
 * holds only the parts somebody has recorded; the movement this track plays
 * is exactly the one that is missing.
 */
async function familyCandidates(
  counter: Counter,
  siblings: SiblingRow[],
): Promise<{ candidates: ProposalCandidate[]; capped: boolean }> {
  const parents = [...new Set(siblings.flatMap((row) => (row.parentMbid ? [row.parentMbid] : [])))];
  const grandparents = [
    ...new Set(siblings.flatMap((row) => (row.grandparentMbid ? [row.grandparentMbid] : []))),
  ];
  const read = new Map<string, MbWork | null>();
  let capped = false;
  const fetch = async (mbid: string) => {
    if (read.has(mbid)) return read.get(mbid) ?? null;
    if (read.size >= MAX_FAMILY_FETCHES) {
      capped = true;
      return null;
    }
    const work = await readWork(counter, mbid);
    read.set(mbid, work);
    return work;
  };

  for (const mbid of [...parents, ...grandparents]) await fetch(mbid);
  for (const mbid of grandparents) {
    const collection = read.get(mbid);
    if (!collection) continue;
    for (const member of childParts(collection)) await fetch(member.id);
  }

  const candidates: ProposalCandidate[] = [];
  for (const [mbid, work] of read) {
    if (!work || grandparents.includes(mbid)) continue;
    const composer = composerOf(work)?.name ?? null;
    for (const part of childParts(work)) {
      if (read.has(part.id)) continue;
      candidates.push({
        workMbid: part.id,
        title: part.title,
        parentMbid: mbid,
        parentTitle: work.title,
        orderingKey: part.orderingKey,
        composerName:
          composer ?? siblings.find((row) => row.parentMbid === mbid)?.composerName ?? null,
        aliases: [],
        source: 'album',
      });
    }
  }
  return { candidates, capped };
}

type SearchWork = MbWork & { aliases?: { name: string }[] };

/**
 * The last word of each name, so the search matches however MusicBrainz
 * credits the artist: a quoted "Frédéric Chopin" finds nothing where the work
 * credits "Fryderyk Chopin". The surname is all the confirmation checks need.
 */
function surnames(names: string[]): string[] {
  return [...new Set(names.flatMap((name) => titleWords(name).slice(-1)))];
}

/** MusicBrainz works whose title words and composer fit the track. */
export async function searchCandidates(
  counter: Counter,
  title: string,
  composers: string[],
): Promise<ProposalCandidate[]> {
  // Words only: punctuation is dropped, so nothing in the query needs escaping.
  const words = titleWords(title).slice(0, MAX_SEARCH_WORDS);
  if (words.length === 0) return [];
  const artists = surnames(composers).slice(0, MAX_SEARCH_ARTISTS);
  const query =
    `work:(${words.join(' ')})` +
    (artists.length > 0 ? ` AND (${artists.map((name) => `artist:${name}`).join(' OR ')})` : '');
  counter.requests++;
  const result = await mbGet<{ works?: SearchWork[] }>(
    `/work?query=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&fmt=json`,
    CHANNEL,
  );
  return (result?.works ?? []).map((work) => ({
    workMbid: work.id,
    title: work.title,
    parentMbid: null,
    parentTitle: null,
    orderingKey: null,
    composerName: composerOf(work)?.name ?? null,
    aliases: (work.aliases ?? []).map((alias) => alias.name),
    source: 'search',
  }));
}

export type ProposalOutcome = {
  recordingMbid: string;
  title: string;
  albumTitle: string;
  releaseMbid: string | null;
  proposal: WorkProposal | null;
  requests: number;
  /** The album's family was larger than one run reads; some parts were not considered. */
  familyCapped: boolean;
};

/** Proposals for every gap on one release (or for one release-less gap). */
export async function proposeForGroup(gaps: ProposalGap[]): Promise<ProposalOutcome[]> {
  const releaseMbid = gaps[0]?.releaseMbid ?? null;
  const shared: Counter = { requests: 0 };
  const siblings = releaseMbid ? await loadSiblings(releaseMbid) : [];
  const { candidates: family, capped } =
    siblings.length > 0
      ? await familyCandidates(shared, siblings)
      : { candidates: [], capped: false };
  const releaseComposers = [
    ...new Set(siblings.flatMap((row) => (row.composerName ? [row.composerName] : []))),
  ];
  const albumSiblings: AlbumSibling[] = siblings.flatMap((row) =>
    row.parentMbid
      ? [
          {
            medium: row.medium,
            position: row.position,
            parentMbid: row.parentMbid,
            orderingKey: row.orderingKey,
          },
        ]
      : [],
  );

  const outcomes: ProposalOutcome[] = [];
  for (const gap of gaps) {
    const own: Counter = { requests: 0 };
    const target: ProposalTarget = {
      recordingMbid: gap.recordingMbid,
      title: gap.title,
      medium: gap.medium,
      position: gap.position,
      artistNames: gap.artistNames,
      releaseComposers,
      siblings: albumSiblings,
    };
    let proposal = proposeWork(target, family);
    if (proposal?.confidence !== 'high') {
      const found = await searchCandidates(
        own,
        gap.title,
        releaseComposers.length > 0 ? releaseComposers : gap.artistNames,
      );
      proposal = proposeWork(target, [...family, ...found]);
    }
    outcomes.push({
      recordingMbid: gap.recordingMbid,
      title: gap.title,
      albumTitle: gap.albumTitle,
      releaseMbid,
      proposal,
      requests: own.requests,
      familyCapped: capped,
    });
  }
  flagSharedProposals(outcomes);
  // The family reads served every track on the album; charge them to the first.
  if (outcomes[0]) outcomes[0].requests += shared.requests;
  return outcomes;
}

/** Gaps grouped by album release; release-less gaps stand alone. */
export function groupGaps(gaps: ProposalGap[]): ProposalGap[][] {
  const groups = new Map<string, ProposalGap[]>();
  for (const gap of gaps) {
    const key = gap.releaseMbid ?? `recording:${gap.recordingMbid}`;
    const list = groups.get(key) ?? [];
    list.push(gap);
    groups.set(key, list);
  }
  return [...groups.values()];
}

/**
 * Store outcomes. A decision survives a re-run that proposes the same work;
 * a different work is a new question, so it returns to `proposed`.
 */
export async function storeProposals(outcomes: ProposalOutcome[]): Promise<void> {
  for (const outcome of outcomes) {
    await db
      .insert(mbWorkProposal)
      .values({
        recordingMbid: outcome.recordingMbid,
        releaseMbid: outcome.releaseMbid,
        proposal: outcome.proposal,
        requests: outcome.requests,
      })
      .onConflictDoUpdate({
        target: mbWorkProposal.recordingMbid,
        set: {
          releaseMbid: outcome.releaseMbid,
          proposal: outcome.proposal,
          requests: outcome.requests,
          checkedAt: new Date(),
          status: sql`case when json_extract(${mbWorkProposal.proposal}, '$.workMbid')
            is json_extract(excluded.proposal, '$.workMbid')
            then ${mbWorkProposal.status} else 'proposed' end`,
          decidedAt: sql`case when json_extract(${mbWorkProposal.proposal}, '$.workMbid')
            is json_extract(excluded.proposal, '$.workMbid')
            then ${mbWorkProposal.decidedAt} else null end`,
        },
      });
  }
}

/** Recordings that already have a stored proposal (or a stored "nothing found"). */
export async function proposedRecordings(recordingMbids: string[]): Promise<Set<string>> {
  if (recordingMbids.length === 0) return new Set();
  const rows = await db
    .select({ recordingMbid: mbWorkProposal.recordingMbid })
    .from(mbWorkProposal)
    .where(inArray(mbWorkProposal.recordingMbid, recordingMbids));
  return new Set(rows.map((row) => row.recordingMbid));
}
