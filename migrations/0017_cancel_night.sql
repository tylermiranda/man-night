-- Add cancellation tracking fields to dinners
ALTER TABLE dinners ADD COLUMN cancelled_at TEXT;
ALTER TABLE dinners ADD COLUMN cancelled_by TEXT;
ALTER TABLE dinners ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE dinners ADD COLUMN cancelled_prev_status TEXT;
ALTER TABLE dinners ADD COLUMN cancelled_archived_at TEXT;
