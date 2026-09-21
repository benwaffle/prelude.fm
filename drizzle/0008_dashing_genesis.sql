CREATE TABLE `mb_recording_isrc` (
	`isrc` text NOT NULL,
	`recording_mbid` text NOT NULL,
	PRIMARY KEY(`isrc`, `recording_mbid`)
);
--> statement-breakpoint
CREATE INDEX `mb_recording_isrc_recording_idx` ON `mb_recording_isrc` (`recording_mbid`);