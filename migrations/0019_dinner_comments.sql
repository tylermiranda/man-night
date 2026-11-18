CREATE TABLE IF NOT EXISTS dinner_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dinner_id INTEGER NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  user_slug TEXT NOT NULL,
  body TEXT NOT NULL,
  mentioned_slugs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dinner_comments_dinner ON dinner_comments(dinner_id, created_at ASC, id ASC);
