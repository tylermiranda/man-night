CREATE INDEX IF NOT EXISTS idx_ratings_restaurant ON ratings(restaurant_id, rated_at DESC);

UPDATE ratings
SET restaurant_id = (SELECT d.restaurant_id FROM dinners d WHERE d.id = ratings.dinner_id)
WHERE restaurant_id IS NULL
  AND EXISTS (SELECT 1 FROM dinners d WHERE d.id = ratings.dinner_id AND d.restaurant_id IS NOT NULL);

UPDATE restaurants
SET avg_rating = (SELECT ROUND(AVG(score), 2) FROM ratings WHERE ratings.restaurant_id = restaurants.id)
WHERE EXISTS (SELECT 1 FROM ratings WHERE ratings.restaurant_id = restaurants.id);
