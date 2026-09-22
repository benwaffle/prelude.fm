CREATE TABLE `mb_cache_lookup_metric` (
	`day` text NOT NULL,
	`operation` text NOT NULL,
	`lookups` integer DEFAULT 0 NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`misses` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `operation`)
);
--> statement-breakpoint
CREATE TABLE `mb_import_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`completed_at` integer NOT NULL,
	`input_track_count` integer NOT NULL,
	`classical_count` integer NOT NULL,
	`uncertain_count` integer NOT NULL,
	`not_classical_count` integer NOT NULL,
	`unreviewed_count` integer NOT NULL,
	`albums_already_cached` integer NOT NULL,
	`albums_new` integer NOT NULL,
	`requests_caused` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mb_request_operation_metric` (
	`day` text NOT NULL,
	`channel` text NOT NULL,
	`operation` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `channel`, `operation`)
);
