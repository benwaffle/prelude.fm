/**
 * MusicBrainz-first ingest.
 *
 * Fills the `mb_*` cache from the MusicBrainz web service and anchors Spotify
 * tracks to the recordings it describes. Nothing the reader sees changes; this
 * only builds the cache the reader will later be moved onto.
 *
 * Resumable, because the cache is the progress record: an album already
 * cached is skipped, a work already read is not read again, and an
 * interrupted run picks up where it stopped.
 *
 *   pnpm mb:ingest albums [--limit n]  cache releases and anchor their tracks
 *   pnpm mb:ingest anchor [--all]      anchor tracks; --all re-anchors ones already done
 *   pnpm mb:ingest report              what the cache holds and what it reaches
 *
 * The same `ingestAlbum` runs in the worker; this is for bulk backfill and for
 * looking at one album by hand.
 */
import { loadEnvConfig } from '@next/env';

type Options = { step: string; limit: number; albumId?: string; all: boolean };

function parseOptions(argv: string[]): Options {
  const options: Options = {
    step: argv[0] ?? 'report',
    limit: Number.POSITIVE_INFINITY,
    all: false,
  };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--limit') options.limit = Number(argv[++i]);
    else if (argv[i] === '--all') options.all = true;
    else if (argv[i] === '--album') options.albumId = argv[++i];
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  loadEnvConfig(process.cwd());

  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required (put it in .env.local or export it)');
  }

  const [{ db }, ingest, cache, mb, gateway, drizzle] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/musicbrainz-ingest'),
    import('@/lib/musicbrainz-cache'),
    import('@/lib/musicbrainz'),
    import('@/lib/musicbrainz-gateway'),
    import('drizzle-orm'),
  ]);
  const { sql } = drizzle;
  const source = mb.musicBrainzApi('backfill');

  async function report() {
    const rows = await db.all<{ label: string; n: number }>(sql`
      select 'spotify albums' as label, count(*) as n from spotify_album
      union all select 'albums with a cached release', count(*) from spotify_album a
        where exists (select 1 from mb_release r where r.mbid = a.mb_release_id)
      union all select 'spotify tracks', count(*) from spotify_track
      union all select 'tracks anchored to a recording', count(*) from track_recording
      union all select '  by isrc', count(*) from track_recording where matched_by = 'isrc'
      union all select '  by release position', count(*) from track_recording where matched_by = 'release_position'
      union all select 'tracks reaching a work', count(*) from track_recording tr
        where exists (select 1 from mb_recording_work w where w.recording_mbid = tr.recording_mbid)
      union all select 'cached releases', count(*) from mb_release
      union all select 'cached recordings', count(*) from mb_recording
      union all select 'cached works', count(*) from mb_work
      union all select '  read in full', count(*) from mb_work where detail = 'full'
      union all select '  with a parent', count(*) from mb_work where parent_mbid is not null
      union all select 'cached credits', count(*) from mb_recording_credit
      union all select 'cached catalogue references', count(*) from mb_work_catalogue
      union all select 'cached artists', count(*) from mb_artist
    `);
    const width = Math.max(...rows.map((row) => row.label.length));
    for (const row of rows) {
      console.log(`${row.label.padEnd(width)}  ${String(row.n).padStart(6)}`);
    }

    const status = await gateway.musicbrainzGatewayStatus();
    console.log(
      `\nrequests today: ${status.total}/${status.globalCap} ` +
        status.channels.map((c) => `${c.channel}=${c.used}`).join(' '),
    );
  }

  if (options.step === 'report') {
    await report();
    return;
  }

  if (options.step === 'albums') {
    const albumIds = options.albumId
      ? [options.albumId]
      : await ingest.albumsNeedingIngest(Number.isFinite(options.limit) ? options.limit : 10_000);

    console.log(`${albumIds.length} albums to ingest`);
    let requests = 0;
    const outcomes = new Map<string, number>();
    const started = Date.now();

    for (const [index, albumId] of albumIds.entries()) {
      try {
        const result = await ingest.ingestAlbum(source, albumId);
        requests += result.requests;
        const outcome = result.releaseMbid
          ? `matched:${result.matchedBy}`
          : `unmatched:${result.reason}`;
        outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
        console.log(
          `[${index + 1}/${albumIds.length}] ${albumId} ${outcome} ` +
            `${result.requests} req` +
            (result.anchors
              ? ` · ${result.anchors.anchored}/${result.anchors.anchored + result.anchors.unanchored} anchored` +
                ` (${result.anchors.byIsrc} isrc, ${result.anchors.byPosition} position)`
              : '') +
            (result.release?.worksFetched ? ` · ${result.release.worksFetched} works read` : ''),
        );
        if (result.anchors?.contestedIsrcs.length) {
          console.log(`    contested ISRCs: ${result.anchors.contestedIsrcs.join(', ')}`);
        }
      } catch (error) {
        outcomes.set('error', (outcomes.get('error') ?? 0) + 1);
        console.error(`[${index + 1}/${albumIds.length}] ${albumId} failed:`, error);
      }
    }

    const minutes = (Date.now() - started) / 60_000;
    console.log(`\n${requests} requests in ${minutes.toFixed(1)} min`);
    for (const [outcome, n] of [...outcomes].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${outcome}: ${n}`);
    }
    console.log();
    await report();
    return;
  }

  if (options.step === 'anchor') {
    const pending = await ingest.albumsNeedingAnchoring(
      Number.isFinite(options.limit) ? options.limit : 10_000,
      options.all,
    );
    console.log(`${pending.length} albums to anchor`);
    let anchored = 0;
    let unanchored = 0;
    let misaligned = 0;
    const contested: string[] = [];
    let disagreements = 0;
    for (const album of pending) {
      const result = await ingest.anchorAlbumTracks(album.albumId, album.releaseMbid);
      anchored += result.anchored;
      unanchored += result.unanchored;
      if (!result.tracklistAligned) misaligned++;
      contested.push(...result.contestedIsrcs);
      disagreements += result.isrcPositionDisagreements;
    }
    console.log(
      `anchored ${anchored} tracks, ${unanchored} left unanchored, ` +
        `${misaligned} albums whose tracklist does not line up`,
    );
    if (contested.length) console.log(`contested ISRCs: ${[...new Set(contested)].join(', ')}`);
    if (disagreements) console.log(`${disagreements} tracks where ISRC and position disagree`);
    await report();
    return;
  }

  if (options.step === 'works') {
    // Works named by a recording but never read, so their parents and
    // catalogue references are still unknown.
    const pending = await db.all<{ mbid: string }>(sql`
      select mbid from mb_work where detail = 'stub' limit ${Number.isFinite(options.limit) ? options.limit : 10_000}
    `);
    console.log(`${pending.length} works to read`);
    let requests = 0;
    for (const [index, row] of pending.entries()) {
      const { requests: spent } = await cache.ingestWorkTree(source, row.mbid);
      requests += spent;
      if ((index + 1) % 25 === 0) console.log(`  ${index + 1}/${pending.length} (${requests} req)`);
    }
    console.log(`${requests} requests`);
    await report();
    return;
  }

  throw new Error(`Unknown step: ${options.step}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
