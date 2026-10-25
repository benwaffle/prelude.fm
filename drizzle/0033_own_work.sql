CREATE TABLE `own_work` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`type` text,
	`parent_id` text,
	`ordering_key` integer,
	`composer_mbid` text,
	`source` text NOT NULL,
	`mb_work_mbid` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `own_work_mb_work_mbid_unique` ON `own_work` (`mb_work_mbid`);--> statement-breakpoint
CREATE INDEX `own_work_parent_idx` ON `own_work` (`parent_id`);--> statement-breakpoint
CREATE INDEX `own_work_composer_idx` ON `own_work` (`composer_mbid`);--> statement-breakpoint
CREATE TABLE `own_work_catalogue` (
	`work_id` text NOT NULL,
	`system` text NOT NULL,
	`number` text NOT NULL,
	`normalized_system` text NOT NULL,
	`normalized_number` text NOT NULL,
	PRIMARY KEY(`work_id`, `system`, `number`),
	FOREIGN KEY (`work_id`) REFERENCES `own_work`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `own_work_catalogue_lookup_idx` ON `own_work_catalogue` (`normalized_system`,`normalized_number`);