CREATE TABLE `mb_invariant_result` (
	`name` text PRIMARY KEY NOT NULL,
	`severity` text NOT NULL,
	`violations` integer NOT NULL,
	`samples` text,
	`checked_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
