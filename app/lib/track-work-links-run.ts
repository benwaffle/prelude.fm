/**
 * Links library tracks that have no MusicBrainz recording straight to a
 * MusicBrainz work, and stores the links in `track_work_link`.
 *
 * An album is walked in track order. Each track is first offered the parts of
 * works earlier tracks on the album were linked to — the next movement of the
 * same suite needs no search — and only then a MusicBrainz work search on
 * its title and credited artists. A linked work, its parent and the parent's
 * ancestors are read into the cache, both because the reader needs them and
 * because the parent's parts are what the next tracks are offered.
 *
 * Every request goes through the gateway on the `backfill` channel. Writes
 * `track_work_link`, the works it reads into `mb_*`, and the classification of
 * the tracks it links. Submits nothing to MusicBrainz.
 */
import { and, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import { loadDerivedMusicBrainzLibraryFacts } from '@/app/actions/library-musicbrainz';
import { db, type DatabaseExecutor } from './db';
import { mbWorkProposal, trackClassification, trackWorkLink } from './db/schema';
import { cataloguesOf, childPartsOf, composerOf, parentPartOf, type MbWork } from './musicbrainz';
import { createMbSession } from './musicbrainz-session';
import { classificationMayBeReplaced } from './track-classification';
import {
  asTrackWorkMatch,
  cleanTrackTitle,
  confirmedPart,
  confirmWork,
  unlinkSharedMatches,
  type TrackWorkMatch,
} from './track-work-links';
import { searchCandidates } from './work-proposals-run';
import {
  dice,
  nameWords,
  numberRefs,
  proposeWork,
  surnameOf,
  titleTokens,
  type AlbumSibling,
  type ProposalCandidate,
  type ProposalTarget,
} from './work-proposals';

export type LinkGap = {
  spotifyTrackId: string;
  title: string;
  albumId: string;
  albumTitle: string;
  discNumber: number;
  trackNumber: number;
  artistNames: string[];
};

/**
 * Library tracks with no MusicBrainz recording that nobody has ruled out as
 * not classical, in album order.
 */
export async function loadLinkGaps(): Promise<LinkGap[]> {
  const rows = await db.all<{
    spotify_id: string;
    title: string;
    album_id: string;
    album_title: string;
    disc_number: number;
    track_number: number;
    artists: string | null;
  }>(sql`
    select t.spotify_id, t.title, t.spotify_album_id as album_id, a.title as album_title,
      t.disc_number, t.track_number,
      (select group_concat(sa.name, char(31)) from track_artists ta
        join spotify_artist sa on sa.spotify_id = ta.spotify_artist_id
        where ta.spotify_track_id = t.spotify_id) as artists
    from spotify_track t
    join spotify_album a on a.spotify_id = t.spotify_album_id
    left join track_classification c on c.spotify_track_id = t.spotify_id
    where not exists (select 1 from track_recording tr where tr.spotify_track_id = t.spotify_id)
      and coalesce(c.state, 'unreviewed') <> 'not_classical'
    order by a.spotify_id, t.disc_number, t.track_number
  `);
  return rows.map((row) => ({
    spotifyTrackId: row.spotify_id,
    title: row.title,
    albumId: row.album_id,
    albumTitle: row.album_title,
    discNumber: row.disc_number,
    trackNumber: row.track_number,
    artistNames: (row.artists ?? '').split('\u001f').filter(Boolean),
  }));
}

export type LinkOutcome = {
  spotifyTrackId: string;
  title: string;
  albumTitle: string;
  match: TrackWorkMatch | null;
  requests: number;
};

/** Catalogue systems a title's `numberRefs` key can be filed under in `mb_work_catalogue`. */
const CATALOGUE_SYSTEMS: Record<string, string[]> = {
  bwv: ['bwv'],
  hwv: ['hwv'],
  rv: ['rv'],
  k: ['k', 'kv', 'kochelverzeichnis'],
  d: ['d'],
  woo: ['woo'],
  op: ['op'],
  zwv: ['zwv'],
  twv: ['twv'],
  wq: ['wq'],
  sz: ['sz'],
  bb: ['bb'],
  fwv: ['fwv'],
  wab: ['wab'],
};

/**
 * Cached works carrying a catalogue number the title states, by a composer
 * credited on the track. Costs no request: the cache already holds every
 * work any library recording performs.
 */
/**
 * Rows read before the composer filter. "Op. 9" alone matches many composers'
 * works, so a small cap can cut off the credited composer's.
 */
const CATALOGUE_ROWS = 500;

async function cachedCatalogueWorks(title: string, artistNames: string[]): Promise<string[]> {
  const conditions = [...numberRefs(title)].flatMap(([system, numbers]) =>
    (CATALOGUE_SYSTEMS[system] ?? []).flatMap((normalized) =>
      [...numbers].map(
        (number) =>
          sql`(c.normalized_system = ${normalized} and ltrim(c.normalized_number, '0') = ${number})`,
      ),
    ),
  );
  if (conditions.length === 0) return [];
  const rows = await db.all<{ work_mbid: string; composer: string | null }>(sql`
    select distinct c.work_mbid, a.name as composer
    from mb_work_catalogue c
    join mb_work w on w.mbid = c.work_mbid
    left join mb_artist a on a.mbid = w.composer_mbid
    where ${sql.join(conditions, sql` or `)}
    limit ${CATALOGUE_ROWS}
  `);
  const credited = artistNames.map(nameWords);
  return rows
    .filter((row) => {
      const surname = row.composer ? surnameOf(row.composer) : null;
      return surname !== null && credited.some((words) => words.includes(surname));
    })
    .map((row) => row.work_mbid)
    .slice(0, 3);
}

/** Search hits worth reading when nothing scored: the closest titles, composer or not. */
const PROMISING_SEARCH_HITS = 2;
const PROMISING_TITLE_SCORE = 0.6;

/** Links for every gap on one Spotify album. */
export async function linkAlbum(gaps: LinkGap[]): Promise<LinkOutcome[]> {
  const mb = createMbSession('backfill');
  const family: ProposalCandidate[] = [];
  const read = new Map<string, MbWork | null>();
  const opened = new Set<string>();
  const siblings: AlbumSibling[] = [];
  const outcomes: LinkOutcome[] = [];

  const readWork = async (mbid: string) => {
    if (read.has(mbid)) return read.get(mbid) ?? null;
    const work = await mb.readAndCacheWork(mbid);
    read.set(mbid, work);
    return work;
  };

  /** Read a work and offer its parts to this and the following tracks. */
  const openWork = async (mbid: string) => {
    const work = await readWork(mbid);
    if (!work || opened.has(work.id)) return work;
    opened.add(work.id);
    const composer = composerOf(work)?.name ?? null;
    for (const part of childPartsOf(work)) {
      family.push({
        workMbid: part.id,
        title: part.title,
        parentMbid: work.id,
        parentTitle: work.title,
        orderingKey: part.orderingKey,
        composerName: composer,
        aliases: [],
        source: 'album',
      });
    }
    return work;
  };

  /**
   * Read a work, open its parent (or the work itself when it has none), and
   * cache the rest of its ancestry. Returns the work's place in its parent.
   */
  const expand = async (mbid: string) => {
    const work = await readWork(mbid);
    if (!work) return null;
    const parent = parentPartOf(work);
    if (!parent) {
      await openWork(work.id);
      return null;
    }
    const parentWork = await openWork(parent.id);
    const grandparent = parentWork ? parentPartOf(parentWork) : null;
    if (grandparent && !read.has(grandparent.id)) await mb.ingestWorkTree(grandparent.id);
    return parent;
  };

  for (const gap of gaps) {
    const before = mb.requests;
    const title = cleanTrackTitle(gap.title, gap.artistNames);
    const target: ProposalTarget = {
      recordingMbid: gap.spotifyTrackId,
      title,
      medium: gap.discNumber,
      position: gap.trackNumber,
      artistNames: gap.artistNames,
      // Composers of other tracks are our own guesses here, not MusicBrainz
      // links, so they do not count as the album crediting the composer.
      releaseComposers: [],
      siblings: [...siblings],
    };
    const propose = (candidates: ProposalCandidate[]) => {
      const proposal = proposeWork(target, candidates);
      return proposal ? asTrackWorkMatch(proposal) : null;
    };
    /** The one part of a work read so far that catalogue number and composer pin down. */
    const confirmed = () => {
      const matches = new Map<string, TrackWorkMatch>();
      for (const work of read.values()) {
        if (!work) continue;
        const confirmation = confirmWork(title, gap.artistNames, {
          workMbid: work.id,
          title: work.title,
          composerName: composerOf(work)?.name ?? null,
          catalogueNumbers: cataloguesOf(work).map((catalogue) => catalogue.number),
        });
        const match = confirmation ? confirmedPart(target, confirmation, family) : null;
        if (match) matches.set(match.workMbid, match);
      }
      return matches.size === 1 ? [...matches.values()][0] : null;
    };

    let match = propose(family);
    if (!match?.linked) match = confirmed() ?? match;
    if (!match?.linked) {
      const unread = (await cachedCatalogueWorks(title, gap.artistNames)).filter(
        (mbid) => !read.has(mbid),
      );
      for (const mbid of unread) await openWork(mbid);
      if (unread.length > 0) match = confirmed() ?? match;
    }
    let found: ProposalCandidate[] = [];
    if (!match?.linked) {
      found = await searchCandidates(mb, title, gap.artistNames);
      match = propose([...family, ...found]) ?? match;
    }
    if (!match?.linked && found.length > 0) {
      // MusicBrainz files the composer and the catalogue number on the whole
      // work, not on its movements, so a movement found by search often has
      // neither. Reading the closest few, and their parents, supplies both.
      const tokens = titleTokens(title);
      const promising = found
        .filter((candidate) => !read.has(candidate.workMbid))
        .map((candidate) => ({ candidate, score: dice(tokens, titleTokens(candidate.title)) }))
        .filter(({ score }) => score >= PROMISING_TITLE_SCORE)
        .sort((a, b) => b.score - a.score)
        .slice(0, PROMISING_SEARCH_HITS);
      for (const { candidate } of promising) await expand(candidate.workMbid);
      if (promising.length > 0) {
        match = confirmed() ?? propose([...family, ...found]) ?? match;
      }
    }
    if (match?.linked) {
      const parent = await expand(match.workMbid);
      // "Piano Sonata No. 11: Rondo: Alla turca" is one movement. A whole
      // sonata is the right piece but the wrong level, and the card would
      // show the sonata as if this track were all of it.
      if (title.includes(':') && family.some((part) => part.parentMbid === match!.workMbid)) {
        match = {
          ...match,
          linked: false,
          heldBack: 'The track is one part of the work, but the match is the whole work.',
        };
      } else if (parent) {
        siblings.push({
          medium: gap.discNumber,
          position: gap.trackNumber,
          parentMbid: parent.id,
          orderingKey: parent.orderingKey,
        });
      }
    }

    outcomes.push({
      spotifyTrackId: gap.spotifyTrackId,
      title,
      albumTitle: gap.albumTitle,
      match,
      requests: mb.requests - before,
    });
  }
  unlinkSharedMatches(outcomes);
  return outcomes;
}

/**
 * Store outcomes, replacing whatever an earlier run stored for these tracks,
 * and re-derive the classification of the tracks they link — in one
 * transaction, so a failure cannot leave links stored under a stale
 * classification. Returns how many classifications changed.
 */
export async function storeLinks(outcomes: LinkOutcome[]): Promise<number> {
  if (outcomes.length === 0) return 0;
  const checkedAt = new Date();
  return db.transaction(async (tx) => {
    await tx
      .insert(trackWorkLink)
      .values(
        outcomes.map((outcome) => ({
          spotifyTrackId: outcome.spotifyTrackId,
          workMbid: outcome.match?.linked ? outcome.match.workMbid : null,
          match: outcome.match,
          requests: outcome.requests,
          checkedAt,
        })),
      )
      .onConflictDoUpdate({
        target: trackWorkLink.spotifyTrackId,
        set: {
          workMbid: sql`excluded.work_mbid`,
          match: sql`excluded.match`,
          requests: sql`excluded.requests`,
          checkedAt: sql`excluded.checked_at`,
        },
      });
    return reclassify(
      outcomes.filter((outcome) => outcome.match?.linked).map((outcome) => outcome.spotifyTrackId),
      tx,
    );
  });
}

/**
 * Re-derive the stored classification of these tracks: after a link gives
 * them a work, or after the classical rule changes.
 *
 * The same reading the album pipeline makes, through the same facts loader,
 * and under the same precedence: a hand decision is never replaced, and like
 * the pipeline this never writes one (the film-score exclusion is applied as
 * tracks are read, not stored). Each chunk is written in one statement.
 * Returns how many rows changed.
 */
export async function reclassify(
  spotifyTrackIds: string[],
  database: DatabaseExecutor = db,
): Promise<number> {
  let changed = 0;
  for (let start = 0; start < spotifyTrackIds.length; start += 500) {
    const chunk = spotifyTrackIds.slice(start, start + 500);
    const facts = await loadDerivedMusicBrainzLibraryFacts(chunk, database);
    const existingRows = await database
      .select()
      .from(trackClassification)
      .where(inArray(trackClassification.spotifyTrackId, chunk));
    const existing = new Map(existingRows.map((row) => [row.spotifyTrackId, row]));
    const decidedAt = new Date();
    const rows = facts.classifications.flatMap((classification) => {
      if (classification.provenance === 'manual') return [];
      const previous = existing.get(classification.spotifyTrackId);
      // A track with no stored row is classified as it is read, from the
      // same evidence, so there is nothing stale to replace.
      if (!previous || !classificationMayBeReplaced(previous, classification)) return [];
      if (
        previous.state === classification.state &&
        previous.provenance === classification.provenance &&
        previous.reason === classification.reason
      ) {
        return [];
      }
      return [
        {
          spotifyTrackId: classification.spotifyTrackId,
          state: classification.state,
          provenance: classification.provenance,
          reason: classification.reason,
          evidenceMbid: null,
          decidedAt,
        },
      ];
    });
    if (rows.length === 0) continue;
    await database
      .insert(trackClassification)
      .values(rows)
      .onConflictDoUpdate({
        target: trackClassification.spotifyTrackId,
        set: {
          state: sql`excluded.state`,
          provenance: sql`excluded.provenance`,
          reason: sql`excluded.reason`,
          evidenceMbid: sql`excluded.evidence_mbid`,
          decidedAt: sql`excluded.decided_at`,
        },
      });
    changed += rows.length;
  }
  return changed;
}

/** Of these tracks, those checked (before `before`, when given) and left without a link. */
export async function unlinkedTracks(
  spotifyTrackIds: string[],
  before: Date | null = null,
): Promise<Set<string>> {
  const unlinked = new Set<string>();
  for (let start = 0; start < spotifyTrackIds.length; start += 400) {
    const rows = await db
      .select({ spotifyTrackId: trackWorkLink.spotifyTrackId })
      .from(trackWorkLink)
      .where(
        and(
          inArray(trackWorkLink.spotifyTrackId, spotifyTrackIds.slice(start, start + 400)),
          isNull(trackWorkLink.workMbid),
          before ? lt(trackWorkLink.checkedAt, before) : undefined,
        ),
      );
    for (const row of rows) unlinked.add(row.spotifyTrackId);
  }
  return unlinked;
}

/**
 * Read into the cache every work a suggested work link names, so the player
 * can show it under its composer and parent. Works already read cost nothing.
 */
export async function cacheProposedWorks(): Promise<{ works: number; requests: number }> {
  const rows = await db
    .selectDistinct({ workMbid: mbWorkProposal.workMbid })
    .from(mbWorkProposal)
    .where(and(ne(mbWorkProposal.status, 'dismissed'), isNotNull(mbWorkProposal.workMbid)));
  const mb = createMbSession('backfill');
  for (const row of rows) await mb.ingestWorkTree(row.workMbid!);
  return { works: rows.length, requests: mb.requests };
}
