import { loadEnvConfig } from '@next/env';

type Options = {
  albumId?: string;
  concurrency: number;
  dryRun: boolean;
  maxAlbums: number;
  maxAttempts: number;
  delayMs: number;
  staleMinutes: number;
  retryFailed: boolean;
};

function usage() {
  console.log(`Usage: pnpm queue:drain [options]

Options:
  --dry-run                 Show queue state without changing it
  --album <spotify-id>       Process only this album
  --concurrency <n>          Parallel album passes; writes stay serial (default: 1)
  --max-albums <n>          Stop after n albums (default: all)
  --max-attempts <n>        Maximum claims per track (default: 5)
  --delay-ms <n>            Delay between albums (default: 2000)
  --stale-minutes <n>       Requeue older processing claims (default: 30)
  --no-retry-failed         Do not retry previously failed tracks
  --help                    Show this help

The command loads .env.local and the other standard Next.js environment files.`);
}

function positiveInteger(value: string | undefined, name: string, allowZero = false) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`);
  }
  return parsed;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    dryRun: false,
    concurrency: 1,
    maxAlbums: Number.POSITIVE_INFINITY,
    maxAttempts: 5,
    delayMs: 2_000,
    staleMinutes: 30,
    retryFailed: true,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--album') {
      options.albumId = argv[++i];
      if (!options.albumId) throw new Error(`${arg} requires a Spotify album ID`);
    } else if (arg === '--concurrency') {
      options.concurrency = positiveInteger(argv[++i], arg);
    } else if (arg === '--no-retry-failed') {
      options.retryFailed = false;
    } else if (arg === '--max-albums') {
      options.maxAlbums = positiveInteger(argv[++i], arg);
    } else if (arg === '--max-attempts') {
      options.maxAttempts = positiveInteger(argv[++i], arg);
    } else if (arg === '--delay-ms') {
      options.delayMs = positiveInteger(argv[++i], arg, true);
    } else if (arg === '--stale-minutes') {
      options.staleMinutes = positiveInteger(argv[++i], arg, true);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.albumId) options.concurrency = 1;

  return options;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  loadEnvConfig(process.cwd());

  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('TURSO_DATABASE_URL is required (put it in .env.local or export it)');
  }

  const [{ db }, { matchQueue }, processor, drizzle] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/db/schema'),
    import('@/lib/match-queue-processor'),
    import('drizzle-orm'),
  ]);
  const { and, count, eq, gte, isNull, lt, or, sql } = drizzle;

  async function queueStats() {
    const rows = await db
      .select({ status: matchQueue.status, tracks: count() })
      .from(matchQueue)
      .groupBy(matchQueue.status);
    return Object.fromEntries(rows.map((row) => [row.status, row.tracks]));
  }

  console.log('Queue before:', await queueStats());
  if (options.dryRun) return;

  const staleBefore = new Date(Date.now() - options.staleMinutes * 60_000);
  const recovered = await db
    .update(matchQueue)
    .set({ status: 'pending', claimOwnerId: null })
    .where(
      and(
        eq(matchQueue.status, 'processing'),
        options.albumId === undefined ? undefined : eq(matchQueue.spotifyAlbumId, options.albumId),
        or(isNull(matchQueue.lastAttemptAt), lt(matchQueue.lastAttemptAt, staleBefore)),
      ),
    )
    .returning({ spotifyId: matchQueue.spotifyId });

  let retried: Array<{ spotifyId: string }> = [];
  if (options.retryFailed) {
    retried = await db
      .update(matchQueue)
      .set({ status: 'pending', processedAt: null, claimOwnerId: null })
      .where(
        and(
          eq(matchQueue.status, 'failed'),
          lt(matchQueue.attempts, options.maxAttempts),
          options.albumId === undefined
            ? undefined
            : eq(matchQueue.spotifyAlbumId, options.albumId),
        ),
      )
      .returning({ spotifyId: matchQueue.spotifyId });
  }

  console.log(
    `Recovered ${recovered.length} stale claims; requeued ${retried.length} failed tracks.`,
  );

  let stopRequested = false;
  process.once('SIGINT', () => {
    stopRequested = true;
    console.log('\nStop requested; finishing the current album.');
  });
  process.once('SIGTERM', () => {
    stopRequested = true;
    console.log('\nStop requested; finishing the current album.');
  });

  let albums = 0;
  let claimSlots = 0;
  let matched = 0;
  let failed = 0;
  let notClassical = 0;

  async function runWorker(workerIndex: number) {
    const claimOwner = `queue-cli-${process.pid}-${workerIndex}-${Date.now()}`;

    while (!stopRequested) {
      if (claimSlots >= options.maxAlbums) return;
      claimSlots++;

      const claim = options.albumId
        ? await processor.claimPendingAlbum(options.albumId, claimOwner, options.maxAttempts)
        : await processor.claimNextPendingAlbum(claimOwner, options.maxAttempts);
      if (!claim) {
        claimSlots--;
        return;
      }

      const startedAt = Date.now();
      const result = await processor.processQueuedAlbum(claim.albumId, claimOwner, claim.trackIds);
      albums++;
      matched += result.matched;
      failed += result.failed;
      notClassical += result.notClassical;

      const retryable = result.errors.filter((error) => error.retryable).length;
      console.log(
        `[${albums}] ${claim.albumId}: ${result.matched} matched, ${result.notClassical} not classical, ` +
          `${result.failed} failed, ${retryable} retryable (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
      );
      for (const error of result.errors) {
        console.error(`  ${error.trackId ?? 'album'}: ${error.message}`);
      }

      if (!stopRequested && claimSlots < options.maxAlbums && options.delayMs > 0) {
        await sleep(options.delayMs);
      }
    }
  }

  await Promise.all(
    Array.from({ length: options.concurrency }, (_, index) => runWorker(index + 1)),
  );

  const exhausted = await db
    .update(matchQueue)
    .set({
      status: 'failed',
      processedAt: new Date(),
      errorMessage: sql`coalesce(${matchQueue.errorMessage}, 'Maximum processing attempts reached')`,
    })
    .where(
      and(
        eq(matchQueue.status, 'pending'),
        gte(matchQueue.attempts, options.maxAttempts),
        options.albumId === undefined ? undefined : eq(matchQueue.spotifyAlbumId, options.albumId),
      ),
    )
    .returning({ spotifyId: matchQueue.spotifyId });

  const finalStats = await queueStats();
  console.log('Run totals:', {
    albums,
    matched,
    notClassical,
    failed,
    exhausted: exhausted.length,
  });
  console.log('Queue after:', finalStats);

  const unresolved =
    (finalStats.pending ?? 0) + (finalStats.processing ?? 0) + (finalStats.failed ?? 0);
  if (!stopRequested && albums < options.maxAlbums && unresolved > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
