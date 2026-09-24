-- Unusable pending events stay retryable by shipped repairs
-- (lib/repairs.ts). A repair that rewrites one keeps the upload in
-- original_payload_json and its own id in repaired_by; repair_epoch
-- records which set of repairs a row has been offered, so each repair
-- runs once per row.
ALTER TABLE `pending_events` ADD `original_payload_json` text;
--> statement-breakpoint
ALTER TABLE `pending_events` ADD `repaired_by` text;
--> statement-breakpoint
ALTER TABLE `pending_events` ADD `repair_epoch` text;
