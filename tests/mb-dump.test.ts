import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createClient } from '@libsql/client';
import { DUMP_TABLES, selectClassical } from '../scripts/lib/mb-dump/select';
import { syncToTurso } from '../scripts/lib/mb-dump/sync';
import { unescapeField } from '../scripts/lib/mb-dump/tsv';

const N = '\\N';

// A dump in miniature: Bach's Partita (catalogued, so Bach is classical) and its Chaconne, a
// violinist's recording of the Chaconne on a release that also carries a pop song, and the pop
// song's own single, which stays out.
const DUMP: Record<string, (string | number)[][]> = {
  link_type: [
    [1, N, 0, 'lt-composer', 'artist', 'work', 'composer'],
    [2, N, 0, 'lt-performance', 'recording', 'work', 'performance'],
    [3, N, 0, 'lt-parts', 'work', 'work', 'parts'],
    [4, N, 0, 'lt-series', 'series', 'work', 'part of'],
    [5, N, 0, 'lt-instrument', 'artist', 'recording', 'instrument'],
    [6, N, 0, 'lt-streaming', 'release', 'url', 'free streaming'],
    [7, N, 0, 'lt-artist-streaming', 'artist', 'url', 'free streaming'],
    [8, N, 0, 'lt-score', 'url', 'work', 'download for free'],
  ],
  link_attribute_type: [
    [1, N, 1, 0, 'at-number', 'number'],
    [2, N, 2, 0, 'at-violin', 'violin'],
  ],
  work_type: [[1, 'Partita']],
  artist_type: [[1, 'Person']],
  series_type: [[1, 'Catalogue']],
  // id, link_type, begin y/m/d, end y/m/d, attribute_count, created, ended
  link: [
    [11, 1, N, N, N, N, N, N, 0, N, 'f'],
    [12, 2, N, N, N, N, N, N, 0, N, 'f'],
    [13, 3, N, N, N, N, N, N, 0, N, 'f'],
    [14, 4, N, N, N, N, N, N, 1, N, 'f'],
    [15, 5, N, N, N, N, N, N, 1, N, 'f'],
    [16, 6, 2020, 1, N, N, N, N, 0, N, 'f'],
    [17, 7, N, N, N, N, N, N, 0, N, 'f'],
    [18, 8, N, N, N, N, N, N, 0, N, 'f'],
  ],
  link_attribute: [[15, 2, N]],
  link_attribute_text_value: [[14, 1, 'BWV 1004']],
  series: [[1, 'series-bwv', 'Bach-Werke-Verzeichnis', '', 1]],
  // id, link, entity0, entity1, edits_pending, last_updated, link_order
  l_series_work: [[1, 14, 1, 1, 0, N, 0]],
  work: [
    [1, 'work-partita', 'Partita no. 2 in D minor, BWV 1004', 1],
    [2, 'work-chaconne', 'Partita no. 2: V. Chaconne', N],
    [3, 'work-pop', 'A pop song', N],
  ],
  l_artist_work: [
    [1, 11, 1, 1, 0, N, 0],
    [2, 11, 3, 3, 0, N, 0],
  ],
  l_work_work: [[1, 13, 1, 2, 0, N, 5]],
  l_url_work: [[1, 18, 3, 1, 0, N, 0]],
  l_artist_url: [[1, 17, 2, 4, 0, N, 0]],
  url: [
    [1, 'u1', 'https://open.spotify.com/album/abc'],
    [3, 'u3', 'https://imslp.org/wiki/Violin_Partita_No.2'],
    [4, 'u4', 'https://open.spotify.com/artist/violinist'],
  ],
  l_recording_work: [
    [1, 12, 1, 2, 0, N, 0],
    [2, 12, 2, 3, 0, N, 0],
    [3, 12, 3, 3, 0, N, 0],
  ],
  l_artist_recording: [[1, 15, 2, 1, 0, N, 0]],
  recording: [
    [1, 'rec-chaconne', 'Chaconne', 1, 900000],
    [2, 'rec-pop-single', 'A pop song', 1, 200000],
    [3, 'rec-pop-bonus', 'A pop song (bonus)', 1, 210000],
  ],
  isrc: [[1, 1, 'gbaaa2000001']],
  // id, gid, recording, medium, position, number, name, artist_credit, length
  track: [
    [1, 't1', 1, 1, 1, '1', 'Chaconne in D minor', 1, 901000],
    [2, 't2', 3, 1, 2, '2', 'Bonus: a pop song', 1, 210000],
    [3, 't3', 2, 2, 1, '1', 'A pop song', 1, 200000],
  ],
  medium: [
    [1, 1, 1],
    [2, 2, 1],
  ],
  release: [
    [1, 'rel-bach', 'Bach: Partitas', 1, 1, N, N, N, N, '0028947'],
    [2, 'rel-pop', 'A pop song (single)', 1, 2, N, N, N, N, ''],
  ],
  l_release_url: [[1, 16, 1, 1, 0, N, 0]],
  release_country: [[1, 100, 2001, 3, N]],
  release_unknown_country: [[1, 1999, N, N]],
  iso_3166_1: [[100, 'DE']],
  // id, gid, name, sort_name, begin y/m/d, end y/m/d, type
  artist: [
    [
      1,
      'artist-bach',
      'Johann Sebastian Bach',
      'Bach, Johann Sebastian',
      1685,
      3,
      31,
      1750,
      7,
      28,
      1,
    ],
    [2, 'artist-violinist', 'A Violinist', 'Violinist, A', 1970, N, N, N, N, N, 1],
    [3, 'artist-pop', 'A Pop Star', 'Star, A Pop', N, N, N, N, N, N, N],
  ],
};

