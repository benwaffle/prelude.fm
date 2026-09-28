/**
 * Prepares our release-editor seed for a missing album and stores it.
 *
 * Uses the album's stored pre-check (running it first if there is none) for
 * ISRC hits, artists and release-group candidates, re-reads the Spotify
 * album for its date and label, and — for a new edition — reads the
 * tracklists of existing releases in the matched group so recordings can be
 * pre-filled by position. Those reads go through the gateway on the
 * `interactive` channel: about one browse per group and one read per
 * candidate release, capped at `EDITION_LIMIT`.
 */
import { eq, inArray } from 'drizzle-orm';
import { db, type DatabaseExecutor } from './db';
import { mbReleaseSeed } from './db/schema';
import { mbGet } from './musicbrainz';
import type { MusicBrainzChannel } from './musicbrainz-gateway';
import { candidateGroups, strongCandidate, type ReleasePrecheck } from './release-precheck';
import {
  cachedReleasePrechecks,
  loadReleaseSeed,
  refreshReleasePrecheck,
} from './release-precheck-run';
import {
  editionsShapedLike,
  planSeed,
  type EditionTracklist,
  type SeedPlan,
} from './release-seeding';

const CHANNEL: MusicBrainzChannel = 'interactive';
/** Existing releases read for their tracklists, across all matched groups. */
export const EDITION_LIMIT = 3;

type Counter = { requests: number };

async function counted<T>(counter: Counter, path: string): Promise<T | null> {
  counter.requests++;
  return mbGet<T>(path, CHANNEL);
}

/** Existing releases in these groups with the album's disc/track shape, with their tracklists. */
async function loadEditions(
  counter: Counter,
  groupMbids: string[],
  seed: Parameters<typeof editionsShapedLike>[0],
): Promise<{ editions: EditionTracklist[]; notes: string[] }> {
  const editions: EditionTracklist[] = [];
  const notes: string[] = [];
  const perDisc = new Map<number, number>();
  for (const track of seed.tracks) perDisc.set(track.disc, (perDisc.get(track.disc) ?? 0) + 1);
  const ourShape = [...perDisc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, n]) => n)
    .join(',');

  for (const group of groupMbids) {
    if (editions.length >= EDITION_LIMIT) break;
    const browse = await counted<{
      releases?: {
        id: string;
        title: string;
        media?: { position?: number; 'track-count'?: number }[];
      }[];
    }>(counter, `/release?release-group=${group}&inc=media&limit=50&fmt=json`);
    const shaped = (browse?.releases ?? []).filter(
      (release) =>
        (release.media ?? []).map((medium) => medium['track-count'] ?? 0).join(',') === ourShape,
    );
    if (shaped.length === 0) {
      notes.push(
        `No release in group ${group} has the same discs and track counts, so positions were not used.`,
      );
    }
    for (const release of shaped) {
      if (editions.length >= EDITION_LIMIT) break;
      const raw = await counted<{
        id: string;
        title: string;
        media?: {
          position?: number;
          tracks?: {
            position?: number;
            title?: string;
            length?: number | null;
            recording?: { id: string };
          }[];
        }[];
      }>(counter, `/release/${release.id}?inc=recordings&fmt=json`);
      if (!raw) continue;
      editions.push({
        releaseMbid: raw.id,
        releaseTitle: raw.title,
        tracks: (raw.media ?? []).flatMap((medium, mediumIndex) =>
          (medium.tracks ?? []).flatMap((track, trackIndex) =>
            track.recording
              ? [
                  {
                    medium: medium.position ?? mediumIndex + 1,
                    position: track.position ?? trackIndex + 1,
                    title: track.title ?? '',
                    lengthMs: track.length ?? null,
                    recordingMbid: track.recording.id,
                  },
                ]
              : [],
          ),
        ),
      });
    }
  }
  return { editions: editionsShapedLike(seed, editions), notes };
}

/** The pre-check's strong release-group candidates (shared performer or recordings). */
export function strongGroupsOf(precheck: ReleasePrecheck) {
  return candidateGroups(
    precheck.seed,
    precheck.releases.state === 'done' ? precheck.releases.value : [],
    precheck.groups.state === 'done' ? precheck.groups.value : [],
    precheck.isrcs.state === 'done' ? precheck.isrcs.value.hits : [],
    precheck.artists,
  ).filter(strongCandidate);
}

