-- Meal Pictures: split lightweight metadata from base64 image payloads so list/count queries stay fast in D1

CREATE TABLE IF NOT EXISTS meal_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dinner_id INTEGER NOT NULL REFERENCES dinners(id) ON DELETE CASCADE,
  restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE SET NULL,
  user_slug TEXT NOT NULL,
  dish TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
  width INTEGER,
  height INTEGER,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meal_photo_blobs (
  photo_id INTEGER PRIMARY KEY REFERENCES meal_photos(id) ON DELETE CASCADE,
  image_base64 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meal_photos_dinner ON meal_photos(dinner_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_meal_photos_restaurant ON meal_photos(restaurant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_meal_photos_user ON meal_photos(user_slug, created_at DESC);
