-- Appetizer tracking across dinners, reviews, and photos (Issue #17)

ALTER TABLE ratings ADD COLUMN appetizer TEXT NOT NULL DEFAULT '';
ALTER TABLE meal_photos ADD COLUMN appetizer TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_ratings_appetizer ON ratings(appetizer) WHERE appetizer != '';
CREATE INDEX IF NOT EXISTS idx_meal_photos_appetizer ON meal_photos(appetizer) WHERE appetizer != '';
