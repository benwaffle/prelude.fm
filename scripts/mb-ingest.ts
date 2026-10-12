// Usage: pnpm mb:ingest <albums|anchor|report|loose|recordings|works|artists|refresh|composers|scores|check>
//   [--limit n] [--all] [--since <iso>]
// Resumable: the cache is the progress record.
import { defineScript, UsageError } from './lib/cli';

defineScript(
  {
    options: {
      limit: { type: 'integer', min: 1 },
      all: { type: 'boolean' },
      album: { type: 'string' },
      since: { type: 'string' },
    },
    positionals: true,
  },
  async ({ options: flags, positionals }) => {
    if (positionals.length > 1)
      throw new UsageError(`One step at a time, not ${positionals.join(' ')}`);
    const options = {
      step: positionals[0] ?? 'report',
      limit: flags.limit ?? Number.POSITIVE_INFINITY,
      all: flags.all,
      albumId: flags.album,
      since: flags.since,
    };

    const [{ db }, ingest, cache, mb, gateway, invariants, drizzle] = await Promise.all([
      import('@/lib/db'),
      import('@/lib/musicbrainz-ingest'),
      import('@/lib/musicbrainz-cache'),
      import('@/lib/musicbrainz'),
      import('@/lib/musicbrainz-gateway'),
      import('@/lib/musicbrainz-invariants'),
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
      union all select '  read in full', count(*) from mb_recording where detail = 'full'
      union all select 'cached works', count(*) from mb_work
      union all select '  read in full', count(*) from mb_work where detail = 'full'
      union all select '  with a parent', count(*) from mb_work where parent_mbid is not null
      union all select 'cached credits', count(*) from mb_recording_credit
      union all select 'cached catalogue references', count(*) from mb_work_catalogue
      union all select 'cached artists', count(*) from mb_artist
      union all select '  read in full', count(*) from mb_artist where sort_name is not null
      union all select '  with a birth year', count(*) from mb_artist where begin_year is not null
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

    if (options.step === 'loose') {
      const result = await ingest.anchorTracksByIsrc(source, {
        limit: Number.isFinite(options.limit) ? options.limit : 10_000,
      });
      console.log(
        `searched ${result.searched} ISRCs in ${result.requests} requests, anchored ${result.anchored} tracks`,
      );
      await report();
      return;
    }

    if (options.step === 'recordings') {
      const result = await cache.drainRecordingStubs(
        source,
        Number.isFinite(options.limit) ? options.limit : 10_000,
      );
      console.log(
        `read ${result.recordings} recordings in ${result.requests} requests; ` +
          `${result.reachedWork} reached a work`,
      );
      await report();
      return;
    }

    if (options.step === 'artists') {
      const result = await cache.drainArtistStubs(
        source,
        Number.isFinite(options.limit) ? options.limit : 10_000,
      );
      console.log(`read ${result.artists} artists in ${result.requests} requests`);
      await report();
      return;
    }

    if (options.step === 'refresh') {
      const result = await cache.refreshCachedReleases(
        source,
        Number.isFinite(options.limit) ? options.limit : 10_000,
      );
      console.log(`re-read ${result.releases} releases in ${result.requests} requests`);
      await report();
      return;
    }

    if (options.step === 'composers') {
      const since = options.since ? new Date(options.since) : new Date();
      console.log(`re-reading works not read since ${since.toISOString()}`);
      const result = await cache.refreshWorkComposers(source, {
        since,
        limit: options.limit,
        onProgress: (line) => console.log(line),
      });
      const names = new Map(
        (await db.all<{ mbid: string; name: string }>(sql`select mbid, name from mb_artist`)).map(
          (row) => [row.mbid, row.name],
        ),
      );
      for (const work of result.changed) {
        const from = work.from ? (names.get(work.from) ?? work.from) : 'none';
        const to = work.to ? (names.get(work.to) ?? work.to) : 'none';
        console.log(`changed\t${work.mbid}\t${work.title}\t${from} -> ${to}`);
      }
      console.log(`read ${result.read} works, ${result.changed.length} changed composer`);
      return;
    }

    // Works read before we kept IMSLP links: re-read the top-level ones, which the work page shows.
    if (options.step === 'scores') {
      const since = options.since ? new Date(options.since) : new Date();
      console.log(`re-reading top-level works not read since ${since.toISOString()}`);
      const stale = await db.all<{ mbid: string }>(sql`
        select mbid from mb_work
          where detail = 'full' and parent_mbid is null and fetched_at < ${since.getTime()}
          order by mbid
      `);
      console.log(`${stale.length} works to read`);
      let read = 0;
      for (const { mbid } of stale.slice(0, options.limit)) {
        await cache.readAndCacheWork(source, mbid);
        if (++read % 50 === 0) console.log(`  ${read} read`);
      }
      const [linked] = await db.all<{ n: number }>(
        sql`select count(*) as n from mb_work where imslp_url is not null`,
      );
      console.log(`read ${read} works; ${linked.n} works now have an IMSLP link`);
      return;
    }

    if (options.step === 'check') {
      const results = await invariants.runMusicBrainzInvariants();
      await invariants.recordInvariantResults(results);
      let broken = 0;
      for (const result of results) {
        const mark =
          result.violations === 0
            ? 'ok  '
            : result.severity === 'hard'
              ? 'FAIL'
              : result.severity === 'review'
                ? 'look'
                : 'note';
        console.log(`${mark} ${result.name.padEnd(32)} ${result.violations}`);
        if (result.violations > 0) {
          console.log(`     ${result.describes}`);
          for (const sample of result.samples) {
            console.log(`     - ${sample.id}${sample.detail ? ` -> ${sample.detail}` : ''}`);
          }
        }
        if (result.violations > 0 && result.severity === 'hard') broken++;
      }
      // Upstream findings are contributions, not failures, so only our own broken invariants fail
      // CI.
      return broken > 0 ? 1 : 0;
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
      const pending = await db.all<{ mbid: string }>(sql`
      select mbid from mb_work where detail = 'stub' limit ${Number.isFinite(options.limit) ? options.limit : 10_000}
    `);
      console.log(`${pending.length} works to read`);
      let requests = 0;
      for (const [index, row] of pending.entries()) {
        const { requests: spent } = await cache.ingestWorkTree(source, row.mbid);
        requests += spent;
        if ((index + 1) % 25 === 0)
          console.log(`  ${index + 1}/${pending.length} (${requests} req)`);
      }
      console.log(`${requests} requests`);
      await report();
      return;
    }

    throw new UsageError(`Unknown step: ${options.step}`);
  },
);
