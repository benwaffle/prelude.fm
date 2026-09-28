CREATE TABLE `mb_release_seed` (
	`spotify_album_id` text PRIMARY KEY NOT NULL,
	`plan` text NOT NULL,
	`requests` integer NOT NULL,
	`prepared_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`seeded_at` integer,
	FOREIGN KEY (`spotify_album_id`) REFERENCES `spotify_album`(`spotify_id`) ON UPDATE no action ON DELETE no action
);
