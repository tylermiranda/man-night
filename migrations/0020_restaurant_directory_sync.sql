ALTER TABLE restaurants ADD COLUMN is_closed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN closed_at TEXT;
ALTER TABLE restaurants ADD COLUMN closed_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurants ADD COLUMN closed_source_url TEXT;
ALTER TABLE restaurants ADD COLUMN status_locked INTEGER NOT NULL DEFAULT 0;
ALTER TABLE restaurants ADD COLUMN source TEXT NOT NULL DEFAULT 'club';
ALTER TABLE restaurants ADD COLUMN source_external_id TEXT;
ALTER TABLE restaurants ADD COLUMN source_url TEXT;
ALTER TABLE restaurants ADD COLUMN cuisine TEXT NOT NULL DEFAULT '';
ALTER TABLE restaurants ADD COLUMN discovered_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_restaurants_source_ext_id
  ON restaurants(source_external_id)
  WHERE source_external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_restaurants_closed_visits
  ON restaurants(is_closed, visit_count DESC, name ASC);

CREATE TABLE IF NOT EXISTS restaurant_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  mode TEXT NOT NULL,
  cursor_post_date TEXT,
  added_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  closed_count INTEGER NOT NULL DEFAULT 0,
  flagged_count INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS restaurant_closing_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  wp_post_id INTEGER NOT NULL,
  post_title TEXT NOT NULL,
  post_url TEXT NOT NULL,
  post_date TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'ambiguous',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed_closed', 'dismissed')),
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(restaurant_id, wp_post_id)
);

CREATE INDEX IF NOT EXISTS idx_closing_flags_status
  ON restaurant_closing_flags(status, created_at DESC);
