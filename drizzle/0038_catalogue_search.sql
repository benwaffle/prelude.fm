CREATE TABLE `catalog_composer` (
	`composer_mbid` text PRIMARY KEY NOT NULL,
	`works` integer,
	`playable_works` integer,
	`recordings` integer,
	`counted_at` integer
);
--> statement-breakpoint
CREATE INDEX `catalog_composer_playable_idx` ON `catalog_composer` (`playable_works`);--> statement-breakpoint
CREATE INDEX `catalog_composer_counted_idx` ON `catalog_composer` (`counted_at`);--> statement-breakpoint
CREATE VIRTUAL TABLE mb_work_search USING fts5(title, composer, mbid UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
--> statement-breakpoint
CREATE TRIGGER mb_work_search_insert AFTER INSERT ON mb_work BEGIN
  INSERT OR REPLACE INTO mb_work_search (rowid, title, composer, mbid)
    VALUES (new.rowid, new.title, (SELECT name FROM mb_artist WHERE mbid = new.composer_mbid), new.mbid);
END;
--> statement-breakpoint
CREATE TRIGGER mb_work_search_update AFTER UPDATE OF title, composer_mbid ON mb_work
  WHEN old.title IS NOT new.title OR old.composer_mbid IS NOT new.composer_mbid BEGIN
  DELETE FROM mb_work_search WHERE rowid = old.rowid AND mbid = old.mbid;
  INSERT OR REPLACE INTO mb_work_search (rowid, title, composer, mbid)
    VALUES (new.rowid, new.title, (SELECT name FROM mb_artist WHERE mbid = new.composer_mbid), new.mbid);
END;
--> statement-breakpoint
CREATE TRIGGER mb_work_search_delete AFTER DELETE ON mb_work BEGIN
  DELETE FROM mb_work_search WHERE rowid = old.rowid AND mbid = old.mbid;
END;
--> statement-breakpoint
CREATE TRIGGER mb_work_search_composer_insert AFTER INSERT ON mb_artist BEGIN
  UPDATE mb_work_search SET composer = new.name
    WHERE rowid IN (SELECT rowid FROM mb_work WHERE composer_mbid = new.mbid);
END;
--> statement-breakpoint
CREATE TRIGGER mb_work_search_composer_update AFTER UPDATE OF name ON mb_artist
  WHEN old.name IS NOT new.name BEGIN
  UPDATE mb_work_search SET composer = new.name
    WHERE rowid IN (SELECT rowid FROM mb_work WHERE composer_mbid = new.mbid);
END;
--> statement-breakpoint
CREATE VIRTUAL TABLE catalog_composer_search USING fts5(name, mbid UNINDEXED, tokenize = 'unicode61 remove_diacritics 2', prefix = '2 3');
--> statement-breakpoint
CREATE TRIGGER catalog_composer_search_insert AFTER INSERT ON catalog_composer BEGIN
  INSERT OR REPLACE INTO catalog_composer_search (rowid, name, mbid)
    VALUES (new.rowid, (SELECT name FROM mb_artist WHERE mbid = new.composer_mbid), new.composer_mbid);
END;
--> statement-breakpoint
CREATE TRIGGER catalog_composer_search_delete AFTER DELETE ON catalog_composer BEGIN
  DELETE FROM catalog_composer_search WHERE rowid = old.rowid AND mbid = old.composer_mbid;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_composer_search_artist_insert AFTER INSERT ON mb_artist BEGIN
  UPDATE catalog_composer_search SET name = new.name
    WHERE rowid = (SELECT rowid FROM catalog_composer WHERE composer_mbid = new.mbid);
END;
--> statement-breakpoint
CREATE TRIGGER catalog_composer_search_artist_update AFTER UPDATE OF name ON mb_artist
  WHEN old.name IS NOT new.name BEGIN
  UPDATE catalog_composer_search SET name = new.name
    WHERE rowid = (SELECT rowid FROM catalog_composer WHERE composer_mbid = new.mbid);
END;
--> statement-breakpoint
INSERT INTO catalog_composer_search (rowid, name, mbid)
  SELECT c.rowid, a.name, c.composer_mbid FROM catalog_composer c LEFT JOIN mb_artist a ON a.mbid = c.composer_mbid;
--> statement-breakpoint
INSERT INTO mb_work_search (rowid, title, composer, mbid)
  SELECT w.rowid, w.title, a.name, w.mbid FROM mb_work w LEFT JOIN mb_artist a ON a.mbid = w.composer_mbid;
