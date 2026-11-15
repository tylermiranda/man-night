-- Meal Price & Inflation Tracking across dinners, ratings, and places

ALTER TABLE ratings ADD COLUMN price REAL;
ALTER TABLE dinners ADD COLUMN meal_price REAL;

CREATE INDEX IF NOT EXISTS idx_ratings_price ON ratings(price);
CREATE INDEX IF NOT EXISTS idx_dinners_meal_price ON dinners(meal_price);
