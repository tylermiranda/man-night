-- Fix Man Night historical dinners incorrectly attributed to Pour Haus Restaurant & Tavern

-- 1. Reassign mistakenly matched dinners to their actual venues
UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'chipotle-mexican')
WHERE week_key = '2012-W34';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'n-j-bakery')
WHERE week_key = '2013-W09';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'ajs')
WHERE week_key = '2013-W34';

UPDATE dinners
SET restaurant_id = NULL
WHERE week_key = '2014-W05';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'public-at-brickyard')
WHERE week_key = '2014-W10';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'molinos-cuisine-midtown')
WHERE week_key IN ('2016-W18', '2017-W04', '2017-W28');

UPDATE dinners
SET restaurant_id = NULL
WHERE week_key = '2016-W51';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'knollas-pizza')
WHERE week_key IN ('2017-W37', '2018-W17', '2018-W51', '2019-W26', '2020-W03');

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'the-anchor')
WHERE week_key = '2017-W43';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'po-boy')
WHERE week_key = '2018-W01';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'buffalo-wings-and-rings')
WHERE week_key = '2018-W31';

UPDATE dinners
SET restaurant_id = NULL
WHERE week_key = '2018-W38';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'barnrds-roast-beef')
WHERE week_key = '2019-W10';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'picassos-pizzeria')
WHERE week_key = '2019-W20';

UPDATE dinners
SET restaurant_id = NULL
WHERE week_key IN ('2020-W25', '2021-W11', '2021-W36', '2021-W41', '2022-W26');

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'bionic-burger')
WHERE week_key = '2020-W30';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'el-agave')
WHERE week_key = '2020-W53';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'felipes')
WHERE week_key = '2021-W47';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'maple-street-pizza-company')
WHERE week_key = '2022-W41';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'side-pockets')
WHERE week_key = '2023-W30';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'oasis-lounge')
WHERE week_key = '2024-W30';

UPDATE dinners
SET restaurant_id = (SELECT id FROM restaurants WHERE slug = 'taco-fajita')
WHERE week_key = '2025-W40';

-- 2. Clean up Pour Haus Restaurant & Tavern slug, visit_count, and last_visited
UPDATE restaurants
SET slug = 'pour-haus-restaurant-tavern',
    visit_count = (SELECT COUNT(*) FROM dinners WHERE restaurant_id = restaurants.id AND status = 'completed'),
    last_visited = (SELECT MAX(dinner_date) FROM dinners WHERE restaurant_id = restaurants.id AND status = 'completed')
WHERE name = 'Pour Haus Restaurant & Tavern';

-- 3. Update visit counts and last_visited for all restaurants that gained completed visits
UPDATE restaurants
SET visit_count = (
      SELECT COUNT(*) FROM dinners d
      WHERE d.restaurant_id = restaurants.id AND d.status = 'completed'
    ),
    last_visited = (
      SELECT MAX(d.dinner_date) FROM dinners d
      WHERE d.restaurant_id = restaurants.id AND d.status = 'completed'
    )
WHERE id IN (
  SELECT DISTINCT restaurant_id FROM dinners WHERE week_key IN (
    '2012-W34', '2013-W09', '2013-W34', '2014-W10', '2016-W18', '2017-W04', '2017-W28',
    '2017-W37', '2017-W43', '2018-W01', '2018-W17', '2018-W31', '2018-W51', '2019-W10',
    '2019-W20', '2019-W26', '2020-W03', '2020-W30', '2020-W53', '2021-W47', '2022-W41',
    '2023-W30', '2024-W30', '2025-W40'
  ) AND restaurant_id IS NOT NULL
);
