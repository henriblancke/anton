ALTER TABLE `runs` ADD `write_seq` integer;--> statement-breakpoint
CREATE INDEX `runs_write_seq_idx` ON `runs` (`write_seq`);