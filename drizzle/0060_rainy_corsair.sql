ALTER TABLE `decisions` ADD `settle_seq` integer;--> statement-breakpoint
CREATE INDEX `decisions_settle_seq_idx` ON `decisions` (`settle_seq`);