// Copies the selected dump (a local SQLite file in our schema) into Turso, writing only what
// differs: a weekly re-import of an unchanged MusicBrainz costs reads, not writes. Rows Turso holds
// that the dump does not mention (releases cached from the web service, non-classical tracks in a
// library) are left alone.
//
// Parent rows are upserted; a parent's child rows (a recording's ISRCs, a release's tracks) are
// replaced as a set when they differ, the way the web service path rewrites a release it re-reads.
import type { Client, InStatement, InValue } from '@libsql/client';
import type { DatabaseSync } from 'node:sqlite';

type Row = Record<string, InValue>;
type Log = (message: string) => void;

type EntityTable = {
  table: string;
  /** Compared and written; the key first. */
  columns: string[];
  /** Written but not compared, so an unchanged row is not rewritten only to bump its stamp. */
  stamps: string[];
};

type ChildTable = { table: string; parent: string; parentTable: string; columns: string[] };

const ENTITIES: EntityTable[] = [
  {
    table: 'mb_artist',
    // `credited_name` is not ours to set: it is the name a release printed, from the web service.
    columns: ['mbid', 'name', 'sort_name', 'type', 'begin_year', 'end_year', 'spotify_artist_id'],
    stamps: ['links_read_at', 'fetched_at'],
  },
  {
    table: 'mb_work',
    columns: [
      'mbid',
      'title',
      'type',
      'parent_mbid',
      'ordering_key',
      'composer_mbid',
      'imslp_url',
      'detail',
    ],
    stamps: ['fetched_at'],
  },
  { table: 'mb_recording', columns: ['mbid', 'title', 'length', 'detail'], stamps: ['fetched_at'] },
  {
    table: 'mb_release',
    columns: ['mbid', 'title', 'barcode', 'date', 'country'],
    stamps: ['url_relations_fetched_at', 'fetched_at'],
  },
];

const CHILDREN: ChildTable[] = [
  {
    table: 'mb_work_catalogue',
    parent: 'work_mbid',
    parentTable: 'mb_work',
    columns: [
      'work_mbid',
      'series_mbid',
      'number',
      'system',
      'normalized_system',
      'normalized_number',
    ],
  },
  {
    table: 'mb_recording_isrc',
    parent: 'recording_mbid',
    parentTable: 'mb_recording',
    columns: ['recording_mbid', 'isrc'],
  },
  {
    table: 'mb_recording_work',
    parent: 'recording_mbid',
    parentTable: 'mb_recording',
    columns: ['recording_mbid', 'work_mbid'],
  },
  {
    table: 'mb_recording_credit',
    parent: 'recording_mbid',
    parentTable: 'mb_recording',
    columns: ['recording_mbid', 'artist_mbid', 'role', 'instrument'],
  },
  {
    table: 'mb_release_url',
    parent: 'release_mbid',
    parentTable: 'mb_release',
    columns: [
      'release_mbid',
      'url',
      'relationship_type_id',
      'relationship_type',
      'ended',
      'begin',
      'end',
      'attributes',
    ],
  },
  {
    table: 'mb_release_track',
    parent: 'release_mbid',
    parentTable: 'mb_release',
    columns: ['release_mbid', 'medium', 'position', 'recording_mbid', 'title', 'length'],
  },
];

const KEYS_PER_READ = 1000;
const ROWS_PER_STATEMENT = 200;
const ROWS_PER_BATCH = 4000;

const quote = (column: string) => `"${column}"`;
const list = (columns: string[]) => columns.map(quote).join(', ');

// SQLite hands back booleans as 0/1 and JSON as text on both sides; only bigint needs evening out.
const normalise = (value: unknown): InValue =>
  typeof value === 'bigint' ? Number(value) : ((value ?? null) as InValue);
const signature = (row: Row, columns: string[]) =>
  JSON.stringify(columns.map((column) => normalise(row[column])));

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 6) throw error;
      const wait = 2 ** attempt * 1000;
      console.error(
        `retrying in ${wait / 1000}s after: ${error instanceof Error ? error.message : error}`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** Collects statements and sends them as one transaction per batch. */
class Writer {
  private statements: InStatement[] = [];
  private rows = 0;
  written = 0;
  constructor(
    private remote: Client,
    private dryRun: boolean,
  ) {}

  async add(statement: InStatement, rows: number) {
    this.written += rows;
    if (this.dryRun) return;
    this.statements.push(statement);
    this.rows += Math.max(rows, 1);
    if (this.rows >= ROWS_PER_BATCH) await this.flush();
  }

  async flush() {
    if (this.statements.length === 0) return;
    const statements = this.statements;
    this.statements = [];
    this.rows = 0;
    await withRetry(() => this.remote.batch(statements, 'write'));
  }
}

const placeholders = (count: number) => Array.from({ length: count }, () => '?').join(', ');

async function insertRows(
  writer: Writer,
  table: string,
  columns: string[],
  rows: Row[],
  conflict: string,
) {
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    const chunk = rows.slice(start, start + ROWS_PER_STATEMENT);
    const row = `(${placeholders(columns.length)})`;
    await writer.add(
      {
        sql: `insert into ${table} (${list(columns)}) values ${chunk.map(() => row).join(', ')} ${conflict}`,
        args: chunk.flatMap((value) => columns.map((column) => normalise(value[column]))),
      },
      chunk.length,
    );
  }
}

