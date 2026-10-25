import { sql, type SQL } from 'drizzle-orm';

// Full-text search over album titles, for the admin pages (Albums, Matches). The Spotify crawl
// makes `spotify_album` ~300k rows, which a `like '%…%'` read whole on every search. Created by
// migration 0039 (FTS5 isn't something drizzle's schema describes); `tests/helpers/test-database.ts`
// runs these same statements. Triggers keep it current the way `work-search.ts` does: OR REPLACE
// and a matching ID, so a write to `spotify_album` never fails on the index. To rebuild:
// `delete from spotify_album_search`, then the last statement below.
export const ALBUM_SEARCH_DDL = [
  `CREATE VIRTUAL TABLE spotify_album_search USING fts5(title, spotify_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3')`,
  `CREATE TRIGGER spotify_album_search_insert AFTER INSERT ON spotify_album BEGIN
  INSERT OR REPLACE INTO spotify_album_search (rowid, title, spotify_id) VALUES (new.rowid, new.title, new.spotify_id);
END`,
  `CREATE TRIGGER spotify_album_search_update AFTER UPDATE OF title ON spotify_album
  WHEN old.title IS NOT new.title BEGIN
  DELETE FROM spotify_album_search WHERE rowid = old.rowid AND spotify_id = old.spotify_id;
  INSERT OR REPLACE INTO spotify_album_search (rowid, title, spotify_id) VALUES (new.rowid, new.title, new.spotify_id);
END`,
  `CREATE TRIGGER spotify_album_search_delete AFTER DELETE ON spotify_album BEGIN
  DELETE FROM spotify_album_search WHERE rowid = old.rowid AND spotify_id = old.spotify_id;
END`,
  `INSERT INTO spotify_album_search (rowid, title, spotify_id) SELECT rowid, title, spotify_id FROM spotify_album`,
];

/** Albums whose title matches (`workSearchQuery` builds the query), best first. */
export function matchingAlbums(query: string, limit: number): SQL {
  return sql`select spotify_id from spotify_album_search where spotify_album_search match ${query} order by rank limit ${limit}`;
}
