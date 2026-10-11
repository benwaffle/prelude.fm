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
import { and, inArray, isNull, sql } from 'drizzle-orm';
import { loadDerivedMusicBrainzLibraryFacts } from '@/app/actions/library-musicbrainz';
import { db } from './db';
import { trackClassification, trackWorkLink } from './db/schema';
import {
  cataloguesOf,
  composerOf,
  musicBrainzApi,
  parentPartOf,
  type MbRelation,
  type MbWork,
} from './musicbrainz';
import { ingestWorkTree, readAndCacheWork } from './musicbrainz-cache';
import { classificationMayBeReplaced } from './track-classification';
import {
  asTrackWorkMatch,
  cleanTrackTitle,
  confirmedPart,
  confirmWork,
  unlinkSharedMatches,
  type TrackWorkMatch,
} from './track-work-links';
import { searchCandidates, type Counter } from './work-proposals-run';
import {
  normalizeTitle,
  numberRefs,
  proposeWork,
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

export function groupByAlbum(gaps: LinkGap[]): LinkGap[][] {
  const groups = new Map<string, LinkGap[]>();
  for (const gap of gaps) groups.set(gap.albumId, [...(groups.get(gap.albumId) ?? []), gap]);
  return [...groups.values()];
}

export type LinkOutcome = {
  spotifyTrackId: string;
  title: string;
  albumTitle: string;
  match: TrackWorkMatch | null;
  requests: number;
};

function childParts(relations: MbRelation[] | undefined) {
  return (relations ?? []).flatMap((relation) =>
    relation.type === 'parts' && relation.direction === 'forward' && relation.work
      ? [
          {
            id: relation.work.id,
            title: relation.work.title,
            orderingKey: relation['ordering-key'] ?? null,
          },
        ]
      : [],
  );
}

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
  const credited = artistNames.map((name) => normalizeTitle(name).split(/[^a-z]+/));
  return rows
    .filter((row) => {
      const surname = row.composer
        ? normalizeTitle(row.composer)
            .split(/[^a-z]+/)
            .filter(Boolean)
            .at(-1)
        : undefined;
      return surname !== undefined && credited.some((words) => words.includes(surname));
    })
    .map((row) => row.work_mbid)
    .slice(0, 3);
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return (2 * shared) / (a.size + b.size);
}

/** Search hits worth reading when nothing scored: the closest titles, composer or not. */
const PROMISING_SEARCH_HITS = 2;
const PROMISING_TITLE_SCORE = 0.6;

/** Links for every gap on one Spotify album. */
export async function linkAlbum(gaps: LinkGap[]): Promise<LinkOutcome[]> {
  const source = musicBrainzApi('backfill');
  const family: ProposalCandidate[] = [];
  const read = new Map<string, MbWork | null>();
  const opened = new Set<string>();
  const siblings: AlbumSibling[] = [];
  const outcomes: LinkOutcome[] = [];

  const readWork = async (counter: Counter, mbid: string) => {
    if (read.has(mbid)) return read.get(mbid) ?? null;
    counter.requests++;
    const work = await readAndCacheWork(source, mbid);
    read.set(mbid, work);
    return work;
  };

  /** Read a work and offer its parts to this and the following tracks. */
  const openWork = async (counter: Counter, mbid: string) => {
    const work = await readWork(counter, mbid);
    if (!work || opened.has(work.id)) return work;
    opened.add(work.id);
    const composer = composerOf(work)?.name ?? null;
    for (const part of childParts(work.relations)) {
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
  const expand = async (counter: Counter, mbid: string) => {
    const work = await readWork(counter, mbid);
    if (!work) return null;
    const parent = parentPartOf(work);
    if (!parent) {
      await openWork(counter, work.id);
      return null;
    }
    const parentWork = await openWork(counter, parent.id);
    const grandparent = parentWork ? parentPartOf(parentWork) : null;
    if (grandparent && !read.has(grandparent.id)) {
      counter.requests += (await ingestWorkTree(source, grandparent.id)).requests;
    }
    return parent;
  };

  for (const gap of gaps) {
    const counter: Counter = { requests: 0 };
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
      for (const mbid of unread) await openWork(counter, mbid);
      if (unread.length > 0) match = confirmed() ?? match;
    }
    let found: ProposalCandidate[] = [];
    if (!match?.linked) {
      found = await searchCandidates(counter, title, gap.artistNames);
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
      for (const { candidate } of promising) await expand(counter, candidate.workMbid);
      if (promising.length > 0) {
        match = confirmed() ?? propose([...family, ...found]) ?? match;
      }
    }
    if (match?.linked) {
      const parent = await expand(counter, match.workMbid);
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
      requests: counter.requests,
    });
  }
  unlinkSharedMatches(outcomes);
  return outcomes;
}

