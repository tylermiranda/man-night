ALTER TABLE restaurants ADD COLUMN eb_review_url TEXT;
ALTER TABLE restaurants ADD COLUMN eb_review_date TEXT;
ALTER TABLE restaurants ADD COLUMN eb_review_title TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_restaurants_eb_review_date
  ON restaurants (eb_review_date DESC, id DESC)
  WHERE eb_review_url IS NOT NULL;
