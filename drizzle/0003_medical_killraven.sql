CREATE TABLE `musicbrainz_fact` (
	`id` integer PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` integer NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`musicbrainz_id` text NOT NULL,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `musicbrainz_fact_entity_field_idx` ON `musicbrainz_fact` (`entity_type`,`entity_id`,`field`);--> statement-breakpoint
CREATE INDEX `musicbrainz_fact_field_idx` ON `musicbrainz_fact` (`field`);--> statement-breakpoint
ALTER TABLE `composer` ADD `musicbrainz_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `composer_musicbrainz_id_unique` ON `composer` (`musicbrainz_id`);--> statement-breakpoint
ALTER TABLE `spotify_track` ADD `isrc` text;--> statement-breakpoint
ALTER TABLE `spotify_track` ADD `mb_recording_id` text;--> statement-breakpoint
CREATE INDEX `spotify_track_isrc_idx` ON `spotify_track` (`isrc`);--> statement-breakpoint
CREATE INDEX `spotify_track_mb_recording_idx` ON `spotify_track` (`mb_recording_id`);--> statement-breakpoint
ALTER TABLE `work` ADD `musicbrainz_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `work_musicbrainz_id_unique` ON `work` (`musicbrainz_id`);--> statement-breakpoint
ALTER TABLE `work_catalog_v2` ADD `source` text DEFAULT 'parser' NOT NULL;--> statement-breakpoint
ALTER TABLE `work_part_v2` ADD `musicbrainz_id` text;--> statement-breakpoint
CREATE INDEX `work_part_v2_musicbrainz_idx` ON `work_part_v2` (`musicbrainz_id`);