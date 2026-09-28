CREATE TABLE `mb_release_correction` (
	`spotify_album_id` text PRIMARY KEY NOT NULL,
	`release_mbid` text NOT NULL,
	`kind` text NOT NULL,
	`corrections` integer NOT NULL,
	`incomplete` integer NOT NULL,
	`record` text NOT NULL,
	`measured_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`spotify_album_id`) REFERENCES `spotify_album`(`spotify_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mb_release_correction_kind_idx` ON `mb_release_correction` (`kind`);--> statement-breakpoint
CREATE TABLE `mb_release_precheck` (
	`spotify_album_id` text PRIMARY KEY NOT NULL,
	`result` text NOT NULL,
	`requests` integer NOT NULL,
	`checked_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`spotify_album_id`) REFERENCES `spotify_album`(`spotify_id`) ON UPDATE no action ON DELETE no action
);