/** Store outcomes, replacing whatever an earlier run stored for these tracks. */
export async function storeLinks(outcomes: LinkOutcome[]): Promise<void> {
  for (const outcome of outcomes) {
    const row = {
      spotifyTrackId: outcome.spotifyTrackId,
      workMbid: outcome.match?.linked ? outcome.match.workMbid : null,
      match: outcome.match,
      requests: outcome.requests,
      checkedAt: new Date(),
    };
    await db
      .insert(trackWorkLink)
      .values(row)
      .onConflictDoUpdate({ target: trackWorkLink.spotifyTrackId, set: row });
  }
}

/**
 * Re-derive the stored classification of these tracks: after a link gives
 * them a work, or after the classical rule changes.
 *
 * The same reading the album pipeline makes, through the same facts loader,
 * and under the same precedence: a hand decision is never replaced, and like
 * the pipeline this never writes one (the film-score exclusion is applied as
 * tracks are read, not stored). Returns how many rows changed.
 */
export async function reclassify(spotifyTrackIds: string[]): Promise<number> {
  let changed = 0;
  for (let start = 0; start < spotifyTrackIds.length; start += 500) {
    const chunk = spotifyTrackIds.slice(start, start + 500);
    const facts = await loadDerivedMusicBrainzLibraryFacts(chunk);
    const existingRows = await db
      .select()
      .from(trackClassification)
      .where(inArray(trackClassification.spotifyTrackId, chunk));
    const existing = new Map(existingRows.map((row) => [row.spotifyTrackId, row]));
    const decidedAt = new Date();
    for (const classification of facts.classifications) {
      if (classification.provenance === 'manual') continue;
      const previous = existing.get(classification.spotifyTrackId);
      // A track with no stored row is classified as it is read, from the
      // same evidence, so there is nothing stale to replace.
      if (!previous || !classificationMayBeReplaced(previous, classification)) continue;
      if (
        previous?.state === classification.state &&
        previous.provenance === classification.provenance &&
        previous.reason === classification.reason
      ) {
        continue;
      }
      const row = {
        spotifyTrackId: classification.spotifyTrackId,
        state: classification.state,
        provenance: classification.provenance,
        reason: classification.reason,
        evidenceMbid: null,
        decidedAt,
      };
      await db
        .insert(trackClassification)
        .values(row)
        .onConflictDoUpdate({ target: trackClassification.spotifyTrackId, set: row });
      changed++;
    }
  }
  return changed;
}

/** Tracks that already have a stored link or a stored "nothing found". */
export async function checkedTracks(spotifyTrackIds: string[]): Promise<Set<string>> {
  const checked = new Set<string>();
  for (let start = 0; start < spotifyTrackIds.length; start += 400) {
    const rows = await db
      .select({ spotifyTrackId: trackWorkLink.spotifyTrackId })
      .from(trackWorkLink)
      .where(inArray(trackWorkLink.spotifyTrackId, spotifyTrackIds.slice(start, start + 400)));
    for (const row of rows) checked.add(row.spotifyTrackId);
  }
  return checked;
}

/** Of these tracks, those checked and left without a link. */
export async function unlinkedTracks(spotifyTrackIds: string[]): Promise<Set<string>> {
  const unlinked = new Set<string>();
  for (let start = 0; start < spotifyTrackIds.length; start += 400) {
    const rows = await db
      .select({ spotifyTrackId: trackWorkLink.spotifyTrackId })
      .from(trackWorkLink)
      .where(
        and(
          inArray(trackWorkLink.spotifyTrackId, spotifyTrackIds.slice(start, start + 400)),
          isNull(trackWorkLink.workMbid),
        ),
      );
    for (const row of rows) unlinked.add(row.spotifyTrackId);
  }
  return unlinked;
}

export async function allTrackIds(): Promise<string[]> {
  const rows = await db.all<{ spotify_id: string }>(sql`select spotify_id from spotify_track`);
  return rows.map((row) => row.spotify_id);
}

/**
 * Read into the cache every work a suggested work link names, so the player
 * can show it under its composer and parent. Works already read cost nothing.
 */
export async function cacheProposedWorks(): Promise<{ works: number; requests: number }> {
  const rows = await db.all<{ work_mbid: string }>(sql`
    select distinct json_extract(proposal, '$.workMbid') as work_mbid
    from mb_work_proposal
    where status <> 'dismissed' and json_extract(proposal, '$.workMbid') is not null
  `);
  const source = musicBrainzApi('backfill');
  let requests = 0;
  for (const row of rows) requests += (await ingestWorkTree(source, row.work_mbid)).requests;
  return { works: rows.length, requests };
}
