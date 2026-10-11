CREATE TABLE `mb_missing_release` (
	`spotify_album_id` text NOT NULL,
	`stage` text NOT NULL,
	`value` text NOT NULL,
	`requests` integer,
	`recorded_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`spotify_album_id`, `stage`),
	FOREIGN KEY (`spotify_album_id`) REFERENCES `spotify_album`(`spotify_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Each old table becomes one stage. A seed opened on MusicBrainz also keeps
-- the plan that was opened (seeded_plan, from 0027) as its own stage.
INSERT INTO `mb_missing_release` (`spotify_album_id`, `stage`, `value`, `requests`, `recorded_at`)
SELECT `spotify_album_id`, 'precheck', `result`, `requests`, `checked_at` FROM `mb_release_precheck`;--> statement-breakpoint
INSERT INTO `mb_missing_release` (`spotify_album_id`, `stage`, `value`, `requests`, `recorded_at`)
SELECT `spotify_album_id`, 'seed', `plan`, `requests`, `prepared_at` FROM `mb_release_seed`;--> statement-breakpoint
INSERT INTO `mb_missing_release` (`spotify_album_id`, `stage`, `value`, `requests`, `recorded_at`)
SELECT `spotify_album_id`, 'seeded', `seeded_plan`, 0, `seeded_at` FROM `mb_release_seed`
WHERE `seeded_at` IS NOT NULL AND `seeded_plan` IS NOT NULL;--> statement-breakpoint
-- Corrections were never counted, so their requests stay unknown.
INSERT INTO `mb_missing_release` (`spotify_album_id`, `stage`, `value`, `requests`, `recorded_at`)
SELECT `spotify_album_id`, 'correction', `record`, NULL, `measured_at` FROM `mb_release_correction`;--> statement-breakpoint
DROP TABLE `mb_release_correction`;--> statement-breakpoint
DROP TABLE `mb_release_precheck`;--> statement-breakpoint
DROP TABLE `mb_release_seed`;--> statement-breakpoint
ALTER TABLE `mb_work_proposal` ADD `work_mbid` text;--> statement-breakpoint
UPDATE `mb_work_proposal` SET `work_mbid` = json_extract(`proposal`, '$.workMbid') WHERE `proposal` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `mb_work_proposal_work_idx` ON `mb_work_proposal` (`work_mbid`);