// The prod schema's `mb_*` tables, from the same drizzle definitions the app uses.
async function schemaStatements() {
  const schema = await import('../app/lib/db/schema');
  const { generateSQLiteDrizzleJson, generateSQLiteMigration } = await import('drizzle-kit/api');
  const statements = await generateSQLiteMigration(
    await generateSQLiteDrizzleJson({}),
    await generateSQLiteDrizzleJson(schema as never),
  );
  return statements.filter((statement) =>
    DUMP_TABLES.some(
      (table) => statement.includes(`\`${table}\``) && !/REFERENCES `(?!mb_)/.test(statement),
    ),
  );
}

async function selectFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mbdump-'));
  for (const [table, rows] of Object.entries(DUMP)) {
    writeFileSync(join(dir, table), rows.map((row) => row.join('\t')).join('\n') + '\n');
  }
  const local = new DatabaseSync(join(dir, 'out.sqlite'));
  for (const statement of await schemaStatements()) local.exec(statement);
  const stats = await selectClassical({
    dumpDir: dir,
    out: local,
    heldSpotifyArtists: new Set(),
    fetchedAt: 1_700_000_000_000,
    log: () => {},
  });
  return { dir, local, stats };
}

test('unescapes COPY fields', () => {
  assert.equal(unescapeField('\\N'), null);
  assert.equal(unescapeField('a\\tb\\\\c\\nd'), 'a\tb\\c\nd');
});

test('selects catalogued composers, their works and the releases that perform them', async () => {
  const { local, stats } = await selectFixture();
  assert.equal(stats.composers, 1);

  const works = local
    .prepare(
      'select mbid, parent_mbid, ordering_key, composer_mbid, imslp_url, type from mb_work order by mbid',
    )
    .all();
  assert.deepEqual(
    works.map((row) => ({ ...row })),
    [
      {
        mbid: 'work-chaconne',
        parent_mbid: 'work-partita',
        ordering_key: 5,
        composer_mbid: null,
        imslp_url: null,
        type: null,
      },
      {
        mbid: 'work-partita',
        parent_mbid: null,
        ordering_key: null,
        composer_mbid: 'artist-bach',
        imslp_url: 'https://imslp.org/wiki/Violin_Partita_No.2',
        type: 'Partita',
      },
      // On the classical release, so stored like any work a cached release names.
      {
        mbid: 'work-pop',
        parent_mbid: null,
        ordering_key: null,
        composer_mbid: 'artist-pop',
        imslp_url: null,
        type: null,
      },
    ],
  );
  assert.deepEqual(
    { ...local.prepare('select system, number from mb_work_catalogue').get() },
    { system: 'BWV', number: '1004' },
  );
  assert.deepEqual(
    local
      .prepare('select mbid from mb_release')
      .all()
      .map((row) => row.mbid),
    ['rel-bach'],
  );
  assert.deepEqual(
    { ...local.prepare('select date, country, barcode from mb_release').get() },
    { date: '1999', country: null, barcode: '0028947' },
  );
  assert.deepEqual(
    local
      .prepare('select position, recording_mbid, title from mb_release_track order by position')
      .all()
      .map((row) => ({ ...row })),
    [
      { position: 1, recording_mbid: 'rec-chaconne', title: 'Chaconne in D minor' },
      { position: 2, recording_mbid: 'rec-pop-bonus', title: 'Bonus: a pop song' },
    ],
  );
  assert.deepEqual(
    { ...local.prepare('select url, relationship_type, begin from mb_release_url').get() },
    {
      url: 'https://open.spotify.com/album/abc',
      relationship_type: 'free streaming',
      begin: '2020-01',
    },
  );
  assert.deepEqual(
    { ...local.prepare('select isrc, recording_mbid from mb_recording_isrc').get() },
    { isrc: 'GBAAA2000001', recording_mbid: 'rec-chaconne' },
  );
  assert.deepEqual(
    { ...local.prepare('select artist_mbid, role, instrument from mb_recording_credit').get() },
    { artist_mbid: 'artist-violinist', role: 'instrument', instrument: 'violin' },
  );
  assert.equal(
    local.prepare("select spotify_artist_id from mb_artist where mbid = 'artist-violinist'").get()
      ?.spotify_artist_id,
    'violinist',
  );
  assert.equal(
    local.prepare("select count(*) as n from mb_recording where mbid = 'rec-pop-single'").get()?.n,
    0,
  );
});

test('sync writes the selection once, then only what changed', async () => {
  const { dir, local } = await selectFixture();
  const remote = createClient({ url: `file:${join(dir, 'remote.sqlite')}` });
  for (const statement of await schemaStatements()) await remote.execute(statement);
  // A release the web service cached, which the dump doesn't mention, stays.
  await remote.execute(
    "insert into mb_release (mbid, title, fetched_at) values ('rel-other', 'Other', 1)",
  );
  await remote.execute(
    "insert into mb_release_track values ('rel-other', 1, 1, 'rec-x', 'X', null)",
  );
  // A stale ISRC on a recording the dump holds is replaced.
  await remote.execute("insert into mb_recording_isrc values ('OLD000000001', 'rec-chaconne')");

  const first = await syncToTurso({ local, remote, dryRun: false, log: () => {} });
  assert.ok(first.rowsWritten > 0);
  const isrcs = await remote.execute(
    "select isrc from mb_recording_isrc where recording_mbid = 'rec-chaconne'",
  );
  assert.deepEqual(
    isrcs.rows.map((row) => row.isrc),
    ['GBAAA2000001'],
  );
  assert.equal(
    (
      await remote.execute(
        "select count(*) as n from mb_release_track where release_mbid = 'rel-other'",
      )
    ).rows[0].n,
    1,
  );

  const again = await syncToTurso({ local, remote, dryRun: false, log: () => {} });
  assert.equal(again.rowsWritten, 0);
});