export type PreparedSeed = {
  plan: SeedPlan;
  requests: number;
  preparedAt: Date;
  seededAt: Date | null;
};

/** Build the seed plan live. Writes only the pre-check cache, if it had to run one. */
export async function buildReleaseSeed(
  albumId: string,
  database: DatabaseExecutor = db,
): Promise<{ plan: SeedPlan; requests: number }> {
  const precheck =
    (await cachedReleasePrechecks([albumId], database)).get(albumId)?.result ??
    (await refreshReleasePrecheck(albumId, database));
  const fresh = await loadReleaseSeed(albumId, database);
  const notes: string[] = [];
  // The pre-check's ISRC hits and artists describe its own read of the album;
  // a fresh read that disagrees on the tracks would mis-assign them.
  const sameTracks =
    fresh.source === 'spotify' &&
    fresh.tracks.length === precheck.seed.tracks.length &&
    fresh.tracks.every((track) =>
      precheck.seed.tracks.some(
        (theirs) =>
          theirs.disc === track.disc &&
          theirs.position === track.position &&
          theirs.isrc === track.isrc,
      ),
    );
  const seed = sameTracks ? fresh : precheck.seed;
  if (!sameTracks) {
    notes.push(
      fresh.source === 'spotify'
        ? 'Spotify’s tracklist changed since the pre-check; seeded from the pre-check’s copy. Run the pre-check again to refresh.'
        : 'Spotify could not be read; seeded from the pre-check’s copy (no date or label).',
    );
  }

  const counter: Counter = { requests: 0 };
  const groups = strongGroupsOf(precheck);
  let editions: EditionTracklist[] = [];
  if (groups.length > 0) {
    try {
      const loaded = await loadEditions(
        counter,
        groups.map((group) => group.mbid),
        seed,
      );
      editions = loaded.editions;
      notes.push(...loaded.notes);
    } catch (error) {
      notes.push(
        `Couldn't read the existing releases (${error instanceof Error ? error.message : String(error)}); positions were not used.`,
      );
    }
  }

  const planned = planSeed({
    seed,
    artists: precheck.artists,
    isrcHits: precheck.isrcs.state === 'done' ? precheck.isrcs.value.hits : [],
    strongGroups: groups,
    editions,
  });
  if (precheck.isrcs.state !== 'done') {
    notes.push(
      'The ISRC lookup did not run in the pre-check, so no recording was matched by ISRC.',
    );
  }
  return { plan: { ...planned, notes }, requests: counter.requests };
}

/** Build and store the seed; returns what was stored. */
export async function prepareReleaseSeed(
  albumId: string,
  database: DatabaseExecutor = db,
): Promise<PreparedSeed> {
  const { plan, requests } = await buildReleaseSeed(albumId, database);
  const preparedAt = new Date();
  await database
    .insert(mbReleaseSeed)
    .values({ spotifyAlbumId: albumId, plan, requests, preparedAt, seededAt: null })
    .onConflictDoUpdate({
      target: mbReleaseSeed.spotifyAlbumId,
      set: { plan, requests, preparedAt, seededAt: null },
    });
  return { plan, requests, preparedAt, seededAt: null };
}

/** The person opened the seed on MusicBrainz. */
export async function markReleaseSeeded(albumId: string, database: DatabaseExecutor = db) {
  await database
    .update(mbReleaseSeed)
    .set({ seededAt: new Date() })
    .where(eq(mbReleaseSeed.spotifyAlbumId, albumId));
}

/** Stored seeds for these albums. Spends no requests. */
export async function cachedReleaseSeeds(
  albumIds: string[],
  database: DatabaseExecutor = db,
): Promise<Map<string, PreparedSeed>> {
  if (albumIds.length === 0) return new Map();
  const rows = await database
    .select()
    .from(mbReleaseSeed)
    .where(inArray(mbReleaseSeed.spotifyAlbumId, albumIds));
  return new Map(
    rows.map((row) => [
      row.spotifyAlbumId,
      {
        plan: { ...row.plan, notes: row.plan.notes ?? [] },
        requests: row.requests,
        preparedAt: row.preparedAt,
        seededAt: row.seededAt,
      },
    ]),
  );
}
