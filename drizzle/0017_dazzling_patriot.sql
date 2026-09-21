-- The v1 metadata tables, superseded by work_part_v2 / recording_v2 /
-- track_work_part_v2 long ago. They were still declared in schema.ts but had
-- already been removed from production, so this drops them IF EXISTS: the
-- statement has to succeed both on a database that still carries them and on
-- one where they are already gone.
DROP TABLE IF EXISTS `track_movement`;--> statement-breakpoint
DROP TABLE IF EXISTS `movement`;--> statement-breakpoint
DROP TABLE IF EXISTS `recording`;
