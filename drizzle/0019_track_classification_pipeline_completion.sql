CREATE TABLE `track_classification` (
	`spotify_track_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`provenance` text NOT NULL,
	`reason` text,
	`evidence_mbid` text,
	`decided_at` integer NOT NULL,
	FOREIGN KEY (`spotify_track_id`) REFERENCES `spotify_track`(`spotify_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `track_classification_state_idx` ON `track_classification` (`state`);--> statement-breakpoint
ALTER TABLE `match_queue` ADD `pipeline_outcome` text;--> statement-breakpoint
ALTER TABLE `match_queue` ADD `pipeline_reason` text;--> statement-breakpoint
ALTER TABLE `match_queue` ADD `pipeline_completed_at` integer;--> statement-breakpoint
CREATE INDEX `match_queue_pipeline_outcome_idx` ON `match_queue` (`pipeline_outcome`);--> statement-breakpoint
INSERT INTO `track_classification` (`spotify_track_id`, `state`, `provenance`, `reason`, `evidence_mbid`, `decided_at`)
SELECT
	mq.`spotify_id`,
	'not_classical',
	'llm_proposal',
	COALESCE(mq.`error_message`, 'legacy match_queue not_classical status'),
	NULL,
	COALESCE(mq.`processed_at`, mq.`submitted_at`)
FROM `match_queue` mq
INNER JOIN `spotify_track` st ON st.`spotify_id` = mq.`spotify_id`
WHERE mq.`status` = 'not_classical';--> statement-breakpoint
UPDATE `match_queue`
SET
	`pipeline_outcome` = 'not_classical',
	`pipeline_reason` = COALESCE(`error_message`, 'legacy parser ruled not classical'),
	`pipeline_completed_at` = COALESCE(`processed_at`, `submitted_at`)
WHERE `status` = 'not_classical';