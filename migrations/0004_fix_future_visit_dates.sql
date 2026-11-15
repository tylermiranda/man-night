-- Merge duplicate future-seeded Deano's East row into canonical Deano's (id 38, 9747 E 21st St N #101)
UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'deanos')
WHERE restaurant_id = (SELECT id FROM restaurants WHERE slug = 'deanos-tapworks-east')
  AND EXISTS (SELECT 1 FROM restaurants WHERE slug = 'deanos');

UPDATE ratings
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'deanos')
WHERE restaurant_id = (SELECT id FROM restaurants WHERE slug = 'deanos-tapworks-east')
  AND EXISTS (SELECT 1 FROM restaurants WHERE slug = 'deanos');

UPDATE noon_votes
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'deanos')
WHERE restaurant_id = (SELECT id FROM restaurants WHERE slug = 'deanos-tapworks-east')
  AND EXISTS (SELECT 1 FROM restaurants WHERE slug = 'deanos');

DELETE FROM restaurants
WHERE slug = 'deanos-tapworks-east'
  AND EXISTS (SELECT 1 FROM restaurants WHERE slug = 'deanos');

-- Defensive cleanup: ensure no restaurant retains a future last_visited date ahead of completed dinners
UPDATE restaurants
SET visit_count = (
      SELECT COUNT(*) FROM dinners d
      WHERE d.restaurant_id = restaurants.id AND d.status = 'completed'
    ),
    last_visited = (
      SELECT MAX(d.dinner_date) FROM dinners d
      WHERE d.restaurant_id = restaurants.id AND d.status = 'completed'
    )
WHERE last_visited IS NOT NULL
  AND last_visited > COALESCE((SELECT MAX(dinner_date) FROM dinners WHERE status = 'completed'), date('now'));
