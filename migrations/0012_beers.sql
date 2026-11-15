-- Beer tracking: what the crew bought, where, how it scored, and a photo

CREATE TABLE IF NOT EXISTS beers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slug TEXT NOT NULL,
  name TEXT NOT NULL,
  brewery TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',
  purchased_where TEXT NOT NULL DEFAULT '',
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS beer_photos (
  beer_id INTEGER PRIMARY KEY REFERENCES beers(id) ON DELETE CASCADE,
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL,
  image_base64 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_beers_user ON beers(user_slug, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_beers_created ON beers(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_beers_rating ON beers(rating DESC);
CREATE INDEX IF NOT EXISTS idx_beers_name ON beers(name COLLATE NOCASE);
