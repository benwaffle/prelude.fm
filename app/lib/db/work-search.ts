import { sql, type SQL } from 'drizzle-orm';

// Full-text search over work titles and their composers' names. `mb_work` is 644k rows once the
// dump is in, so a `like '%…%'` search read all of it (and its composers) on every query. FTS5
// isn't something drizzle's schema can describe: the table and its triggers are created by
// migration 0038, and `tests/helpers/test-database.ts` runs these same statements.
//
// The index keeps itself current through triggers on `mb_work` and `mb_artist`, which every
// writer (the web-service cache, the dump sync) goes through. Its rowid is the work's rowid; the
// work's MBID is stored alongside, so a result never depends on rowids staying put. Rowids of a
// table without an integer key can move under VACUUM, so the triggers write with OR REPLACE and
// delete only a matching MBID: a write to `mb_work` never fails on the index, and the worst a moved
// rowid does is leave a stale entry, which finds nothing (results are joined back by MBID). To
// rebuild: `delete from mb_work_search`, then the last statement below.

export const WORK_SEARCH_DDL = [
  `CREATE VIRTUAL TABLE mb_work_search USING fts5(title, composer, mbid UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
  `CREATE TRIGGER mb_work_search_insert AFTER INSERT ON mb_work BEGIN
  INSERT OR REPLACE INTO mb_work_search (rowid, title, composer, mbid)
    VALUES (new.rowid, new.title, (SELECT name FROM mb_artist WHERE mbid = new.composer_mbid), new.mbid);
END`,
  `CREATE TRIGGER mb_work_search_update AFTER UPDATE OF title, composer_mbid ON mb_work
  WHEN old.title IS NOT new.title OR old.composer_mbid IS NOT new.composer_mbid BEGIN
  DELETE FROM mb_work_search WHERE rowid = old.rowid AND mbid = old.mbid;
  INSERT OR REPLACE INTO mb_work_search (rowid, title, composer, mbid)
    VALUES (new.rowid, new.title, (SELECT name FROM mb_artist WHERE mbid = new.composer_mbid), new.mbid);
END`,
  `CREATE TRIGGER mb_work_search_delete AFTER DELETE ON mb_work BEGIN
  DELETE FROM mb_work_search WHERE rowid = old.rowid AND mbid = old.mbid;
END`,
  // A composer read after their works (the web-service path caches works first).
  `CREATE TRIGGER mb_work_search_composer_insert AFTER INSERT ON mb_artist BEGIN
  UPDATE mb_work_search SET composer = new.name
    WHERE rowid IN (SELECT rowid FROM mb_work WHERE composer_mbid = new.mbid);
END`,
  `CREATE TRIGGER mb_work_search_composer_update AFTER UPDATE OF name ON mb_artist
  WHEN old.name IS NOT new.name BEGIN
  UPDATE mb_work_search SET composer = new.name
    WHERE rowid IN (SELECT rowid FROM mb_work WHERE composer_mbid = new.mbid);
END`,
  // Composers by name: the composer list shows only those with something playable, so this is how
  // the rest are found. One entry per `catalog_composer` row (rowid for rowid), named from
  // `mb_artist` whichever is written first.
  `CREATE VIRTUAL TABLE catalog_composer_search USING fts5(name, mbid UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
  `CREATE TRIGGER catalog_composer_search_insert AFTER INSERT ON catalog_composer BEGIN
  INSERT OR REPLACE INTO catalog_composer_search (rowid, name, mbid)
    VALUES (new.rowid, (SELECT name FROM mb_artist WHERE mbid = new.composer_mbid), new.composer_mbid);
END`,
  `CREATE TRIGGER catalog_composer_search_delete AFTER DELETE ON catalog_composer BEGIN
  DELETE FROM catalog_composer_search WHERE rowid = old.rowid AND mbid = old.composer_mbid;
END`,
  `CREATE TRIGGER catalog_composer_search_artist_insert AFTER INSERT ON mb_artist BEGIN
  UPDATE catalog_composer_search SET name = new.name
    WHERE rowid = (SELECT rowid FROM catalog_composer WHERE composer_mbid = new.mbid);
END`,
  `CREATE TRIGGER catalog_composer_search_artist_update AFTER UPDATE OF name ON mb_artist
  WHEN old.name IS NOT new.name BEGIN
  UPDATE catalog_composer_search SET name = new.name
    WHERE rowid = (SELECT rowid FROM catalog_composer WHERE composer_mbid = new.mbid);
END`,
  `INSERT INTO catalog_composer_search (rowid, name, mbid)
  SELECT c.rowid, a.name, c.composer_mbid FROM catalog_composer c LEFT JOIN mb_artist a ON a.mbid = c.composer_mbid`,
  // The works already cached when the index was made.
  `INSERT INTO mb_work_search (rowid, title, composer, mbid)
  SELECT w.rowid, w.title, a.name, w.mbid FROM mb_work w LEFT JOIN mb_artist a ON a.mbid = w.composer_mbid`,
];

// Each word the reader typed must start a word of the title or composer, in any order, accents
// aside: "dvorak 9" finds Dvořák's Symphony No. 9 "From the New World", which a substring search
// on the title alone could not. Null when nothing searchable was typed.
export function workSearchQuery(text: string, column?: 'title' | 'composer'): string | null {
  const words = text.match(/[\p{L}\p{N}]+/gu);
  if (!words) return null;
  const terms = words.map((word) => `"${word}"*`).join(' ');
  return column ? `${column} : (${terms})` : terms;
}

/** Matching works, best first. */
export function matchingWorks(query: string, limit: number): SQL {
  return sql`select mbid from mb_work_search where mb_work_search match ${query} order by rank limit ${limit}`;
}
