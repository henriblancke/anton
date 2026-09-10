-- One durable driver-call id groups the per-model rows of an invocation.
-- Existing rows remain readable through the legacy grouping key; new writes always fill this.
--
-- Reverse:
--   DROP INDEX IF EXISTS claude_invocations_invocation_idx;
--   ALTER TABLE claude_invocations DROP COLUMN invocation_id;

ALTER TABLE claude_invocations ADD COLUMN invocation_id text;--> statement-breakpoint
CREATE INDEX claude_invocations_invocation_idx ON claude_invocations(invocation_id);
