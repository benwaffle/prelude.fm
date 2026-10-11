CREATE TABLE `track_work_link` (
	`spotify_track_id` text PRIMARY KEY NOT NULL,
	`work_mbid` text,
	`match` text,
	`requests` integer NOT NULL,
	`checked_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`spotify_track_id`) REFERENCES `spotify_track`(`spotify_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `track_work_link_work_idx` ON `track_work_link` (`work_mbid`);