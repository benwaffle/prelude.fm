CREATE TABLE `mb_artist` (
	`mbid` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_name` text,
	`type` text,
	`begin_year` integer,
	`end_year` integer,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mb_recording` (
	`mbid` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`length` integer,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mb_recording_credit` (
	`recording_mbid` text NOT NULL,
	`artist_mbid` text NOT NULL,
	`role` text NOT NULL,
	`instrument` text DEFAULT '' NOT NULL,
	PRIMARY KEY(`recording_mbid`, `artist_mbid`, `role`, `instrument`)
);
--> statement-breakpoint
CREATE INDEX `mb_recording_credit_artist_idx` ON `mb_recording_credit` (`artist_mbid`);--> statement-breakpoint
CREATE TABLE `mb_recording_work` (
	`recording_mbid` text NOT NULL,
	`work_mbid` text NOT NULL,
	PRIMARY KEY(`recording_mbid`, `work_mbid`)
);
--> statement-breakpoint
CREATE INDEX `mb_recording_work_work_idx` ON `mb_recording_work` (`work_mbid`);--> statement-breakpoint
CREATE TABLE `mb_release` (
	`mbid` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`barcode` text,
	`date` text,
	`country` text,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mb_release_barcode_idx` ON `mb_release` (`barcode`);--> statement-breakpoint
CREATE TABLE `mb_release_track` (
	`release_mbid` text NOT NULL,
	`medium` integer NOT NULL,
	`position` integer NOT NULL,
	`recording_mbid` text NOT NULL,
	`title` text NOT NULL,
	`length` integer,
	PRIMARY KEY(`release_mbid`, `medium`, `position`)
);
--> statement-breakpoint
CREATE INDEX `mb_release_track_recording_idx` ON `mb_release_track` (`recording_mbid`);--> statement-breakpoint
CREATE TABLE `mb_work` (
	`mbid` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`type` text,
	`parent_mbid` text,
	`ordering_key` integer,
	`composer_mbid` text,
	`detail` text DEFAULT 'stub' NOT NULL,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `mb_work_parent_idx` ON `mb_work` (`parent_mbid`);--> statement-breakpoint
CREATE INDEX `mb_work_composer_idx` ON `mb_work` (`composer_mbid`);--> statement-breakpoint
CREATE INDEX `mb_work_detail_idx` ON `mb_work` (`detail`);--> statement-breakpoint
CREATE TABLE `mb_work_catalogue` (
	`work_mbid` text NOT NULL,
	`series_mbid` text NOT NULL,
	`system` text NOT NULL,
	`number` text NOT NULL,
	`normalized_system` text NOT NULL,
	`normalized_number` text NOT NULL,
	PRIMARY KEY(`work_mbid`, `series_mbid`, `number`)
);
--> statement-breakpoint
CREATE INDEX `mb_work_catalogue_lookup_idx` ON `mb_work_catalogue` (`normalized_system`,`normalized_number`);--> statement-breakpoint
CREATE TABLE `track_recording` (
	`spotify_track_id` text PRIMARY KEY NOT NULL,
	`recording_mbid` text NOT NULL,
	`isrc` text,
	`matched_by` text NOT NULL,
	`matched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`spotify_track_id`) REFERENCES `spotify_track`(`spotify_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `track_recording_recording_idx` ON `track_recording` (`recording_mbid`);--> statement-breakpoint
CREATE INDEX `track_recording_matched_by_idx` ON `track_recording` (`matched_by`);