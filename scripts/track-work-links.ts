/**
 * Our own track-to-work links, for library tracks with no MusicBrainz
 * recording (usually because their release is not on MusicBrainz yet).
 *
 *   pnpm metadata:track-work-links                 tracks never checked
 *   pnpm metadata:track-work-links --refresh       every such track, again
 *   pnpm metadata:track-work-links --unlinked      again, every album with a track left unlinked
 *   pnpm metadata:track-work-links --album <id>    one Spotify album
 *   pnpm metadata:track-work-links --albums 5      stop after five albums
 *   pnpm metadata:track-work-links --no-store      store no links (works read are still cached)
 *   pnpm metadata:track-work-links --works         cache the works suggested work links name
 *   pnpm metadata:track-work-links --reclassify    re-derive every track's classification
 *   pnpm metadata:track-work-links --json
 *
 * Spends MusicBrainz requests on the backfill channel, through the gateway.
 * Writes `track_work_link`, the works it reads into the cache, and the
 * classification of linked tracks (unless --no-store). Submits nothing.
 */
import { loadEnvConfig } from '@next/env';

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main() {
  loadEnvConfig(process.cwd());
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required (put it in .env.local or export it)');
  }
  const json = process.argv.includes('--json');
  const store = !process.argv.includes('--no-store');
  const refresh = process.argv.includes('--refresh');
  const album = option('--album');
  const albums = option('--albums');

  const run = await import('@/lib/track-work-links-run');

  if (process.argv.includes('--works')) {
    const { requests, works } = await run.cacheProposedWorks();
    console.log(`${works} suggested works read into the cache, ${requests} MusicBrainz requests.`);
    process.exit(0);
  }
  if (process.argv.includes('--reclassify')) {
    const changed = await run.reclassify(await run.allTrackIds());
    console.log(`${changed} classifications updated.`);
    process.exit(0);
  }

  let gaps = await run.loadLinkGaps();
  if (album) gaps = gaps.filter((gap) => gap.albumId === album);
  if (process.argv.includes('--unlinked')) {
    // Whole albums, so the parts found on their linked tracks help the rest.
    const open = await run.unlinkedTracks(gaps.map((gap) => gap.spotifyTrackId));
    const albumIds = new Set(
      gaps.filter((gap) => open.has(gap.spotifyTrackId)).map((gap) => gap.albumId),
    );
    gaps = gaps.filter((gap) => albumIds.has(gap.albumId));
  } else if (!refresh) {
    const done = await run.checkedTracks(gaps.map((gap) => gap.spotifyTrackId));
    gaps = gaps.filter((gap) => !done.has(gap.spotifyTrackId));
  }
  let groups = run.groupByAlbum(gaps);
  if (albums) groups = groups.slice(0, Number(albums));

  const all = [];
  const counts = { linked: 0, heldBack: 0, none: 0 };
  let requests = 0;
  let reclassified = 0;
  for (const [index, group] of groups.entries()) {
    const outcomes = await run.linkAlbum(group);
    if (store) {
      await run.storeLinks(outcomes);
      reclassified += await run.reclassify(
        outcomes
          .filter((outcome) => outcome.match?.linked)
          .map((outcome) => outcome.spotifyTrackId),
      );
    }
    for (const outcome of outcomes) {
      const match = outcome.match;
      counts[match?.linked ? 'linked' : match ? 'heldBack' : 'none']++;
      requests += outcome.requests;
      if (!json) {
        const work = !match
          ? ''
          : match.parentTitle && !match.title.startsWith(match.parentTitle)
            ? `${match.parentTitle}: ${match.title}`
            : match.title;
        console.log(
          match?.linked
            ? `linked  ${outcome.title}  →  ${work}`
            : match
              ? `held    ${outcome.title}  →  ${work}  (${match.confidence}; ${match.heldBack})`
              : `none    ${outcome.title}`,
        );
      }
    }
    if (!json) console.error(`[${index + 1}/${groups.length}] ${group[0].albumTitle}`);
    all.push(...outcomes);
  }

  if (json) {
    console.log(
      JSON.stringify({ stored: store, requests, counts, reclassified, outcomes: all }, null, 2),
    );
  } else {
    console.log(
      `\n${all.length} tracks: ${counts.linked} linked, ${counts.heldBack} with a guess held back, ${counts.none} with nothing found. ${requests} MusicBrainz requests.${store ? ` ${reclassified} classifications updated.` : ' Nothing stored.'}`,
    );
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});
