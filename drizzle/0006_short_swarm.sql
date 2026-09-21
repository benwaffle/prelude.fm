CREATE TABLE `mb_gateway_control` (
	`channel` text PRIMARY KEY NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`daily_cap` integer,
	`note` text,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mb_request_budget` (
	`day` text NOT NULL,
	`channel` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `channel`)
);
