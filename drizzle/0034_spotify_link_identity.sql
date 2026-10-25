ALTER TABLE `spotify_album` ADD `mb_release_matched_by` text;--> statement-breakpoint
CREATE INDEX `mb_release_url_url_idx` ON `mb_release_url` (`url`);