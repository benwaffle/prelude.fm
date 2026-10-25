CREATE INDEX `spotify_album_upc_idx` ON `spotify_album` (`upc`);--> statement-breakpoint
CREATE VIRTUAL TABLE spotify_album_search USING fts5(title, spotify_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
--> statement-breakpoint
CREATE TRIGGER spotify_album_search_insert AFTER INSERT ON spotify_album BEGIN
  INSERT OR REPLACE INTO spotify_album_search (rowid, title, spotify_id) VALUES (new.rowid, new.title, new.spotify_id);
END;
--> statement-breakpoint
CREATE TRIGGER spotify_album_search_update AFTER UPDATE OF title ON spotify_album
  WHEN old.title IS NOT new.title BEGIN
  DELETE FROM spotify_album_search WHERE rowid = old.rowid AND spotify_id = old.spotify_id;
  INSERT OR REPLACE INTO spotify_album_search (rowid, title, spotify_id) VALUES (new.rowid, new.title, new.spotify_id);
END;
--> statement-breakpoint
CREATE TRIGGER spotify_album_search_delete AFTER DELETE ON spotify_album BEGIN
  DELETE FROM spotify_album_search WHERE rowid = old.rowid AND spotify_id = old.spotify_id;
END;
--> statement-breakpoint
INSERT INTO spotify_album_search (rowid, title, spotify_id) SELECT rowid, title, spotify_id FROM spotify_album;
