ALTER TABLE `escalations` ADD `dismissed_at` integer;--> statement-breakpoint
ALTER TABLE `escalations` ADD `signature` text;--> statement-breakpoint
CREATE INDEX `escalations_dismissed_idx` ON `escalations` (`project_id`,`finding_key`) WHERE "escalations"."dismissed_at" is not null;