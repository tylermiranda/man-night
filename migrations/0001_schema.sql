PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  avatar_class TEXT NOT NULL,
  initials TEXT NOT NULL,
  is_rotation INTEGER NOT NULL DEFAULT 1,
  rotation_order INTEGER,
  notify_night_vote INTEGER NOT NULL DEFAULT 1,
  notify_place INTEGER NOT NULL DEFAULT 1,
  notify_reminder INTEGER NOT NULL DEFAULT 1,
  walkthrough_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS restaurants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT 'Wichita',
  lat REAL,
  lng REAL,
  google_place_id TEXT,
  visit_count INTEGER NOT NULL DEFAULT 0,
  last_visited TEXT,
  avg_rating REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_restaurants_visits ON restaurants(visit_count DESC, name ASC);
CREATE INDEX IF NOT EXISTS idx_restaurants_last_visited ON restaurants(last_visited);

CREATE TABLE IF NOT EXISTS dinners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_key TEXT UNIQUE NOT NULL,
  dinner_date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '18:30',
  day_of_week TEXT NOT NULL,
  host_slug TEXT,
  host_label TEXT NOT NULL,
  restaurant_id INTEGER REFERENCES restaurants(id),
  raw_location TEXT NOT NULL DEFAULT '',
  raw_summary TEXT NOT NULL DEFAULT '',
  ics_uid TEXT,
  gcal_event_id TEXT,
  status TEXT NOT NULL DEFAULT 'completed',
  chosen_via TEXT NOT NULL DEFAULT 'seed',
  night_poll_opened_at TEXT,
  night_locked_at TEXT,
  noon_draw_opened_at TEXT,
  noon_draw_ids TEXT,
  place_locked_at TEXT,
  reminder_sent_at TEXT,
  completed_at TEXT,
  is_historical INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dinners_date ON dinners(dinner_date DESC);
CREATE INDEX IF NOT EXISTS idx_dinners_status ON dinners(status);
CREATE INDEX IF NOT EXISTS idx_dinners_host ON dinners(host_slug);
CREATE INDEX IF NOT EXISTS idx_dinners_restaurant ON dinners(restaurant_id);

CREATE TABLE IF NOT EXISTS night_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dinner_id INTEGER NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  user_slug TEXT NOT NULL,
  choice TEXT NOT NULL CHECK (choice IN ('tuesday', 'wednesday')),
  voted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dinner_id, user_slug)
);

CREATE TABLE IF NOT EXISTS noon_votes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dinner_id INTEGER NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  user_slug TEXT NOT NULL,
  restaurant_id INTEGER NOT NULL REFERENCES restaurants(id),
  voted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dinner_id, user_slug)
);

CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dinner_id INTEGER NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  user_slug TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in', 'late', 'out')),
  eta_minutes INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dinner_id, user_slug)
);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dinner_id INTEGER NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  restaurant_id INTEGER REFERENCES restaurants(id),
  user_slug TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  dish TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  rated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dinner_id, user_slug)
);

CREATE TABLE IF NOT EXISTS rotation_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dinner_id INTEGER NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('pass', 'swap')),
  from_slug TEXT NOT NULL,
  to_slug TEXT NOT NULL,
  actor_slug TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slug TEXT NOT NULL,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_slug);

CREATE TABLE IF NOT EXISTS issue_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'bug',
  page_context TEXT NOT NULL DEFAULT '',
  github_issue_number INTEGER,
  github_issue_url TEXT,
  webhook_status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
