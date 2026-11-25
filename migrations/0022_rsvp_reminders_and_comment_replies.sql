ALTER TABLE dinners ADD COLUMN rsvp_reminder_sent_at TEXT;

ALTER TABLE dinner_comments ADD COLUMN parent_comment_id INTEGER REFERENCES dinner_comments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_dinner_comments_parent ON dinner_comments(parent_comment_id, created_at ASC, id ASC);
