// Usage: pnpm spotify:crawl [all|resume|links|isrc|report] [--limit n] [--batch n] [--interval-ms n]
//
// Finds Spotify albums for the releases our MusicBrainz tables hold and runs each through the match
// queue, cheapest source first:
//   resume  albums an earlier crawl queued but did not finish
//   links   Spotify albums MusicBrainz links a release to (twenty albums a request)
//   isrc    releases with ISRCs but no Spotify link, found by Spotify search `isrc:`
//   all     resume, then links, then isrc (the default)
//   report  what is left to crawl and what the crawl found; no Spotify requests
//
// Runs here, never on Vercel. Resumable: rerun the same command after a stop. Needs
// TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN), SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.
import { defineScript, UsageError } from './lib/cli';

const STEPS = ['all', 'resume', 'links', 'isrc', 'report'] as const;

defineScript(
  {
    options: {
      limit: { type: 'integer', min: 1 },
      batch: { type: 'integer', min: 1, default: 20 },
      'interval-ms': { type: 'integer', min: 0, default: 300 },
    },
    positionals: true,
  },
  async ({ options, positionals }) => {
    if (positionals.length > 1)
      throw new UsageError(`One step at a time, not ${positionals.join(' ')}`);
    const step = (positionals[0] ?? 'all') as (typeof STEPS)[number];
    if (!STEPS.includes(step))
      throw new UsageError(`Unknown step ${step}; one of ${STEPS.join(', ')}`);

    const [{ db }, { sql }, crawl] = await Promise.all([
      import('@/lib/db'),
      import('drizzle-orm'),
      import('@/lib/spotify-crawl'),
    ]);

    if (step === 'report') {
      const rows = await db.all<{ label: string; n: number }>(sql`
        select 'Spotify album links in MusicBrainz' as label, count(distinct url) as n
          from mb_release_url
         where url > 'https://open.spotify.com/album/' and url < 'https://open.spotify.com/album0'
           and ended = 0
        union all select 'linked albums Spotify has no album for', count(*) from spotify_crawl
         where kind = 'mb_link' and outcome = 'not_found'
        union all select 'linked albums queued by the crawl', count(*) from spotify_crawl
         where kind = 'mb_link' and outcome = 'queued'
        union all select 'releases searched by ISRC: found', count(*) from spotify_crawl
         where kind = 'isrc_search' and outcome = 'found'
        union all select 'releases searched by ISRC: already held', count(*) from spotify_crawl
         where kind = 'isrc_search' and outcome = 'held'
        union all select 'releases searched by ISRC: not on Spotify', count(*) from spotify_crawl
         where kind = 'isrc_search' and outcome = 'not_found'
        union all select 'crawl queue rows ' || status, count(*) from match_queue
         where substr(submitted_by, 1, 6) = 'crawl:' group by status
        union all select 'spotify albums held', count(*) from spotify_album
      `);
      const width = Math.max(...rows.map((row) => row.label.length));
      for (const row of rows)
        console.log(`${row.label.padEnd(width)}  ${String(row.n).padStart(8)}`);
      return;
    }

    const [{ musicBrainzApi }, { musicBrainzMirror }, spotify, invariants] = await Promise.all([
      import('@/lib/musicbrainz'),
      import('@/lib/musicbrainz-mirror'),
      import('@/lib/spotify-app-client'),
      import('@/lib/musicbrainz-invariants'),
    ]);
    if (!process.env.SPOTIFY_CLIENT_ID || !process.env.SPOTIFY_CLIENT_SECRET) {
      throw new UsageError('SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are required');
    }
    spotify.setSpotifyRequestInterval(options['interval-ms']);
    const client = await crawl.spotifyAppCrawlClient();
    // The backfill channel, so the crawl yields to anything a person is waiting on.
    const musicBrainzSource = musicBrainzMirror(musicBrainzApi('backfill'));

    // Over the albums just processed; `pnpm metadata:validate` reads the whole cache.
    const checkInvariants = async (albums: string[]) => {
      const results = await invariants.runMusicBrainzInvariants({ albums });
      await invariants.recordInvariantResults(results.filter((result) => result.violations > 0));
      const broken = invariants.hardViolations(results);
      return broken.length > 0
        ? `cache invariants broken: ${broken.map((result) => `${result.name} (${result.violations})`).join(', ')}`
        : null;
    };

    const walks =
      step === 'all'
        ? [crawl.resumeWalk(), crawl.linkedAlbumWalk(), crawl.isrcSearchWalk(client)]
        : step === 'resume'
          ? [crawl.resumeWalk()]
          : step === 'links'
            ? [crawl.linkedAlbumWalk()]
            : [crawl.isrcSearchWalk(client)];

    for (const walk of walks) {
      console.log(`\n${walk.name}:`);
      const progress = await crawl.runCrawl(walk, {
        client,
        musicBrainzSource,
        limit: options.limit ?? Number.POSITIVE_INFINITY,
        batchSize: options.batch,
        checkInvariants,
        onBatch: (p) => {
          const minutes = p.elapsedMs / 60_000;
          console.log(
            `  ${p.subjects} ${walk.name === 'isrc' ? 'releases' : 'albums'} · ` +
              `${p.albumsRead} read, ${p.albumsMissing} not on Spotify · tracks ` +
              `${p.tracksMatched} ready, ${p.tracksUnresolved} unresolved, ` +
              `${p.tracksNotClassical} not classical, ${p.tracksFailed} failed · ` +
              `${p.spotifyRequests} Spotify, ${p.musicbrainzRequests} MusicBrainz requests · ` +
              `${(p.albumsRead / Math.max(minutes, 1 / 60)).toFixed(0)} albums/min`,
          );
        },
      });
      if (progress.stopped) {
        console.error(`\nStopped: ${progress.stopped}\nRerun the same command to carry on.`);
        return 1;
      }
      console.log(
        `  done: ${progress.subjects} in ${(progress.elapsedMs / 60_000).toFixed(1)} min`,
      );
    }
  },
);
