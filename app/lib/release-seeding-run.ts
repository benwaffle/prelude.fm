/** Reads go through the gateway's `interactive` channel, capped at `EDITION_LIMIT` releases. */
import { createMbSession, type MbSession } from './musicbrainz-session';
import {
  readMissingReleases,
  writeMissingRelease,
  type MissingRelease,
} from './missing-release-store';
import { precheckHits, strongGroupsOf } from './release-precheck';
import { loadReleaseSeed, refreshReleasePrecheck } from './release-precheck-run';
import type { ReleaseSeed } from './release-seed';
import {
  editionsShapedLike,
  planSeed,
  type EditionTracklist,
  type SeedPlan,
} from './release-seeding';

export { markReleaseSeeded } from './missing-release-store';

export const EDITION_LIMIT = 3;

async function loadEditions(
  mb: MbSession,
  groupMbids: string[],
  seed: ReleaseSeed,
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
    const browse = await mb.get<{
      releases?: {
        id: string;
        title: string;
        media?: { position?: number; 'track-count'?: number }[];
      }[];
    }>(`/release?release-group=${group}&inc=media&limit=50&fmt=json`);
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
      const read = await mb.release(release.id);
      if (!read) continue;
      editions.push({
        releaseMbid: read.id,
        releaseTitle: read.title,
        tracks: read.tracks.map((track) => ({
          medium: track.medium,
          position: track.position,
          title: track.title,
          lengthMs: track.length,
          recordingMbid: track.recording.id,
        })),
      });
    }
  }
  return { editions: editionsShapedLike(seed, editions), notes };
}

export type PreparedSeed = {
  plan: SeedPlan;
  requests: number | null;
  preparedAt: Date;
  seededAt: Date | null;
  /** Preparing again does not replace it. */
  seededPlan: SeedPlan | null;
};

export async function buildReleaseSeed(
  albumId: string,
): Promise<{ plan: SeedPlan; requests: number }> {
  const cached = (await readMissingReleases([albumId])).get(albumId)?.precheck?.value;
  const precheck = cached ?? (await refreshReleasePrecheck(albumId));
  // A pre-check run just now read the album already; only a cached one is re-read.
  const fresh = cached ? await loadReleaseSeed(albumId) : precheck.seed;
  const notes: string[] = [];
  // A fresh read that disagrees on the tracks would mis-assign the pre-check's ISRC hits and
  // artists.
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

  const mb = createMbSession('interactive');
  const groups = strongGroupsOf(precheck);
  let editions: EditionTracklist[] = [];
  if (groups.length > 0) {
    try {
      const loaded = await loadEditions(
        mb,
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
    isrcHits: precheckHits(precheck.isrcs),
    strongGroups: groups,
    editions,
  });
  if (precheck.isrcs.state !== 'done') {
    notes.push(
      'The ISRC lookup did not run in the pre-check, so no recording was matched by ISRC.',
    );
  }
  return { plan: { ...planned, notes }, requests: mb.requests };
}

export async function prepareReleaseSeed(albumId: string): Promise<PreparedSeed> {
  const { plan, requests } = await buildReleaseSeed(albumId);
  await writeMissingRelease(albumId, 'seed', plan, requests);
  const prepared = (await cachedReleaseSeeds([albumId])).get(albumId);
  if (!prepared) throw new Error('The seed was prepared but not stored');
  return prepared;
}

/** Plans stored before notes existed have none. */
const withNotes = (plan: SeedPlan): SeedPlan => ({ ...plan, notes: plan.notes ?? [] });

export function preparedSeedOf({ seed, seeded }: MissingRelease): PreparedSeed | null {
  if (!seed) return null;
  return {
    plan: withNotes(seed.value),
    requests: seed.requests,
    preparedAt: seed.recordedAt,
    seededAt: seeded?.recordedAt ?? null,
    seededPlan: seeded ? withNotes(seeded.value) : null,
  };
}

/** Spends no requests. */
export async function cachedReleaseSeeds(albumIds: string[]): Promise<Map<string, PreparedSeed>> {
  const stored = await readMissingReleases(albumIds);
  return new Map(
    [...stored].flatMap(([albumId, stages]) => {
      const prepared = preparedSeedOf(stages);
      return prepared ? [[albumId, prepared] as const] : [];
    }),
  );
}
