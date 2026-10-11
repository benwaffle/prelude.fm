/**
 * Our own track-to-work links, for library tracks with no MusicBrainz
 * recording (usually because their release is not on MusicBrainz yet).
 *
 *   pnpm metadata:track-work-links                 tracks never checked
 *   pnpm metadata:track-work-links --refresh       every such track, again
 *   pnpm metadata:track-work-links --unlinked      again, every album with a track left unlinked
 *   pnpm metadata:track-work-links --unlinked --checked-before <iso>
 *                                                  only tracks last checked before then, so a
 *                                                  rerun after a failure resumes
 *   pnpm metadata:track-work-links --album <id>    one Spotify album
 *   pnpm metadata:track-work-links --albums 5      stop after five albums
 *   pnpm metadata:track-work-links --no-store      store no links (works read are still cached)
 *   pnpm metadata:track-work-links --json
 *
 * Spends MusicBrainz requests on the backfill channel, through the gateway.
 * Writes `track_work_link`, the works it reads into the cache, and the
 * classification of linked tracks (unless --no-store). Submits nothing.
 *
 * Caching the works suggested links name, and re-deriving every track's
 * classification, are `metadata:cache-proposed-works` and
 * `metadata:reclassify`.
 */
import { defineScript, UsageError } from './lib/cli';
import { runSweepCli, SWEEP_OPTIONS } from './lib/sweep-cli';

defineScript(
  {
    options: {
      ...SWEEP_OPTIONS,
      album: { type: 'string' },
      unlinked: { type: 'boolean' },
      'checked-before': { type: 'string' },
    },
  },
  async ({ options }) => {
    const before = options['checked-before'] ? new Date(options['checked-before']) : null;
    if (before && Number.isNaN(before.getTime())) {
      throw new UsageError(`--checked-before must be a date, not "${options['checked-before']}"`);
    }
    const [run, { groupBy, unstored }, { trackWorkLink }] = await Promise.all([
      import('@/lib/track-work-links-run'),
      import('@/lib/backfill-sweep'),
      import('@/lib/db/schema'),
    ]);

    let gaps = await run.loadLinkGaps();
    if (options.album) gaps = gaps.filter((gap) => gap.albumId === options.album);
    if (options.unlinked) {
      // Whole albums, so the parts found on their linked tracks help the rest.
      const open = await run.unlinkedTracks(
        gaps.map((gap) => gap.spotifyTrackId),
        before,
      );
      const albumIds = new Set(
        gaps.filter((gap) => open.has(gap.spotifyTrackId)).map((gap) => gap.albumId),
      );
      gaps = gaps.filter((gap) => albumIds.has(gap.albumId));
    } else if (!options.refresh) {
      gaps = await unstored(
        gaps,
        (gap) => gap.spotifyTrackId,
        trackWorkLink,
        trackWorkLink.spotifyTrackId,
      );
    }

    let reclassified = 0;
    await runSweepCli(options, {
      groups: groupBy(gaps, (gap) => gap.albumId),
      process: run.linkAlbum,
      store: async (outcomes) => {
        reclassified += await run.storeLinks(outcomes);
      },
      buckets: ['linked', 'heldBack', 'none'] as const,
      tally: ({ match }) => (match?.linked ? 'linked' : match ? 'heldBack' : 'none'),
      line: ({ match, title }) => {
        const work = !match
          ? ''
          : match.parentTitle && !match.title.startsWith(match.parentTitle)
            ? `${match.parentTitle}: ${match.title}`
            : match.title;
        return match?.linked
          ? `linked  ${title}  →  ${work}`
          : match
            ? `held    ${title}  →  ${work}  (${match.confidence}; ${match.heldBack})`
            : `none    ${title}`;
      },
      label: (group) => group[0].albumTitle,
      summary: ({ outcomes, counts }) =>
        `${outcomes.length} tracks: ${counts.linked} linked, ${counts.heldBack} with a guess held back, ${counts.none} with nothing found.${options['no-store'] ? '' : ` ${reclassified} classifications updated.`}`,
      extra: () => ({ reclassified }),
    });
  },
);
