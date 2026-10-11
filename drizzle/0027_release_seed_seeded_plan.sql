ALTER TABLE `mb_release_seed` ADD `seeded_plan` text;--> statement-breakpoint
-- A seed opened before this column existed was opened with the plan stored now.
UPDATE `mb_release_seed` SET `seeded_plan` = `plan` WHERE `seeded_at` IS NOT NULL;