// Turso is read only for the keys the dump holds, through their indexes: the whole of a remote
// table is never scanned.
function* localKeyPages(local: DatabaseSync, table: string) {
  let page: string[] = [];
  for (const row of local.prepare(`select mbid from ${table} order by mbid`).iterate()) {
    page.push(String((row as Row).mbid));
    if (page.length === KEYS_PER_READ) {
      yield page;
      page = [];
    }
  }
  if (page.length > 0) yield page;
}

async function remoteWhereIn(
  remote: Client,
  table: string,
  columns: string[],
  key: string,
  ids: string[],
) {
  const result = await withRetry(() =>
    remote.execute({
      sql: `select ${list(columns)} from ${table} where ${quote(key)} in (${placeholders(ids.length)})`,
      args: ids,
    }),
  );
  // Plain objects: a libSQL row is array-like, so its `length` is the column count, not a column.
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((column, index) => [column, row[index]])),
  );
}

function localWhereIn(
  local: DatabaseSync,
  table: string,
  columns: string[],
  key: string,
  ids: string[],
) {
  return local
    .prepare(
      `select ${list(columns)} from ${table} where ${quote(key)} in (${placeholders(ids.length)})`,
    )
    .all(...ids) as Row[];
}

async function syncEntity(local: DatabaseSync, writer: Writer, remote: Client, spec: EntityTable) {
  const key = spec.columns[0];
  const all = [...spec.columns, ...spec.stamps];
  const upsert = `on conflict (${quote(key)}) do update set ${all
    .slice(1)
    .map((column) => `${quote(column)} = excluded.${quote(column)}`)
    .join(', ')}`;
  const counts = { local: 0, inserted: 0, updated: 0 };
  for (const ids of localKeyPages(local, spec.table)) {
    const remoteByKey = new Map(
      (await remoteWhereIn(remote, spec.table, spec.columns, key, ids)).map((row) => [
        String(row[key]),
        signature(row, spec.columns),
      ]),
    );
    const changed: Row[] = [];
    for (const row of localWhereIn(local, spec.table, all, key, ids)) {
      counts.local++;
      const before = remoteByKey.get(String(row[key]));
      if (before === undefined) counts.inserted++;
      else if (before !== signature(row, spec.columns)) counts.updated++;
      else continue;
      changed.push(row);
    }
    await insertRows(writer, spec.table, all, changed, upsert);
  }
  return counts;
}

async function syncChildren(local: DatabaseSync, writer: Writer, remote: Client, spec: ChildTable) {
  const counts = { local: 0, replacedParents: 0, inserted: 0, deleted: 0 };
  const grouped = (rows: Row[]) => {
    const groups = new Map<string, string[]>();
    for (const row of rows) {
      const parent = String(row[spec.parent]);
      const list = groups.get(parent) ?? [];
      list.push(signature(row, spec.columns));
      groups.set(parent, list);
    }
    for (const list of groups.values()) list.sort();
    return groups;
  };
  // Every parent the dump holds is authoritative for its children, including having none.
  for (const ids of localKeyPages(local, spec.parentTable)) {
    const remoteGroups = grouped(
      await remoteWhereIn(remote, spec.table, spec.columns, spec.parent, ids),
    );
    const localRowsOfPage = localWhereIn(local, spec.table, spec.columns, spec.parent, ids);
    const localGroups = grouped(localRowsOfPage);
    counts.local += localRowsOfPage.length;
    const replaced = new Set<string>();
    let deleted = 0;
    for (const parent of ids) {
      const before = remoteGroups.get(parent) ?? [];
      const after = localGroups.get(parent) ?? [];
      if (before.join('\n') === after.join('\n')) continue;
      replaced.add(parent);
      deleted += before.length;
    }
    if (replaced.size === 0) continue;
    counts.replacedParents += replaced.size;
    counts.deleted += deleted;
    const doomed = [...replaced].filter((parent) => remoteGroups.has(parent));
    for (let start = 0; start < doomed.length; start += ROWS_PER_STATEMENT) {
      const chunk = doomed.slice(start, start + ROWS_PER_STATEMENT);
      await writer.add(
        {
          sql: `delete from ${spec.table} where ${quote(spec.parent)} in (${placeholders(chunk.length)})`,
          args: chunk,
        },
        0,
      );
    }
    // Deleted rows count against the write allowance too.
    writer.written += deleted;
    const rows = localRowsOfPage.filter((row) => replaced.has(String(row[spec.parent])));
    counts.inserted += rows.length;
    await insertRows(writer, spec.table, spec.columns, rows, 'on conflict do nothing');
  }
  return counts;
}

export async function syncToTurso(options: {
  local: DatabaseSync;
  remote: Client;
  dryRun: boolean;
  tables?: string[];
  log: Log;
}) {
  const { local, remote, dryRun, log } = options;
  const writer = new Writer(remote, dryRun);
  const wanted = (table: string) => !options.tables?.length || options.tables.includes(table);
  for (const spec of ENTITIES) {
    if (!wanted(spec.table)) continue;
    const counts = await syncEntity(local, writer, remote, spec);
    await writer.flush();
    log(`${spec.table}: ${JSON.stringify(counts)}; rows written so far ${writer.written}`);
  }
  for (const spec of CHILDREN) {
    if (!wanted(spec.table)) continue;
    const counts = await syncChildren(local, writer, remote, spec);
    await writer.flush();
    log(`${spec.table}: ${JSON.stringify(counts)}; rows written so far ${writer.written}`);
  }
  return { rowsWritten: writer.written };
}
