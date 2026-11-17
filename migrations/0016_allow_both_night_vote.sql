-- Allow 'both' in night_votes choice CHECK constraint so members can vote availability for either night

CREATE TABLE IF NOT EXISTS night_votes_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dinner_id INTEGER NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  user_slug TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('tuesday', 'wednesday', 'both')),
  voted_at TEXT NOT NULL DEFAULT (datetime('now')),
  reason TEXT NOT NULL DEFAULT '',
  UNIQUE(dinner_id, user_slug)
);

INSERT INTO night_votes_new (id, dinner_id, user_slug, choice, voted_at, reason)
SELECT id, dinner_id, user_slug, choice, voted_at, COALESCE(reason, '')
FROM night_votes;

DROP TABLE night_votes;

ALTER TABLE night_votes_new RENAME TO night_votes;

CREATE INDEX IF NOT EXISTS idx_night_votes_dinner ON night_votes(dinner_id);
