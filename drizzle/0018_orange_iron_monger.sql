CREATE TABLE `mb_release_url` (
	`release_mbid` text NOT NULL,
	`url` text NOT NULL,
	`relationship_type` text NOT NULL,
	`relationship_type_id` text NOT NULL,
	`ended` integer DEFAULT false NOT NULL,
	`begin` text,
	`end` text,
	`attributes` text NOT NULL,
	PRIMARY KEY(`release_mbid`, `url`, `relationship_type_id`),
	FOREIGN KEY (`release_mbid`) REFERENCES `mb_release`(`mbid`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `mb_release_url_type_idx` ON `mb_release_url` (`relationship_type_id`);--> statement-breakpoint
ALTER TABLE `mb_release` ADD `url_relations_fetched_at` integer;