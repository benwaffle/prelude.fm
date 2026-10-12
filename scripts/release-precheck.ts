// Usage: pnpm metadata:release-precheck [--top N] [--album <id>] [--no-store] [--json]
// Spends interactive-channel requests; writes only the `precheck` stage. Submits nothing.
import { defineScript } from './lib/cli';

defineScript(
  {
    options: {
      top: { type: 'integer', min: 1, default: 10 },
      album: { type: 'string' },
      'no-store': { type: 'boolean' },
      json: { type: 'boolean' },
    },
  },
  async ({ options }) => {
    const { json, top, album: only } = options;
    const store = !options['no-store'];

    const [
      { missingReleases },
      { rankMissingReleases },
      { loadTracksBlockedOnRelease },
      run,
      { writeMissingRelease },
    ] = await Promise.all([
      import('@/lib/gaps/missing-releases'),
      import('@/lib/contribution-list'),
      import('@/app/admin/lib/catalogue-readiness-load'),
      import('@/lib/release-precheck-run'),
      import('@/lib/missing-release-store'),
    ]);
    const ranked = rankMissingReleases(
      ...(await Promise.all([missingReleases(), loadTracksBlockedOnRelease()])),
    );
    const albums = only ? ranked.filter((album) => album.albumId === only) : ranked.slice(0, top);
    if (albums.length === 0)
      throw new Error(only ? `${only} is not a missing release` : 'Nothing missing');

    const results = [];
    for (const [index, album] of albums.entries()) {
      const { precheck, requests } = await run.runReleasePrecheck(album.albumId);
      if (store) await writeMissingRelease(album.albumId, 'precheck', precheck, requests);
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
  },
);
