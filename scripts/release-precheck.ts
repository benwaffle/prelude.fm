/**
 * Missing-release pre-checks from the command line, for the albums that
 * would unblock the most library tracks — the same order as the Inbox.
 *
 *   pnpm metadata:release-precheck               top 10, stored in the cache
 *   pnpm metadata:release-precheck --top 20
 *   pnpm metadata:release-precheck --album <id>  one album
 *   pnpm metadata:release-precheck --no-store    run without writing the cache
 *   pnpm metadata:release-precheck --json
 *
 * Spends live MusicBrainz requests on the interactive channel, through the
 * gateway like everything else. Writes only `mb_release_precheck` (unless
 * --no-store); submits nothing.
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
  const top = Number(option('--top') ?? 10);
  const only = option('--album');

  const [{ missingReleases }, { rankMissingReleases }, { loadTracksBlockedOnRelease }, run] =
    await Promise.all([
      import('@/lib/musicbrainz-contributions'),
      import('@/lib/contribution-list'),
      import('@/app/admin/lib/catalogue-readiness-load'),
      import('@/lib/release-precheck-run'),
    ]);
  const ranked = rankMissingReleases(
    await missingReleases(5_000),
    await loadTracksBlockedOnRelease(),
  );
  const albums = only ? ranked.filter((album) => album.albumId === only) : ranked.slice(0, top);
  if (albums.length === 0)
    throw new Error(only ? `${only} is not a missing release` : 'Nothing missing');

  const results = [];
  for (const [index, album] of albums.entries()) {
    const { precheck, requests } = await run.runReleasePrecheck(album.albumId);
    if (store) await run.storeReleasePrecheck(album.albumId, precheck, requests);
    results.push({ rank: index + 1, album, requests, precheck });
    if (json) continue;

    console.log(
      `\n${index + 1}. ${album.albumTitle}  [${album.albumId}]\n` +
        `   ${album.libraryTracks ?? '?'} library tracks unblocked · ${album.tracks} on the album · ${album.reason} · ${requests} MB requests · seed from ${precheck.seed.source}`,
    );
    console.log(`   Really missing? ${precheck.existing.headline}`);
    for (const link of precheck.existing.links) console.log(`     - ${link.label}: ${link.href}`);
    for (const [label, state] of [
      ['release search', precheck.releases],
      ['release group search', precheck.groups],
      ['ISRC lookup', precheck.isrcs],
    ] as const) {
      if (state.state === 'failed') console.log(`   ${label}: couldn't tell — ${state.error}`);
      if (state.state === 'skipped') console.log(`   ${label}: not run — ${state.reason}`);
    }
    if (precheck.isrcs.state === 'done') {
      const found = new Set(precheck.isrcs.value.hits.map((hit) => hit.isrc)).size;
      console.log(
        `   ISRCs: ${found} of ${precheck.isrcs.value.asked} already have a recording; ${precheck.isrcs.value.withoutIsrc} track(s) have no ISRC`,
      );
    }
    console.log('   Artists:');
    for (const artist of precheck.artists) {
      const match = artist.match;
      const mbText =
        match.state === 'linked' || match.state === 'name-match'
          ? `${match.state === 'linked' ? 'linked' : 'name match (not linked)'} → ${match.artist.name}${match.artist.disambiguation ? ` (${match.artist.disambiguation})` : ''} ${match.artist.mbid}`
          : match.state === 'several-linked' || match.state === 'ambiguous'
            ? `${match.state === 'ambiguous' ? "couldn't tell — several share the name" : 'several linked'}: ${match.candidates.map((candidate) => `${candidate.name}${candidate.disambiguation ? ` (${candidate.disambiguation})` : ''} ${candidate.mbid}`).join('; ')}`
            : match.state === 'not-looked-up'
              ? `not looked up (${match.reason})`
              : match.state === 'failed'
                ? `couldn't tell — ${match.error}`
                : 'no MusicBrainz artist found';
      console.log(
        `     - ${artist.name} (${artist.tracks} tracks${artist.onAlbum ? ', album artist' : ''}): ${mbText} · role: ${artist.role === 'couldnt-tell' ? "couldn't tell" : artist.role}${artist.roleWhy ? ` (${artist.roleWhy})` : ''}`,
      );
    }
    console.log('   Checklist:');
    if (precheck.checklist.length === 0) console.log('     - nothing specific found');
    for (const item of precheck.checklist) console.log(`     - ${item.text}`);
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  else {
    const spent = results.reduce((sum, result) => sum + result.requests, 0);
    console.log(
      `\n${results.length} album(s) pre-checked, ${spent} MusicBrainz requests${store ? ', stored' : ', not stored'}.`,
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
