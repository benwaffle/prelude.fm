// Usage: pnpm mb:dump <download|select|sync> [--dir path] [--db path] [--dry-run] [--table t]
//   download  fetch the latest MusicBrainz full export and extract the tables we read into --dir
//   select    pick the classical subset of --dir into a local SQLite file (--db), in our schema
//   sync      copy what differs from --db into Turso (--dry-run counts the rows it would write)
// See docs/metadata-pipeline.md.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineScript, UsageError } from './lib/cli';

const EXPORT = 'https://data.metabrainz.org/pub/musicbrainz/data/fullexport';

/** Every table `select` reads, all in mbdump.tar.bz2. */
const TABLES = [
  'artist',
  'artist_type',
  'iso_3166_1',
  'isrc',
  'l_artist_recording',
  'l_artist_url',
  'l_artist_work',
  'l_recording_work',
  'l_release_url',
  'l_series_work',
  'l_url_work',
  'l_work_work',
  'link',
  'link_attribute',
  'link_attribute_text_value',
  'link_attribute_type',
  'link_type',
  'medium',
  'recording',
  'release',
  'release_country',
  'release_unknown_country',
  'series',
  'series_type',
  'track',
  'url',
  'work',
  'work_type',
];

defineScript(
  {
    options: {
      dir: { type: 'string', default: 'mbdump' },
      db: { type: 'string', default: 'mbdump-classical.sqlite' },
      'dry-run': { type: 'boolean' },
      table: { type: 'string', multiple: true },
    },
    positionals: true,
  },
  async ({ options, positionals }) => {
    const [step] = positionals;
    const log = (message: string) => console.log(message);

    if (step === 'download') {
      const latest = execFileSync('curl', ['-fsS', `${EXPORT}/LATEST`], {
        encoding: 'utf8',
      }).trim();
      mkdirSync(options.dir, { recursive: true });
      const archive = join(options.dir, 'mbdump.tar.bz2');
      log(`downloading ${latest}`);
      execFileSync(
        'curl',
        ['-fS', '--retry', '5', '-C', '-', '-o', archive, `${EXPORT}/${latest}/mbdump.tar.bz2`],
        {
          stdio: 'inherit',
        },
      );
      // A parallel bzip2 when one is installed: the archive is several gigabytes.
      const bzip = ['lbzip2', 'pbzip2', 'ibzip2'].find((tool) => {
        try {
          execFileSync('which', [tool], { stdio: 'ignore' });
          return true;
        } catch {
          return false;
        }
      });
      execFileSync(
        'tar',
        [
          '-x',
          ...(bzip ? ['-I', bzip] : ['-j']),
          '-f',
          archive,
          '-C',
          options.dir,
          '--strip-components=1',
          ...TABLES.map((table) => `mbdump/${table}`),
        ],
        { stdio: 'inherit' },
      );
      rmSync(archive);
      log(`extracted ${TABLES.length} tables of ${latest} into ${options.dir}`);
      return;
    }

    if (step === 'select') {
      const [{ DatabaseSync }, { createClient }, { DUMP_TABLES, selectClassical }] =
        await Promise.all([
          import('node:sqlite'),
          import('@libsql/client'),
          import('./lib/mb-dump/select'),
        ]);
      if (existsSync(options.db)) throw new UsageError(`${options.db} exists; remove it first`);
      const remote = createClient({
        url: process.env.TURSO_DATABASE_URL!,
        authToken: process.env.TURSO_AUTH_TOKEN,
      });
      // The prod schema, tables and indexes, so the file's size is what Turso will hold.
      const schema = await remote.execute({
        sql: `select sql from sqlite_master where sql is not null and tbl_name in
          (${DUMP_TABLES.map(() => '?').join(', ')}) order by type desc`,
        args: [...DUMP_TABLES],
      });
      const held = await remote.execute('select spotify_id from spotify_artist');
      const out = new DatabaseSync(options.db);
      out.exec('pragma journal_mode = off; pragma synchronous = off; pragma temp_store = file');
      for (const row of schema.rows) out.exec(String(row.sql));
      const stats = await selectClassical({
        dumpDir: options.dir,
        out,
        heldSpotifyArtists: new Set(held.rows.map((row) => String(row.spotify_id))),
        fetchedAt: Date.now(),
        log,
      });
      for (const table of DUMP_TABLES) {
        const row = out.prepare(`select count(*) as n from ${table}`).get() as { n: number };
        log(`${table}\t${row.n}`);
      }
      // Not vacuumed (that needs the file's size again in free disk): count only used pages.
      const pages = out
        .prepare(
          'select (select page_count from pragma_page_count) - (select freelist_count from pragma_freelist_count) as used, (select page_size from pragma_page_size) as size',
        )
        .get() as { used: number; size: number };
      out.close();
      log(JSON.stringify(stats));
      log(
        `${options.db}: ${((pages.used * pages.size) / 1e9).toFixed(2)} GB used (${(statSync(options.db).size / 1e9).toFixed(2)} GB on disk)`,
      );
      return;
    }

    if (step === 'sync') {
      const [{ DatabaseSync }, { createClient }, { syncToTurso }] = await Promise.all([
        import('node:sqlite'),
        import('@libsql/client'),
        import('./lib/mb-dump/sync'),
      ]);
      const result = await syncToTurso({
        local: new DatabaseSync(options.db, { readOnly: true }),
        remote: createClient({
          url: process.env.TURSO_DATABASE_URL!,
          authToken: process.env.TURSO_AUTH_TOKEN,
        }),
        dryRun: options['dry-run'],
        tables: options.table,
        log,
      });
      log(`${options['dry-run'] ? 'would write' : 'wrote'} ${result.rowsWritten} rows`);
      return;
    }

    throw new UsageError('Pass a step: download, select or sync');
  },
);
