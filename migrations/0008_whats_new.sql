-- Track the latest What's New release id acknowledged by each club member
ALTER TABLE users ADD COLUMN whats_new_seen_id TEXT;
ALTER TABLE users ADD COLUMN whats_new_seen_at TEXT;
