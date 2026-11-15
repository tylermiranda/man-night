-- Track sellout attribution and index attendance/sellout lookups
ALTER TABLE rsvps ADD COLUMN recorded_by TEXT;
CREATE INDEX IF NOT EXISTS idx_rsvps_status_user ON rsvps(status, user_slug);
CREATE INDEX IF NOT EXISTS idx_rsvps_dinner ON rsvps(dinner_id);
