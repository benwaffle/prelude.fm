CREATE TABLE `spotify_crawl` (
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`isrcs` text,
	`album_ids` text NOT NULL,
	`outcome` text NOT NULL,
	`requests` integer NOT NULL,
	`checked_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`kind`, `subject`)
);
--> statement-breakpoint
CREATE INDEX `spotify_crawl_outcome_idx` ON `spotify_crawl` (`kind`,`outcome`);