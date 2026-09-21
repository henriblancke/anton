ALTER TABLE `runs` ADD `base_refresh_outcome` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `base_refresh_sha` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `pending_refresh_from_sha` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `pending_refresh_kind` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `prior_base_refresh_sha` text;