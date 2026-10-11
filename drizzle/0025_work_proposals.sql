CREATE TABLE `mb_work_proposal` (
	`recording_mbid` text PRIMARY KEY NOT NULL,
	`release_mbid` text,
	`proposal` text,
	`status` text DEFAULT 'proposed' NOT NULL,
	`requests` integer NOT NULL,
	`checked_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE INDEX `mb_work_proposal_status_idx` ON `mb_work_proposal` (`status`);