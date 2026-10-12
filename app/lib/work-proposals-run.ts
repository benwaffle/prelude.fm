// Uses the gateway's `backfill` channel so anything a person is waiting on goes first. Writes only
// `mb_work_proposal`; submits nothing.
import { sql } from 'drizzle-orm';
import { db } from './db';
import { filmScoreExclusions } from './film-score-exclusions';
import { mbWorkProposal } from './db/schema';
import { childPartsOf, composerOf, type MbWork } from './musicbrainz';
import { createMbSession, type MbSession } from './musicbrainz-session';
import { titleWords } from './release-seed';
import {
  flagSharedProposals,
  proposeWork,
  type AlbumSibling,
  type ProposalCandidate,
  type ProposalTarget,
  type WorkProposal,
} from './work-proposals';

/** Family works read per album; a large collection says so rather than spending more. */
export const MAX_FAMILY_FETCHES = 25;
const SEARCH_LIMIT = 8;
const MAX_SEARCH_WORDS = 12;
const MAX_SEARCH_ARTISTS = 4;

export type ProposalGap = {
  recordingMbid: string;
  title: string;
  /** The first album, when the recording is on several. */
  albumId: string;
  albumTitle: string;
  releaseMbid: string | null;
  medium: number | null;
  position: number | null;
  artistNames: string[];
};

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

// The parent is read rather than trusted from the cache: the cache only holds parts somebody has
// recorded.
async function familyCandidates(
  mb: MbSession,
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
    const work = await mb.work(mbid);
    read.set(mbid, work);
    return work;
  };

  for (const mbid of [...parents, ...grandparents]) await fetch(mbid);
  for (const mbid of grandparents) {
    const collection = read.get(mbid);
    if (!collection) continue;
    for (const member of childPartsOf(collection)) await fetch(member.id);
  }

  const candidates: ProposalCandidate[] = [];
  for (const [mbid, work] of read) {
    if (!work || grandparents.includes(mbid)) continue;
    const composer = composerOf(work)?.name ?? null;
    for (const part of childPartsOf(work)) {
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

// Surnames only: a quoted "Frédéric Chopin" finds nothing where the work credits "Fryderyk Chopin".
function surnames(names: string[]): string[] {
  return [...new Set(names.flatMap((name) => titleWords(name).slice(-1)))];
}

export async function searchCandidates(
  mb: MbSession,
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
  const result = await mb.get<{ works?: SearchWork[] }>(
    `/work?query=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}&fmt=json`,
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
  familyCapped: boolean;
};

export async function proposeForGroup(gaps: ProposalGap[]): Promise<ProposalOutcome[]> {
  const releaseMbid = gaps[0]?.releaseMbid ?? null;
  const mb = createMbSession('backfill');
  const siblings = releaseMbid ? await loadSiblings(releaseMbid) : [];
  const { candidates: family, capped } =
    siblings.length > 0 ? await familyCandidates(mb, siblings) : { candidates: [], capped: false };
  const shared = mb.requests;
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
    const before = mb.requests;
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
        mb,
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
      requests: mb.requests - before,
      familyCapped: capped,
    });
  }
  flagSharedProposals(outcomes);
  // The family reads served every track on the album; charge them to the first.
  if (outcomes[0]) outcomes[0].requests += shared;
  return outcomes;
}

export const proposalGroupKey = (gap: ProposalGap) =>
  gap.releaseMbid ?? `recording:${gap.recordingMbid}`;

// A decision survives a re-run that proposes the same work; a different work returns to `proposed`.
export async function storeProposals(outcomes: ProposalOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;
  await db
    .insert(mbWorkProposal)
    .values(
      outcomes.map((outcome) => ({
        recordingMbid: outcome.recordingMbid,
        releaseMbid: outcome.releaseMbid,
        proposal: outcome.proposal,
        workMbid: outcome.proposal?.workMbid ?? null,
        requests: outcome.requests,
      })),
    )
    .onConflictDoUpdate({
      target: mbWorkProposal.recordingMbid,
      set: {
        releaseMbid: sql`excluded.release_mbid`,
        proposal: sql`excluded.proposal`,
        workMbid: sql`excluded.work_mbid`,
        requests: sql`excluded.requests`,
        checkedAt: sql`excluded.checked_at`,
        status: sql`case when ${mbWorkProposal.workMbid} is excluded.work_mbid
          then ${mbWorkProposal.status} else 'proposed' end`,
        decidedAt: sql`case when ${mbWorkProposal.workMbid} is excluded.work_mbid
          then ${mbWorkProposal.decidedAt} else null end`,
      },
    });
}
