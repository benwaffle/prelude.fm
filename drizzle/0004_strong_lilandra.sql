ALTER TABLE `spotify_album` ADD `upc` text;--> statement-breakpoint
ALTER TABLE `spotify_album` ADD `mb_release_id` text;--> statement-breakpoint
ALTER TABLE `spotify_album` ADD `mb_checked_at` integer;--> statement-breakpoint
CREATE INDEX `spotify_album_mb_release_idx` ON `spotify_album` (`mb_release_id`);