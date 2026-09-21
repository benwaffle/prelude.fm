CREATE TABLE `mb_submission` (
	`id` integer PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`target_mbid` text,
	`subject` text NOT NULL,
	`value` text,
	`evidence` text,
	`submitted_by` text NOT NULL,
	`submitted_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`edit_id` text,
	`outcome` text DEFAULT 'pending' NOT NULL,
	`outcome_at` integer,
	`note` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mb_submission_identity_idx` ON `mb_submission` (`kind`,`target_mbid`,`value`);--> statement-breakpoint
CREATE INDEX `mb_submission_outcome_idx` ON `mb_submission` (`outcome`);--> statement-breakpoint
CREATE INDEX `mb_submission_subject_idx` ON `mb_submission` (`subject`);