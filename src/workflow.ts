import { buildWhatsNewPayload } from './changelog';
import { buildDirectionsUrl, syncLockedPlaceToCalendar } from './gcal';
import { sendWebPushToSubscribers } from './push';
import type {
  AllowedPhotoMime,
  BeerListPayload,
  BeerStats,
  BeerViewRow,
  DinnerRow,
  Env,
  HostFavoritePlace,
  HostStatRow,
  LuckyPool,
  MealPhotoViewRow,
  NightVoteViewRow,
  PlacePriceStats,
  PlaceVisitPrice,
  RatingViewRow,
  RestaurantRow,
  SelloutLogRow,
  SelloutStatRow,
  TrackableDinnerRow,
  UserRow,
} from './types';

async function recalcRestaurantAvgRating(db: D1Database, restaurantId: number | null): Promise<void> {
  if (!restaurantId) return;
  await db
    .prepare(
      `UPDATE restaurants
       SET avg_rating = (SELECT ROUND(AVG(score), 2) FROM ratings WHERE restaurant_id = ?)
       WHERE id = ?`,
    )
    .bind(restaurantId, restaurantId)
    .run();
}

function pickRandomIndex(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

export function shuffleRandom<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = pickRandomIndex(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function formatShortDate(isoDate: string): string {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export async function isFutureDinner(
  db: D1Database,
  dinner: { id: number; dinner_date: string },
  timeZone = 'America/Chicago',
): Promise<boolean> {
  const active = await getActiveDinner(db);
  if (active) {
    return dinner.id !== active.id && dinner.dinner_date >= active.dinner_date;
  }
  const todayStr = getCentralDateStr(new Date(), timeZone);
  return dinner.dinner_date > todayStr;
}

export function getCentralDateStr(now = new Date(), timeZone = 'America/Chicago'): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

export function safeRestaurantSelectSql(alias = 'r'): string {
  return `${alias}.id, ${alias}.slug, ${alias}.name, ${alias}.address, ${alias}.city, ${alias}.lat, ${alias}.lng, ${alias}.google_place_id,
         CASE
           WHEN ${alias}.last_visited IS NOT NULL AND ${alias}.last_visited > ?
           THEN (SELECT COUNT(*) FROM dinners d WHERE d.restaurant_id = ${alias}.id AND d.status = 'completed' AND d.dinner_date <= ?)
           ELSE ${alias}.visit_count
         END AS visit_count,
         CASE
           WHEN ${alias}.last_visited IS NOT NULL AND ${alias}.last_visited > ?
           THEN (SELECT MAX(d.dinner_date) FROM dinners d WHERE d.restaurant_id = ${alias}.id AND d.status = 'completed' AND d.dinner_date <= ?)
           ELSE ${alias}.last_visited
         END AS last_visited,
         ${alias}.avg_rating, ${alias}.created_at`;
}

export function isoWeekKey(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'place';
}

export async function getActiveDinner(db: D1Database): Promise<DinnerRow | null> {
  const next = await db
    .prepare(
      `SELECT * FROM dinners
       WHERE is_historical = 0 AND status != 'completed'
       ORDER BY dinner_date ASC
       LIMIT 1`,
    )
    .first<DinnerRow>();
  if (next) return next;

  return db
    .prepare(
      `SELECT * FROM dinners
       WHERE is_historical = 0
       ORDER BY dinner_date DESC
       LIMIT 1`,
    )
    .first<DinnerRow>();
}

/**
 * Draws 4 random places from club history, skipping any venue visited in the last 8 weeks (56 days).
 */
export async function drawFourRandomPlaces(db: D1Database, referenceDate: string): Promise<RestaurantRow[]> {
  const cutoffDate = addDaysToIsoDate(referenceDate, -56);
  const candidates = await db
    .prepare(
      `SELECT r.* FROM restaurants r
       WHERE r.visit_count >= 1
         AND (r.last_visited IS NULL OR r.last_visited < ?)
         AND NOT EXISTS (
           SELECT 1 FROM dinners d
           WHERE d.restaurant_id = r.id
             AND d.dinner_date >= ?
             AND d.dinner_date < ?
         )
       ORDER BY r.visit_count DESC, r.id ASC`,
    )
    .bind(cutoffDate, cutoffDate, referenceDate)
    .all<RestaurantRow>();

  const rows = candidates.results ?? [];
  if (rows.length >= 4) {
    return shuffleRandom(rows).slice(0, 4);
  }

  // Fallback only if fewer than 4 venues exist outside 8-week cooldown
  const allRows = await db.prepare('SELECT * FROM restaurants ORDER BY id ASC').all<RestaurantRow>();
  return shuffleRandom(allRows.results ?? []).slice(0, 4);
}

/**
 * Draws 1–6 random places for "I'm Feeling Lucky" (single pick or poll shortlist),
 * respecting the 8-week cooldown, avoiding spots already scheduled in the next 8 weeks,
 * and prioritizing non-excluded venues when re-rolling.
 */
export async function drawLuckyPlaces(
  db: D1Database,
  options: {
    dinnerId?: number | null;
    referenceDate: string;
    todayStr: string;
    count: number;
    pool?: LuckyPool;
    excludeIds?: number[];
  },
): Promise<{
  places: RestaurantRow[];
  poolRequested: LuckyPool;
  poolUsed: LuckyPool | 'fallback_any' | 'fallback_all';
  eligibleCount: number;
}> {
  const cutoff56 = addDaysToIsoDate(options.referenceDate, -56);
  const futureCutoff56 = addDaysToIsoDate(options.referenceDate, 56);
  const comebackCutoff = addDaysToIsoDate(options.referenceDate, -730);

  type LuckyQueryRow = RestaurantRow & { in_recent_window: number };
  const rawRows = (
    await db
      .prepare(
        `SELECT ${safeRestaurantSelectSql('r')},
                (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count,
                EXISTS (
                  SELECT 1 FROM dinners d
                  WHERE d.restaurant_id = r.id
                    AND d.id != ?
                    AND d.dinner_date >= ?
                    AND d.dinner_date <= ?
                ) AS in_recent_window
         FROM restaurants r
         ORDER BY visit_count DESC, r.id ASC`,
      )
      .bind(
        options.todayStr,
        options.todayStr,
        options.todayStr,
        options.todayStr,
        options.dinnerId ?? -1,
        cutoff56,
        futureCutoff56,
      )
      .all<LuckyQueryRow>()
  ).results ?? [];

  const allCleanRows: RestaurantRow[] = [];
  const cooldownEligible: RestaurantRow[] = [];
  for (const row of rawRows) {
    const { in_recent_window, ...clean } = row;
    allCleanRows.push(clean);
    const isCooldownEligible = (!clean.last_visited || clean.last_visited < cutoff56) && !in_recent_window;
    if (isCooldownEligible) {
      cooldownEligible.push(clean);
    }
  }

  const poolRequested: LuckyPool = options.pool || 'any';
  let primaryPool: RestaurantRow[];
  if (poolRequested === 'regulars') {
    primaryPool = cooldownEligible.filter((r) => (r.visit_count || 0) >= 5);
  } else if (poolRequested === 'comeback') {
    primaryPool = cooldownEligible.filter(
      (r) => (r.visit_count || 0) >= 3 && Boolean(r.last_visited && r.last_visited <= comebackCutoff),
    );
  } else if (poolRequested === 'top_rated') {
    primaryPool = cooldownEligible.filter((r) => r.avg_rating !== null && Number(r.avg_rating) >= 4);
  } else {
    primaryPool = cooldownEligible;
  }

  const eligibleCount = primaryPool.length;
  const targetCount = Math.max(1, Math.min(6, Math.trunc(options.count)));
  const excludeSet = new Set(
    (options.excludeIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0),
  );
  const selected: RestaurantRow[] = [];
  const chosenIds = new Set<number>();

  const appendFrom = (poolRows: RestaurantRow[]) => {
    if (selected.length >= targetCount) return;
    const fresh = shuffleRandom(poolRows.filter((r) => !chosenIds.has(r.id) && !excludeSet.has(r.id)));
    for (const r of fresh) {
      if (selected.length >= targetCount) break;
      chosenIds.add(r.id);
      selected.push(r);
    }
    if (selected.length < targetCount) {
      const wrapped = shuffleRandom(poolRows.filter((r) => !chosenIds.has(r.id)));
      for (const r of wrapped) {
        if (selected.length >= targetCount) break;
        chosenIds.add(r.id);
        selected.push(r);
      }
    }
  };

  appendFrom(primaryPool);
  let poolUsed: LuckyPool | 'fallback_any' | 'fallback_all' = poolRequested;
  if (selected.length < targetCount) {
    poolUsed = 'fallback_any';
    appendFrom(cooldownEligible);
  }
  if (selected.length < targetCount) {
    poolUsed = 'fallback_all';
    appendFrom(allCleanRows);
  }

  return {
    places: selected,
    poolRequested,
    poolUsed,
    eligibleCount,
  };
}

export async function getNightVotesForDinner(db: D1Database, dinnerId: number): Promise<NightVoteViewRow[]> {
  const rows = await db
    .prepare(
      `SELECT nv.user_slug, u.name AS user_name, nv.choice, nv.reason, nv.voted_at
       FROM night_votes nv
       LEFT JOIN users u ON u.slug = nv.user_slug
       WHERE nv.dinner_id = ?
       ORDER BY nv.voted_at ASC, nv.id ASC`,
    )
    .bind(dinnerId)
    .all<NightVoteViewRow>();
  return rows.results ?? [];
}

export async function castNightVote(
  db: D1Database,
  dinnerId: number,
  userSlug: string,
  choice: 'tuesday' | 'wednesday',
  reason?: string,
): Promise<{
  tuesday: number;
  wednesday: number;
  userChoice: 'tuesday' | 'wednesday';
  reason: string;
  nightVotes: NightVoteViewRow[];
}> {
  const hasReason = typeof reason === 'string';
  const cleanReason = hasReason ? reason.trim().slice(0, 200) : '';

  await db
    .prepare(
      `INSERT INTO night_votes (dinner_id, user_slug, choice, reason, voted_at)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(dinner_id, user_slug)
       DO UPDATE SET
         choice = excluded.choice,
         reason = CASE WHEN ? = 1 THEN excluded.reason ELSE night_votes.reason END,
         voted_at = datetime('now')`,
    )
    .bind(dinnerId, userSlug, choice, cleanReason, hasReason ? 1 : 0)
    .run();

  const nightVotes = await getNightVotesForDinner(db, dinnerId);

  let tuesday = 0;
  let wednesday = 0;
  let savedReason = '';
  for (const row of nightVotes) {
    if (row.choice === 'tuesday') tuesday += 1;
    if (row.choice === 'wednesday') wednesday += 1;
    if (row.user_slug === userSlug) savedReason = row.reason || '';
  }
  return { tuesday, wednesday, userChoice: choice, reason: savedReason, nightVotes };
}

function parseIdListJson(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

async function syncRatingsForDinnerPlace(
  db: D1Database,
  dinnerId: number,
  newRestaurantId: number,
  prevRestaurantId: number | null,
): Promise<void> {
  await db.prepare('UPDATE ratings SET restaurant_id = ? WHERE dinner_id = ?')
    .bind(newRestaurantId, dinnerId)
    .run();
  await db.prepare('UPDATE meal_photos SET restaurant_id = ? WHERE dinner_id = ?')
    .bind(newRestaurantId, dinnerId)
    .run();
  await recalcRestaurantAvgRating(db, newRestaurantId);
  if (prevRestaurantId && prevRestaurantId !== newRestaurantId) {
    await recalcRestaurantAvgRating(db, prevRestaurantId);
  }
}

/**
 * Locks the dinner night. Tuesday wins ties per Man Night rules.
 */
export async function lockNight(env: Env, dinnerId: number): Promise<DinnerRow | null> {
  const dinner = await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!dinner) return null;

  const votes = await env.DB.prepare(
    'SELECT choice, COUNT(*) AS cnt FROM night_votes WHERE dinner_id = ? GROUP BY choice',
  )
    .bind(dinnerId)
    .all<{ choice: string; cnt: number }>();

  let tue = 0;
  let wed = 0;
  for (const row of votes.results ?? []) {
    if (row.choice === 'tuesday') tue = Number(row.cnt);
    if (row.choice === 'wednesday') wed = Number(row.cnt);
  }

  const winningDay: 'Tuesday' | 'Wednesday' = tue >= wed ? 'Tuesday' : 'Wednesday';
  let newDate = dinner.dinner_date;
  if (dinner.day_of_week === 'Tuesday' && winningDay === 'Wednesday') {
    newDate = addDaysToIsoDate(dinner.dinner_date, 1);
  } else if (dinner.day_of_week === 'Wednesday' && winningDay === 'Tuesday') {
    newDate = addDaysToIsoDate(dinner.dinner_date, -1);
  }

  const existingPollIds = parseIdListJson(dinner.noon_draw_ids);
  const nextStatus = dinner.restaurant_id
    ? 'place_locked'
    : existingPollIds.length >= 2
      ? 'noon_vote'
      : 'awaiting_pick';

  await env.DB.prepare(
    `UPDATE dinners
     SET day_of_week = ?,
         dinner_date = ?,
         week_key = ?,
         status = ?,
         night_locked_at = COALESCE(night_locked_at, datetime('now')),
         updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(winningDay, newDate, isoWeekKey(newDate), nextStatus, dinnerId)
    .run();

  const updated = await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  let lockedPlace: RestaurantRow | null = null;
  if (updated && updated.restaurant_id) {
    lockedPlace = await env.DB.prepare('SELECT * FROM restaurants WHERE id = ?')
      .bind(updated.restaurant_id)
      .first<RestaurantRow>();
    if (lockedPlace) {
      const cal = await syncLockedPlaceToCalendar(
        env,
        updated,
        lockedPlace,
        `Night vote locked (${winningDay} ${newDate}); place picked in advance by ${updated.host_label}.`,
      );
      if (cal.eventId) {
        await env.DB.prepare('UPDATE dinners SET gcal_event_id = ? WHERE id = ?').bind(cal.eventId, dinnerId).run();
      }
    }
  }

  const pushBody = lockedPlace
    ? `${updated?.host_label} picked ${lockedPlace.name} · ${winningDay} ${updated?.start_time}`
    : nextStatus === 'noon_vote'
      ? `Vote on ${updated?.host_label}'s place poll for ${winningDay} ${updated?.start_time}`
      : `Waiting on ${updated?.host_label} to pick by noon on ${winningDay}`;

  await sendWebPushToSubscribers(
    env,
    {
      title: `Night locked: ${winningDay}`,
      body: pushBody,
      tag: `night-lock-${dinnerId}`,
      url: lockedPlace ? buildDirectionsUrl(lockedPlace) : env.APP_URL,
      dinnerId,
    },
    'notify_night_vote',
  );

  return env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
}

export async function lockPlace(
  env: Env,
  dinnerId: number,
  restaurantId: number,
  chosenVia: 'picker' | 'noon_draw' | 'host_poll',
  voteSummary = '',
  dayChoice?: 'Tuesday' | 'Wednesday',
  options?: { keepNightVote?: boolean },
): Promise<{ dinner: DinnerRow; restaurant: RestaurantRow; calendar: { synced: boolean; reason?: string } }> {
  const existing = await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!existing) throw new Error('Dinner not found');

  const restaurant = await env.DB.prepare('SELECT * FROM restaurants WHERE id = ?')
    .bind(restaurantId)
    .first<RestaurantRow>();
  if (!restaurant) throw new Error('Restaurant not found');

  const nightNotLockedYet =
    !existing.night_locked_at && (existing.status === 'scheduled' || existing.status === 'night_poll');
  const shouldKeepNightVote =
    nightNotLockedYet && (options?.keepNightVote === true || (options?.keepNightVote === undefined && !dayChoice));

  if (shouldKeepNightVote) {
    if (chosenVia === 'picker') {
      await env.DB.prepare(
        `UPDATE dinners
         SET restaurant_id = ?,
             raw_location = ?,
             chosen_via = ?,
             noon_draw_ids = NULL,
             noon_draw_opened_at = NULL,
             place_locked_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ?`,
      )
        .bind(restaurant.id, restaurant.address || restaurant.name, chosenVia, dinnerId)
        .run();
      await env.DB.prepare('DELETE FROM noon_votes WHERE dinner_id = ?').bind(dinnerId).run();
    } else {
      await env.DB.prepare(
        `UPDATE dinners
         SET restaurant_id = ?,
             raw_location = ?,
             chosen_via = ?,
             place_locked_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ?`,
      )
        .bind(restaurant.id, restaurant.address || restaurant.name, chosenVia, dinnerId)
        .run();
    }

    await syncRatingsForDinnerPlace(env.DB, dinnerId, restaurant.id, existing.restaurant_id);

    const updatedRestaurant = (await env.DB.prepare('SELECT * FROM restaurants WHERE id = ?')
      .bind(restaurant.id)
      .first<RestaurantRow>())!;
    const updated = (await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>())!;

    const isFuture = await isFutureDinner(env.DB, updated, env.CLUB_TIMEZONE);
    const dateLabel = formatShortDate(updated.dinner_date);
    const dayDateLabel = `${updated.day_of_week}, ${dateLabel}`;

    const pushTitle = isFuture
      ? `${updated.host_label} picked ${updatedRestaurant.name} (${dateLabel})`
      : `${updated.host_label} picked ${updatedRestaurant.name}`;
    const pushBody = isFuture
      ? `Spot set in advance for ${dayDateLabel}! Tue/Wed night vote stays open.`
      : 'Spot is set! Vote Tuesday or Wednesday before Monday noon.';

    await sendWebPushToSubscribers(
      env,
      {
        title: pushTitle,
        body: pushBody,
        tag: `place-pick-${dinnerId}`,
        url: env.APP_URL,
        dinnerId,
      },
      'notify_place',
    );

    return { dinner: updated, restaurant: updatedRestaurant, calendar: { synced: false, reason: 'awaiting_night_vote' } };
  }

  const targetDay: 'Tuesday' | 'Wednesday' =
    dayChoice === 'Tuesday' || dayChoice === 'Wednesday'
      ? dayChoice
      : existing.day_of_week === 'Wednesday'
        ? 'Wednesday'
        : 'Tuesday';

  let newDate = existing.dinner_date;
  if (existing.day_of_week === 'Tuesday' && targetDay === 'Wednesday') {
    newDate = addDaysToIsoDate(existing.dinner_date, 1);
  } else if (existing.day_of_week === 'Wednesday' && targetDay === 'Tuesday') {
    newDate = addDaysToIsoDate(existing.dinner_date, -1);
  }
  const newWeekKey = isoWeekKey(newDate);
  const wasEarlyAdvanceLock = existing.status === 'scheduled' || existing.status === 'night_poll';

  if (chosenVia === 'picker') {
    await env.DB.prepare(
      `UPDATE dinners
       SET restaurant_id = ?,
           raw_location = ?,
           day_of_week = ?,
           dinner_date = ?,
           week_key = ?,
           status = 'place_locked',
           chosen_via = ?,
           noon_draw_ids = NULL,
           noon_draw_opened_at = NULL,
           night_locked_at = COALESCE(night_locked_at, datetime('now')),
           place_locked_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(restaurant.id, restaurant.address || restaurant.name, targetDay, newDate, newWeekKey, chosenVia, dinnerId)
      .run();
    await env.DB.prepare('DELETE FROM noon_votes WHERE dinner_id = ?').bind(dinnerId).run();
  } else {
    await env.DB.prepare(
      `UPDATE dinners
       SET restaurant_id = ?,
           raw_location = ?,
           day_of_week = ?,
           dinner_date = ?,
           week_key = ?,
           status = 'place_locked',
           chosen_via = ?,
           night_locked_at = COALESCE(night_locked_at, datetime('now')),
           place_locked_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(restaurant.id, restaurant.address || restaurant.name, targetDay, newDate, newWeekKey, chosenVia, dinnerId)
      .run();
  }

  await syncRatingsForDinnerPlace(env.DB, dinnerId, restaurant.id, existing.restaurant_id);

  const updatedRestaurant = (await env.DB.prepare('SELECT * FROM restaurants WHERE id = ?')
    .bind(restaurant.id)
    .first<RestaurantRow>())!;
  const updated = (await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>())!;
  const note =
    voteSummary ||
    (chosenVia === 'noon_draw'
      ? `Locked by 4:00 PM noon-rule vote (${updated.day_of_week} ${updated.dinner_date}).`
      : chosenVia === 'host_poll'
        ? `Picked via ${updated.host_label}'s poll for ${updated.day_of_week} ${updated.dinner_date}.`
        : `Picked in advance by ${updated.host_label} for ${updated.day_of_week} ${updated.dinner_date} (no vote).`);

  const cal = await syncLockedPlaceToCalendar(env, updated, updatedRestaurant, note);
  if (cal.eventId) {
    await env.DB.prepare('UPDATE dinners SET gcal_event_id = ? WHERE id = ?').bind(cal.eventId, dinnerId).run();
  }

  const mapsUrl = buildDirectionsUrl(updatedRestaurant);
  const viaText =
    chosenVia === 'noon_draw'
      ? 'Noon draw result'
      : chosenVia === 'host_poll'
        ? `Picked via ${updated.host_label}'s poll`
        : `Picked by ${updated.host_label}`;

  const isFuture = await isFutureDinner(env.DB, updated, env.CLUB_TIMEZONE);
  const dateLabel = formatShortDate(updated.dinner_date);
  const dayDateLabel = `${updated.day_of_week}, ${dateLabel}`;

  const pushTitle = isFuture
    ? `Place locked: ${updatedRestaurant.name} (${dateLabel})`
    : `Place locked: ${updatedRestaurant.name}`;

  const pushBody = isFuture
    ? `${updated.host_label} locked ${updatedRestaurant.name} in advance for ${dayDateLabel} — no vote needed`
    : wasEarlyAdvanceLock
      ? `${updated.host_label} picked ${updatedRestaurant.name} for ${updated.day_of_week} (${dateLabel}) — no vote needed`
      : `${updated.day_of_week} 6:30 PM · ${viaText}`;

  await sendWebPushToSubscribers(
    env,
    {
      title: pushTitle,
      body: pushBody,
      tag: `place-lock-${dinnerId}`,
      url: mapsUrl,
      actions: [
        { action: 'directions', title: 'Directions' },
        { action: 'late', title: 'Running late' },
      ],
      dinnerId,
    },
    'notify_place',
  );

  return { dinner: updated, restaurant: updatedRestaurant, calendar: { synced: cal.synced, reason: cal.reason } };
}

export async function createPlacePoll(
  env: Env,
  dinnerId: number,
  restaurantIds: number[],
  options?: { keepNightVote?: boolean; dayChoice?: 'Tuesday' | 'Wednesday' },
): Promise<{ dinner: DinnerRow; candidates: RestaurantRow[] }> {
  const existing = await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!existing) throw new Error('Dinner not found');
  if (existing.status === 'completed') throw new Error('Completed dinner cannot open a poll');

  const seen = new Set<number>();
  const uniqueIds: number[] = [];
  for (const rawId of restaurantIds) {
    const id = Number(rawId);
    if (Number.isInteger(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      uniqueIds.push(id);
    }
  }
  if (uniqueIds.length < 2 || uniqueIds.length > 6) {
    throw new Error('Select between 2 and 6 places for a poll');
  }

  const rows = (
    await env.DB.prepare(
      `SELECT r.*,
              (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count
       FROM restaurants r
       WHERE r.id IN (${uniqueIds.map(() => '?').join(',')})`,
    )
      .bind(...uniqueIds)
      .all<RestaurantRow>()
  ).results ?? [];

  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  const candidates = uniqueIds.map((id) => byId.get(id)).filter((r): r is RestaurantRow => Boolean(r));
  if (candidates.length < 2) {
    throw new Error('Select at least 2 valid restaurants');
  }

  const candIds = candidates.map((c) => Number(c.id));
  const drawIdsJson = JSON.stringify(candIds);

  const nightNotLockedYet =
    !existing.night_locked_at && (existing.status === 'scheduled' || existing.status === 'night_poll');
  const shouldKeepNightVote = nightNotLockedYet && options?.keepNightVote !== false;

  if (shouldKeepNightVote) {
    await env.DB.prepare(
      `UPDATE dinners
       SET restaurant_id = NULL,
           raw_location = '',
           place_locked_at = NULL,
           chosen_via = 'host_poll',
           noon_draw_ids = ?,
           noon_draw_opened_at = COALESCE(noon_draw_opened_at, datetime('now')),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(drawIdsJson, dinnerId)
      .run();
  } else {
    const targetDay: 'Tuesday' | 'Wednesday' =
      options?.dayChoice === 'Tuesday' || options?.dayChoice === 'Wednesday'
        ? options.dayChoice
        : existing.day_of_week === 'Wednesday'
          ? 'Wednesday'
          : 'Tuesday';
    let newDate = existing.dinner_date;
    if (existing.day_of_week === 'Tuesday' && targetDay === 'Wednesday') {
      newDate = addDaysToIsoDate(existing.dinner_date, 1);
    } else if (existing.day_of_week === 'Wednesday' && targetDay === 'Tuesday') {
      newDate = addDaysToIsoDate(existing.dinner_date, -1);
    }
    await env.DB.prepare(
      `UPDATE dinners
       SET restaurant_id = NULL,
           raw_location = '',
           place_locked_at = NULL,
           day_of_week = ?,
           dinner_date = ?,
           week_key = ?,
           status = 'noon_vote',
           chosen_via = 'host_poll',
           noon_draw_ids = ?,
           noon_draw_opened_at = COALESCE(noon_draw_opened_at, datetime('now')),
           night_locked_at = COALESCE(night_locked_at, datetime('now')),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
      .bind(targetDay, newDate, isoWeekKey(newDate), drawIdsJson, dinnerId)
      .run();
  }

  await env.DB.prepare('UPDATE meal_photos SET restaurant_id = NULL WHERE dinner_id = ?').bind(dinnerId).run();

  await env.DB.prepare(
    `DELETE FROM noon_votes WHERE dinner_id = ? AND restaurant_id NOT IN (${candIds.map(() => '?').join(',')})`,
  )
    .bind(dinnerId, ...candIds)
    .run();

  const updated = (await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>())!;
  const isFuture = await isFutureDinner(env.DB, updated, env.CLUB_TIMEZONE);
  const dateLabel = formatShortDate(updated.dinner_date);
  const dayDateLabel = `${updated.day_of_week}, ${dateLabel}`;

  const pushTitle = isFuture
    ? `${updated.host_label} opened a place poll (${dateLabel})`
    : `${updated.host_label} opened a place poll`;

  const pushBody = isFuture
    ? `${candidates.map((c) => c.name).join(', ')}${shouldKeepNightVote ? ` · Vote in advance for ${dayDateLabel}` : ` · For ${dayDateLabel} (no night vote)`}`
    : `${candidates.map((c) => c.name).join(', ')}${shouldKeepNightVote ? ' · Vote on place & Tue/Wed' : ` · For ${updated.day_of_week}`}`;

  await sendWebPushToSubscribers(
    env,
    {
      title: pushTitle,
      body: pushBody,
      tag: `host-poll-${dinnerId}`,
      url: env.APP_URL,
      dinnerId,
    },
    'notify_place',
  );

  return { dinner: updated, candidates };
}

export async function openNoonDraw(env: Env, dinnerId: number): Promise<{ dinner: DinnerRow; candidates: RestaurantRow[] }> {
  const dinner = await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!dinner) throw new Error('Dinner not found');

  const candidates = await drawFourRandomPlaces(env.DB, dinner.dinner_date);
  const drawIds = JSON.stringify(candidates.map((c) => c.id));

  await env.DB.prepare(
    `UPDATE dinners
     SET status = 'noon_vote',
         chosen_via = 'noon_draw',
         noon_draw_ids = ?,
         noon_draw_opened_at = datetime('now'),
         updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(drawIds, dinnerId)
    .run();

  const updated = (await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>())!;
  await sendWebPushToSubscribers(
    env,
    {
      title: `${dinner.host_label} didn't pick — vote on 4 places`,
      body: `${candidates.map((c) => c.name).join(', ')} · Closes 4:00 PM`,
      tag: `noon-draw-${dinnerId}`,
      url: env.APP_URL,
      dinnerId,
    },
    'notify_place',
  );

  return { dinner: updated, candidates };
}

export async function castNoonVote(
  db: D1Database,
  dinnerId: number,
  userSlug: string,
  restaurantId: number,
): Promise<Array<{ restaurant_id: number; count: number }>> {
  const dinner = await db.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!dinner || dinner.status === 'completed' || dinner.status === 'place_locked' || dinner.restaurant_id) {
    throw new Error('Place poll is not open');
  }

  const drawIds = parseIdListJson(dinner.noon_draw_ids);
  if (drawIds.length === 0) throw new Error('Place poll is not open');
  if (!drawIds.includes(restaurantId)) throw new Error('Restaurant is not in this week’s poll');

  await db
    .prepare(
      `INSERT INTO noon_votes (dinner_id, user_slug, restaurant_id, voted_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(dinner_id, user_slug)
       DO UPDATE SET restaurant_id = excluded.restaurant_id, voted_at = datetime('now')`,
    )
    .bind(dinnerId, userSlug, restaurantId)
    .run();

  const tallies = await db
    .prepare('SELECT restaurant_id, COUNT(*) AS count FROM noon_votes WHERE dinner_id = ? GROUP BY restaurant_id')
    .bind(dinnerId)
    .all<{ restaurant_id: number; count: number }>();

  return (tallies.results ?? []).map((r) => ({ restaurant_id: Number(r.restaurant_id), count: Number(r.count) }));
}

export async function closeNoonVote(env: Env, dinnerId: number) {
  const dinner = await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!dinner) throw new Error('Dinner not found');

  const drawIds = parseIdListJson(dinner.noon_draw_ids);
  if (drawIds.length === 0) throw new Error('No candidates drawn for poll');

  const tallies = await env.DB.prepare(
    'SELECT restaurant_id, COUNT(*) AS count FROM noon_votes WHERE dinner_id = ? GROUP BY restaurant_id',
  )
    .bind(dinnerId)
    .all<{ restaurant_id: number; count: number }>();

  const scoreMap = new Map<number, number>(drawIds.map((id) => [id, 0]));
  for (const row of tallies.results ?? []) {
    if (scoreMap.has(Number(row.restaurant_id))) {
      scoreMap.set(Number(row.restaurant_id), Number(row.count));
    }
  }

  const maxVotes = Math.max(...scoreMap.values());
  const tiedTop = [...scoreMap.entries()].filter(([, cnt]) => cnt === maxVotes).map(([id]) => id);
  const winnerId = tiedTop[pickRandomIndex(tiedTop.length)];

  const isHostPoll = dinner.chosen_via === 'host_poll';
  const label = isHostPoll ? 'Place poll' : 'Noon vote';
  const summary =
    tiedTop.length > 1
      ? `${label} tied (${maxVotes} votes each); random tiebreak selected winner.`
      : `${label} won with ${maxVotes} vote(s).`;

  const keepNightVote = !dinner.night_locked_at && (dinner.status === 'night_poll' || dinner.status === 'scheduled');
  return lockPlace(env, dinnerId, winnerId, isHostPoll ? 'host_poll' : 'noon_draw', summary, undefined, {
    keepNightVote,
  });
}

export async function completeDinner(db: D1Database, dinnerId: number): Promise<void> {
  const dinner = await db.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!dinner || dinner.status === 'completed') return;

  await db
    .prepare(
      `UPDATE dinners
       SET status = 'completed',
           completed_at = datetime('now'),
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(dinnerId)
    .run();

  if (dinner.restaurant_id) {
    await db
      .prepare(
        `UPDATE restaurants
         SET visit_count = visit_count + 1,
             last_visited = CASE
               WHEN last_visited IS NULL OR last_visited < ? THEN ?
               ELSE last_visited
             END
         WHERE id = ?`,
      )
      .bind(dinner.dinner_date, dinner.dinner_date, dinner.restaurant_id)
      .run();
  }
}

export async function ensureNextScheduledDinner(db: D1Database): Promise<void> {
  const latest = await db
    .prepare('SELECT * FROM dinners ORDER BY dinner_date DESC LIMIT 1')
    .first<DinnerRow>();
  const activeRot = await db
    .prepare('SELECT * FROM users WHERE is_rotation = 1 ORDER BY rotation_order ASC')
    .all<UserRow>();
  const rotation = activeRot.results ?? [];
  if (!latest || rotation.length === 0) return;

  const upcomingCountRow = await db
    .prepare("SELECT COUNT(*) AS cnt FROM dinners WHERE is_historical = 0 AND status != 'completed'")
    .first<{ cnt: number }>();
  if (Number(upcomingCountRow?.cnt ?? 0) >= 3) return;

  const nextDate = addDaysToIsoDate(latest.dinner_date, 7);
  const lastIdx = rotation.findIndex((u) => u.slug === latest.host_slug);
  const nextHost = rotation[(lastIdx >= 0 ? lastIdx + 1 : 0) % rotation.length];

  await db
    .prepare(
      `INSERT OR IGNORE INTO dinners
       (week_key, dinner_date, start_time, day_of_week, host_slug, host_label, raw_summary, status, chosen_via, is_historical)
       VALUES (?, ?, '18:30', 'Tuesday', ?, ?, ?, 'scheduled', 'pending', 0)`,
    )
    .bind(isoWeekKey(nextDate), nextDate, nextHost.slug, nextHost.name, `Man Night @ ${nextHost.name}'s`)
    .run();
}

export async function computeDinnerHeadcount(db: D1Database, dinnerId: number) {
  const rsvpRows =
    (
      await db
        .prepare('SELECT user_slug, status, extra_guests FROM rsvps WHERE dinner_id = ?')
        .bind(dinnerId)
        .all<{ user_slug: string; status: string; extra_guests: number | null }>()
    ).results ?? [];

  const activeUsers =
    (
      await db
        .prepare("SELECT slug FROM users WHERE email NOT LIKE '%@history.local'")
        .all<{ slug: string }>()
    ).results ?? [];
  const activeSlugs = new Set(activeUsers.map((u) => u.slug));

  let goingMembers = 0;
  let lateMembers = 0;
  let outMembers = 0;
  let extraGuests = 0;
  const answeredActive = new Set<string>();

  for (const r of rsvpRows) {
    if (activeSlugs.has(r.user_slug)) {
      answeredActive.add(r.user_slug);
    }
    if (r.status === 'in' || r.status === 'late') {
      goingMembers++;
      if (r.status === 'late') lateMembers++;
      extraGuests += Math.max(0, Number(r.extra_guests) || 0);
    } else if (r.status === 'out') {
      outMembers++;
    }
  }

  return {
    goingMembers,
    lateMembers,
    outMembers,
    extraGuests,
    totalGoing: goingMembers + extraGuests,
    activeCrewCount: activeUsers.length,
    unansweredCount: Math.max(0, activeUsers.length - answeredActive.size),
  };
}

export async function castRsvp(
  db: D1Database,
  dinnerId: number,
  userSlug: string,
  status: 'in' | 'late' | 'out' | 'clear',
  etaMinutes: number | null,
  note?: string,
  recordedBy?: string,
  extraGuests?: number,
) {
  const dinner = await db.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!dinner) throw new Error('Dinner not found');
  if (dinner.is_historical === 1) {
    throw new Error('Attendance and sellout tracking started with the app and cannot be modified on pre-app historical dinners');
  }
  if (dinner.status === 'scheduled') {
    const active = await getActiveDinner(db);
    if (dinner.id !== active?.id) {
      throw new Error('Cannot log attendance or sellouts for future scheduled weeks yet');
    }
  }

  const targetUser = await db
    .prepare("SELECT slug FROM users WHERE slug = ? AND email NOT LIKE '%@history.local'")
    .bind(userSlug)
    .first<{ slug: string }>();
  if (!targetUser) throw new Error('Unknown club member');

  const actor = recordedBy || userSlug;

  if (status === 'clear') {
    await db.prepare('DELETE FROM rsvps WHERE dinner_id = ? AND user_slug = ?').bind(dinnerId, userSlug).run();
    return computeDinnerHeadcount(db, dinnerId);
  }

  if (status === 'out') {
    const hasNote = typeof note === 'string';
    const cleanNote = hasNote ? note.trim().slice(0, 140) : '';
    await db
      .prepare(
        `INSERT INTO rsvps (dinner_id, user_slug, status, eta_minutes, extra_guests, note, recorded_by, updated_at)
         VALUES (?, ?, 'out', NULL, 0, ?, ?, datetime('now'))
         ON CONFLICT(dinner_id, user_slug)
         DO UPDATE SET
           status = 'out',
           eta_minutes = NULL,
           extra_guests = 0,
           note = CASE WHEN ? = 1 THEN excluded.note ELSE CASE WHEN rsvps.status = 'out' THEN rsvps.note ELSE '' END END,
           recorded_by = excluded.recorded_by,
           updated_at = datetime('now')`,
      )
      .bind(dinnerId, userSlug, cleanNote, actor, hasNote ? 1 : 0)
      .run();
    return computeDinnerHeadcount(db, dinnerId);
  }

  const hasNote = typeof note === 'string';
  const cleanNote = hasNote ? note.trim().slice(0, 140) : '';
  const hasEta = typeof etaMinutes === 'number' && Number.isFinite(etaMinutes);
  const eta = status === 'late' ? (hasEta ? etaMinutes : 15) : null;
  const hasExtra = typeof extraGuests === 'number' && Number.isFinite(extraGuests);
  const cleanExtra = hasExtra ? Math.max(0, Math.min(20, Math.trunc(extraGuests))) : 0;

  await db
    .prepare(
      `INSERT INTO rsvps (dinner_id, user_slug, status, eta_minutes, extra_guests, note, recorded_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(dinner_id, user_slug)
       DO UPDATE SET
         status = excluded.status,
         eta_minutes = CASE WHEN excluded.status = 'late' THEN CASE WHEN ? = 1 THEN excluded.eta_minutes ELSE COALESCE(rsvps.eta_minutes, 15) END ELSE NULL END,
         extra_guests = CASE WHEN ? = 1 THEN excluded.extra_guests ELSE CASE WHEN rsvps.status = 'out' THEN 0 ELSE rsvps.extra_guests END END,
         note = CASE WHEN ? = 1 THEN excluded.note ELSE rsvps.note END,
         recorded_by = excluded.recorded_by,
         updated_at = datetime('now')`,
    )
    .bind(
      dinnerId,
      userSlug,
      status,
      eta,
      cleanExtra,
      cleanNote,
      actor,
      hasEta ? 1 : 0,
      hasExtra ? 1 : 0,
      hasNote ? 1 : 0,
    )
    .run();

  return computeDinnerHeadcount(db, dinnerId);
}

export function parseMealPrice(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const rawNum = typeof input === 'string'
    ? parseFloat(input.replace(/[^0-9.]/g, ''))
    : Number(input);
  if (isNaN(rawNum) || !isFinite(rawNum) || rawNum < 0 || rawNum > 10000) return null;
  return Math.round(rawNum * 100) / 100;
}

export async function submitRating(
  db: D1Database,
  dinnerId: number,
  userSlug: string,
  score: number,
  dish: string,
  comment: string,
  priceInput?: unknown,
  appetizerInput?: string,
) {
  const dinner = await db
    .prepare('SELECT id, restaurant_id FROM dinners WHERE id = ?')
    .bind(dinnerId)
    .first<{ id: number; restaurant_id: number | null }>();
  if (!dinner) throw new Error('Dinner not found');

  const cleanDish = dish.trim().slice(0, 140);
  const cleanAppetizer = (appetizerInput ?? '').trim().slice(0, 140);
  const cleanComment = comment.trim().slice(0, 500);
  const price = parseMealPrice(priceInput);

  await db
    .prepare(
      `INSERT INTO ratings (dinner_id, restaurant_id, user_slug, score, dish, appetizer, comment, price, rated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(dinner_id, user_slug)
       DO UPDATE SET restaurant_id = excluded.restaurant_id, score = excluded.score, dish = excluded.dish, appetizer = excluded.appetizer, comment = excluded.comment, price = excluded.price, rated_at = datetime('now')`,
    )
    .bind(dinnerId, dinner.restaurant_id ?? null, userSlug, score, cleanDish, cleanAppetizer, cleanComment, price)
    .run();

  await recalcRestaurantAvgRating(db, dinner.restaurant_id);

  return {
    dinner_id: dinnerId,
    restaurant_id: dinner.restaurant_id,
    score,
    dish: cleanDish,
    appetizer: cleanAppetizer,
    comment: cleanComment,
    price,
  };
}

export async function setDinnerMealPrice(
  db: D1Database,
  dinnerId: number,
  priceInput: unknown,
) {
  const price = parseMealPrice(priceInput);
  await db
    .prepare("UPDATE dinners SET meal_price = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(price, dinnerId)
    .run();
  return { dinner_id: dinnerId, meal_price: price };
}

export async function applyRotationOverride(
  db: D1Database,
  dinnerId: number,
  action: 'pass' | 'swap',
  targetSlug: string | null,
  actorSlug: string,
): Promise<DinnerRow> {
  const dinner = await db.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!dinner) throw new Error('Dinner not found');

  const rotUsers = (
    await db.prepare('SELECT * FROM users WHERE is_rotation = 1 ORDER BY rotation_order ASC').all<UserRow>()
  ).results ?? [];

  const fromSlug = dinner.host_slug || actorSlug;
  let toUser = targetSlug ? rotUsers.find((u) => u.slug === targetSlug) : undefined;
  if (!toUser) {
    const idx = rotUsers.findIndex((u) => u.slug === fromSlug);
    toUser = rotUsers[(idx >= 0 ? idx + 1 : 0) % rotUsers.length];
  }

  if (action === 'swap') {
    const futureTarget = await db
      .prepare(
        `SELECT * FROM dinners
         WHERE is_historical = 0 AND status = 'scheduled' AND dinner_date > ? AND host_slug = ?
         ORDER BY dinner_date ASC LIMIT 1`,
      )
      .bind(dinner.dinner_date, toUser.slug)
      .first<DinnerRow>();

    if (futureTarget) {
      const fromUser = rotUsers.find((u) => u.slug === fromSlug);
      await db
        .prepare("UPDATE dinners SET host_slug = ?, host_label = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(fromSlug, fromUser?.name ?? dinner.host_label, futureTarget.id)
        .run();
    }
  }

  await db
    .prepare("UPDATE dinners SET host_slug = ?, host_label = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(toUser.slug, toUser.name, dinner.id)
    .run();

  await db
    .prepare(
      'INSERT INTO rotation_overrides (dinner_id, action, from_slug, to_slug, actor_slug) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(dinner.id, action, fromSlug, toUser.slug, actorSlug)
    .run();

  return (await db.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinner.id).first<DinnerRow>())!;
}

export async function createRestaurant(
  db: D1Database,
  input: { name: string; address?: string; city?: string; lat?: number | null; lng?: number | null },
): Promise<RestaurantRow> {
  const cleanName = input.name.trim();
  if (!cleanName) throw new Error('Restaurant name required');

  const baseSlug = slugify(cleanName);
  const existing = await db.prepare('SELECT * FROM restaurants WHERE slug = ? LIMIT 1').bind(baseSlug).first<RestaurantRow>();
  if (existing) return existing;

  const res = await db
    .prepare(
      `INSERT INTO restaurants (slug, name, address, city, lat, lng, visit_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .bind(baseSlug, cleanName, (input.address || '').trim(), (input.city || 'Wichita').trim(), input.lat ?? null, input.lng ?? null)
    .run();

  const id = res.meta.last_row_id;
  return (await db.prepare('SELECT * FROM restaurants WHERE id = ?').bind(id).first<RestaurantRow>())!;
}

export async function backfillDinnerPlace(
  db: D1Database,
  dinnerId: number,
  restaurantId: number,
  timeZone = 'America/Chicago',
): Promise<{ dinner: DinnerRow; restaurant: RestaurantRow }> {
  const dinner = await db.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>();
  if (!dinner) throw new Error('Dinner not found');
  if (dinner.status !== 'completed') {
    throw new Error('Only completed dinners can be backfilled; use pick-place for upcoming weeks');
  }

  const restaurant = await db.prepare('SELECT * FROM restaurants WHERE id = ?').bind(restaurantId).first<RestaurantRow>();
  if (!restaurant) throw new Error('Restaurant not found');

  const todayStr = getCentralDateStr(new Date(), timeZone);
  const prevRestaurantId = dinner.restaurant_id;
  const hadPrevious = prevRestaurantId !== null;
  await db
    .prepare(
      `UPDATE dinners
       SET restaurant_id = ?,
           raw_location = CASE WHEN raw_location = '' THEN ? ELSE raw_location END,
           chosen_via = CASE WHEN chosen_via = 'seed' THEN 'backfill' ELSE chosen_via END,
           updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(restaurant.id, restaurant.address || restaurant.name, dinnerId)
    .run();

  if (!hadPrevious || prevRestaurantId !== restaurant.id) {
    if (dinner.dinner_date <= todayStr) {
      await db
        .prepare(
          `UPDATE restaurants
           SET visit_count = visit_count + 1,
               last_visited = CASE WHEN last_visited IS NULL OR last_visited < ? THEN ? ELSE last_visited END
           WHERE id = ?`,
        )
        .bind(dinner.dinner_date, dinner.dinner_date, restaurant.id)
        .run();
    } else {
      await db
        .prepare('UPDATE restaurants SET visit_count = visit_count + 1 WHERE id = ?')
        .bind(restaurant.id)
        .run();
    }
  }

  if (hadPrevious && prevRestaurantId !== null && prevRestaurantId !== restaurant.id) {
    await db
      .prepare(
        `UPDATE restaurants
         SET visit_count = MAX(0, visit_count - 1),
             last_visited = CASE
               WHEN last_visited = ? THEN (
                 SELECT MAX(d.dinner_date)
                 FROM dinners d
                 WHERE d.restaurant_id = restaurants.id AND d.status = 'completed' AND d.dinner_date <= ?
               )
               ELSE last_visited
             END
         WHERE id = ?`,
      )
      .bind(dinner.dinner_date, todayStr, prevRestaurantId)
      .run();
  }

  await db.prepare('UPDATE ratings SET restaurant_id = ? WHERE dinner_id = ?')
    .bind(restaurant.id, dinnerId)
    .run();
  await db.prepare('UPDATE meal_photos SET restaurant_id = ? WHERE dinner_id = ?')
    .bind(restaurant.id, dinnerId)
    .run();
  await recalcRestaurantAvgRating(db, restaurant.id);
  if (prevRestaurantId && prevRestaurantId !== restaurant.id) {
    await recalcRestaurantAvgRating(db, prevRestaurantId);
  }

  return {
    dinner: (await db.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>())!,
    restaurant: (await db.prepare('SELECT * FROM restaurants WHERE id = ?').bind(restaurant.id).first<RestaurantRow>())!,
  };
}

export const MAX_MEAL_PHOTO_BYTES = 600 * 1024;
export const MAX_PHOTOS_PER_USER_DINNER = 12;

export const ALLOWED_PHOTO_MIMES = new Set<AllowedPhotoMime>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

export function base64ToUint8(b64: string): Uint8Array {
  const cleaned = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!cleaned || !/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned)) {
    throw new Error('Invalid base64 image data');
  }
  const padded = cleaned.length % 4 === 0 ? cleaned : cleaned + '='.repeat(4 - (cleaned.length % 4));
  let binary = '';
  try {
    binary = atob(padded);
  } catch {
    throw new Error('Invalid base64 image data');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(bytes.length, i + chunkSize);
    let chunk = '';
    for (let j = i; j < end; j++) {
      chunk += String.fromCharCode(bytes[j]);
    }
    binary += chunk;
  }
  return btoa(binary);
}

export function detectImageMime(bytes: Uint8Array): AllowedPhotoMime | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export function parsePhotoDataInput(imageData: string): {
  mimeType: AllowedPhotoMime;
  bytes: Uint8Array;
  canonicalBase64: string;
  byteSize: number;
} {
  const trimmed = imageData.trim();
  if (!trimmed) {
    throw new Error('Image data is required');
  }
  let rawB64 = trimmed;
  if (trimmed.startsWith('data:')) {
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx < 0) {
      throw new Error('Invalid image data URL');
    }
    const header = trimmed.slice(5, commaIdx).toLowerCase();
    if (!header.includes(';base64')) {
      throw new Error('Image data URL must be base64 encoded');
    }
    rawB64 = trimmed.slice(commaIdx + 1).trim();
  }
  const maxB64Len = Math.ceil((MAX_MEAL_PHOTO_BYTES * 4) / 3) + 64;
  if (rawB64.replace(/\s+/g, '').length > maxB64Len) {
    throw new Error('Photo is too large (max 600 KB). Try choosing a smaller photo.');
  }
  const bytes = base64ToUint8(rawB64);
  if (bytes.byteLength === 0) {
    throw new Error('Uploaded photo is empty');
  }
  if (bytes.byteLength > MAX_MEAL_PHOTO_BYTES) {
    throw new Error('Photo is too large (max 600 KB). Try choosing a smaller photo.');
  }
  const mimeType = detectImageMime(bytes);
  if (!mimeType || !ALLOWED_PHOTO_MIMES.has(mimeType)) {
    throw new Error('Unsupported image format. Please upload a JPEG, PNG, WebP, or GIF photo.');
  }
  return {
    mimeType,
    bytes,
    canonicalBase64: uint8ToBase64(bytes),
    byteSize: bytes.byteLength,
  };
}

interface RawMealPhotoSelect {
  id: number;
  dinner_id: number;
  restaurant_id: number | null;
  user_slug: string;
  user_name: string | null;
  dish: string;
  appetizer: string;
  caption: string;
  mime_type: string;
  width: number | null;
  height: number | null;
  byte_size: number;
  created_at: string;
  dinner_date?: string;
  day_of_week?: string;
  host_label?: string;
  restaurant_name?: string | null;
}

function mapMealPhotoRow(row: RawMealPhotoSelect): MealPhotoViewRow {
  const id = Number(row.id);
  const mimeType = ALLOWED_PHOTO_MIMES.has(row.mime_type as AllowedPhotoMime)
    ? (row.mime_type as AllowedPhotoMime)
    : 'image/jpeg';
  return {
    id,
    dinner_id: Number(row.dinner_id),
    restaurant_id: row.restaurant_id !== null && row.restaurant_id !== undefined ? Number(row.restaurant_id) : null,
    user_slug: row.user_slug,
    user_name: row.user_name ?? null,
    dish: row.dish || '',
    appetizer: row.appetizer || '',
    caption: row.caption || '',
    mime_type: mimeType,
    width: row.width !== null && row.width !== undefined ? Number(row.width) : null,
    height: row.height !== null && row.height !== undefined ? Number(row.height) : null,
    byte_size: Number(row.byte_size),
    created_at: row.created_at,
    image_url: `/api/photos/${id}/image`,
    dinner_date: row.dinner_date,
    day_of_week: row.day_of_week,
    host_label: row.host_label,
    restaurant_name: row.restaurant_name,
  };
}

const MEAL_PHOTO_SELECT_SQL = `
  SELECT mp.id, mp.dinner_id, mp.restaurant_id, mp.user_slug, u.name AS user_name,
         mp.dish, mp.appetizer, mp.caption, mp.mime_type, mp.width, mp.height, mp.byte_size, mp.created_at,
         d.dinner_date, d.day_of_week, d.host_label, r.name AS restaurant_name
  FROM meal_photos mp
  LEFT JOIN users u ON u.slug = mp.user_slug
  LEFT JOIN dinners d ON d.id = mp.dinner_id
  LEFT JOIN restaurants r ON r.id = COALESCE(mp.restaurant_id, d.restaurant_id)
`;

export async function getDinnerPhotos(db: D1Database, dinnerId: number): Promise<MealPhotoViewRow[]> {
  const rows =
    (
      await db
        .prepare(`${MEAL_PHOTO_SELECT_SQL} WHERE mp.dinner_id = ? ORDER BY mp.created_at DESC, mp.id DESC`)
        .bind(dinnerId)
        .all<RawMealPhotoSelect>()
    ).results ?? [];
  return rows.map(mapMealPhotoRow);
}

export async function getPlacePhotos(db: D1Database, placeId: number, limit = 40): Promise<MealPhotoViewRow[]> {
  const safeLimit = Math.max(1, Math.min(60, Math.trunc(limit)));
  const rows =
    (
      await db
        .prepare(
          `${MEAL_PHOTO_SELECT_SQL}
           WHERE mp.restaurant_id = ?
           ORDER BY COALESCE(d.dinner_date, mp.created_at) DESC, mp.created_at DESC, mp.id DESC
           LIMIT ?`,
        )
        .bind(placeId, safeLimit)
        .all<RawMealPhotoSelect>()
    ).results ?? [];
  return rows.map(mapMealPhotoRow);
}

export async function listMealPhotos(
  db: D1Database,
  opts: { dinnerId?: number; placeId?: number; limit?: number } = {},
): Promise<MealPhotoViewRow[]> {
  if (opts.dinnerId !== undefined) {
    return getDinnerPhotos(db, opts.dinnerId);
  }
  if (opts.placeId !== undefined) {
    return getPlacePhotos(db, opts.placeId, opts.limit ?? 40);
  }
  const safeLimit = Math.max(1, Math.min(60, Math.trunc(opts.limit ?? 24)));
  const rows =
    (
      await db
        .prepare(`${MEAL_PHOTO_SELECT_SQL} ORDER BY mp.created_at DESC, mp.id DESC LIMIT ?`)
        .bind(safeLimit)
        .all<RawMealPhotoSelect>()
    ).results ?? [];
  return rows.map(mapMealPhotoRow);
}

export async function uploadMealPhoto(
  db: D1Database,
  userSlug: string,
  input: {
    dinnerId: number;
    imageData: string;
    mimeType?: string;
    dish?: string;
    appetizer?: string;
    caption?: string;
    width?: number | null;
    height?: number | null;
  },
): Promise<MealPhotoViewRow> {
  const dinner = await db
    .prepare('SELECT id, restaurant_id FROM dinners WHERE id = ?')
    .bind(input.dinnerId)
    .first<{ id: number; restaurant_id: number | null }>();
  if (!dinner) throw new Error('Dinner not found');

  const countRow = await db
    .prepare('SELECT COUNT(*) AS cnt FROM meal_photos WHERE dinner_id = ? AND user_slug = ?')
    .bind(input.dinnerId, userSlug)
    .first<{ cnt: number }>();
  if (Number(countRow?.cnt ?? 0) >= MAX_PHOTOS_PER_USER_DINNER) {
    throw new Error('Maximum of 12 photos per member for a single dinner');
  }

  const parsed = parsePhotoDataInput(input.imageData);
  const cleanDish = (input.dish ?? '').trim().slice(0, 140);
  const cleanAppetizer = (input.appetizer ?? '').trim().slice(0, 140);
  const cleanCaption = (input.caption ?? '').trim().slice(0, 300);
  const cleanWidth =
    typeof input.width === 'number' && Number.isInteger(input.width) && input.width > 0 && input.width <= 12000
      ? input.width
      : null;
  const cleanHeight =
    typeof input.height === 'number' && Number.isInteger(input.height) && input.height > 0 && input.height <= 12000
      ? input.height
      : null;

  const ins = await db
    .prepare(
      `INSERT INTO meal_photos (dinner_id, restaurant_id, user_slug, dish, appetizer, caption, mime_type, width, height, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    )
    .bind(
      input.dinnerId,
      dinner.restaurant_id ?? null,
      userSlug,
      cleanDish,
      cleanAppetizer,
      cleanCaption,
      parsed.mimeType,
      cleanWidth,
      cleanHeight,
      parsed.byteSize,
    )
    .run();

  const photoId = Number(ins.meta.last_row_id);
  try {
    await db
      .prepare('INSERT INTO meal_photo_blobs (photo_id, image_base64) VALUES (?, ?)')
      .bind(photoId, parsed.canonicalBase64)
      .run();
  } catch (err) {
    await db.prepare('DELETE FROM meal_photos WHERE id = ?').bind(photoId).run().catch(() => {});
    throw err;
  }

  const created = await db
    .prepare(`${MEAL_PHOTO_SELECT_SQL} WHERE mp.id = ?`)
    .bind(photoId)
    .first<RawMealPhotoSelect>();
  if (!created) throw new Error('Failed to load uploaded meal photo');
  return mapMealPhotoRow(created);
}

export async function getMealPhotoBinary(
  db: D1Database,
  photoId: number,
): Promise<{ id: number; mimeType: AllowedPhotoMime; bytes: Uint8Array; byteSize: number; createdAt: string } | null> {
  const row = await db
    .prepare(
      `SELECT mp.id, mp.mime_type, mp.byte_size, mp.created_at, b.image_base64
       FROM meal_photos mp
       JOIN meal_photo_blobs b ON b.photo_id = mp.id
       WHERE mp.id = ?`,
    )
    .bind(photoId)
    .first<{
      id: number;
      mime_type: string;
      byte_size: number;
      created_at: string;
      image_base64: string;
    }>();
  if (!row) return null;

  const mimeType = ALLOWED_PHOTO_MIMES.has(row.mime_type as AllowedPhotoMime)
    ? (row.mime_type as AllowedPhotoMime)
    : 'image/jpeg';
  const bytes = base64ToUint8(row.image_base64);
  return {
    id: Number(row.id),
    mimeType,
    bytes,
    byteSize: Number(row.byte_size),
    createdAt: row.created_at,
  };
}

export async function deleteMealPhoto(
  db: D1Database,
  photoId: number,
  actorSlug: string,
): Promise<{ deletedId: number; dinnerId: number; restaurantId: number | null }> {
  const row = await db
    .prepare('SELECT id, dinner_id, restaurant_id, user_slug FROM meal_photos WHERE id = ?')
    .bind(photoId)
    .first<{ id: number; dinner_id: number; restaurant_id: number | null; user_slug: string }>();
  if (!row) throw new Error('Photo not found');
  if (row.user_slug !== actorSlug) {
    throw new Error('Forbidden: you can only delete your own meal photos');
  }

  await db.prepare('DELETE FROM meal_photo_blobs WHERE photo_id = ?').bind(photoId).run();
  await db.prepare('DELETE FROM meal_photos WHERE id = ?').bind(photoId).run();

  return {
    deletedId: Number(row.id),
    dinnerId: Number(row.dinner_id),
    restaurantId: row.restaurant_id !== null && row.restaurant_id !== undefined ? Number(row.restaurant_id) : null,
  };
}

export async function getPlaceReviews(
  db: D1Database,
  placeId: number,
  currentUserSlug: string,
  timeZone = 'America/Chicago',
) {
  const todayStr = getCentralDateStr(new Date(), timeZone);
  const place = await db
    .prepare(
      `SELECT ${safeRestaurantSelectSql('r')},
              (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count,
              (SELECT COUNT(*) FROM meal_photos mp WHERE mp.restaurant_id = r.id) AS photo_count
       FROM restaurants r
       WHERE r.id = ?`,
    )
    .bind(todayStr, todayStr, todayStr, todayStr, placeId)
    .first<RestaurantRow>();
  if (!place) throw new Error('Restaurant not found');

  const reviews = (
    await db
      .prepare(
        `SELECT rt.id, rt.dinner_id, rt.restaurant_id, rt.user_slug, u.name AS user_name,
                rt.score, rt.dish, rt.appetizer, rt.comment, rt.price, rt.rated_at,
                d.dinner_date, d.day_of_week, d.host_label
         FROM ratings rt
         LEFT JOIN users u ON u.slug = rt.user_slug
         LEFT JOIN dinners d ON d.id = rt.dinner_id
         WHERE rt.restaurant_id = ?
         ORDER BY COALESCE(d.dinner_date, rt.rated_at) DESC, rt.rated_at DESC, rt.id DESC`,
      )
      .bind(placeId)
      .all<RatingViewRow>()
  ).results ?? [];

  const visits = (
    await db
      .prepare(
        `SELECT d.id, d.week_key, d.dinner_date, d.day_of_week, d.host_slug, d.host_label, d.meal_price,
                (SELECT rt.score FROM ratings rt WHERE rt.dinner_id = d.id AND rt.user_slug = ?) AS my_score,
                (SELECT rt.price FROM ratings rt WHERE rt.dinner_id = d.id AND rt.user_slug = ?) AS my_price,
                (SELECT COUNT(*) FROM ratings rt WHERE rt.dinner_id = d.id) AS rating_count,
                (SELECT ROUND(AVG(rt.score), 2) FROM ratings rt WHERE rt.dinner_id = d.id) AS dinner_avg_rating,
                COALESCE(d.meal_price, (SELECT ROUND(AVG(rt.price), 2) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL)) AS dinner_avg_price,
                (SELECT COUNT(rt.price) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL) AS price_entry_count,
                (SELECT COUNT(*) FROM meal_photos mp WHERE mp.dinner_id = d.id) AS photo_count
         FROM dinners d
         WHERE d.restaurant_id = ? AND d.status = 'completed' AND d.dinner_date <= ?
         ORDER BY d.dinner_date DESC
         LIMIT 12`,
      )
      .bind(currentUserSlug, currentUserSlug, placeId, todayStr)
      .all()
  ).results ?? [];

  const priceRows = (
    await db
      .prepare(
        `SELECT d.id AS dinner_id, d.dinner_date, d.day_of_week, d.host_label,
                COALESCE(d.meal_price, (SELECT ROUND(AVG(rt.price), 2) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL)) AS avg_price,
                (SELECT rt.price FROM ratings rt WHERE rt.dinner_id = d.id AND rt.user_slug = ?) AS my_price,
                (SELECT COUNT(rt.price) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL) AS entry_count
         FROM dinners d
         WHERE d.restaurant_id = ? AND d.status = 'completed' AND d.dinner_date <= ?
           AND (d.meal_price IS NOT NULL OR EXISTS (SELECT 1 FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL))
         ORDER BY d.dinner_date ASC`,
      )
      .bind(currentUserSlug, placeId, todayStr)
      .all<PlaceVisitPrice>()
  ).results ?? [];

  let priceStats: PlacePriceStats | null = null;
  if (priceRows.length > 0) {
    const validPrices = priceRows
      .map((r) => Number(r.avg_price))
      .filter((p) => !isNaN(p) && p > 0);
    if (validPrices.length > 0) {
      const avg_price = Math.round((validPrices.reduce((a, b) => a + b, 0) / validPrices.length) * 100) / 100;
      const min_price = Math.min(...validPrices);
      const max_price = Math.max(...validPrices);
      const totalEntries = priceRows.reduce((sum, r) => sum + (Number(r.entry_count) || (r.avg_price ? 1 : 0)), 0);
      const first = priceRows[0];
      const latest = priceRows[priceRows.length - 1];
      let price_change: number | null = null;
      let price_change_pct: number | null = null;
      if (priceRows.length >= 2 && first.avg_price > 0 && latest.avg_price > 0) {
        price_change = Math.round((latest.avg_price - first.avg_price) * 100) / 100;
        price_change_pct = Math.round(((latest.avg_price - first.avg_price) / first.avg_price) * 1000) / 10;
      }
      priceStats = {
        avg_price,
        min_price,
        max_price,
        entry_count: totalEntries,
        visit_count: priceRows.length,
        history: priceRows,
        first_price: first.avg_price,
        first_date: first.dinner_date,
        latest_price: latest.avg_price,
        latest_date: latest.dinner_date,
        price_change,
        price_change_pct,
      };
      place.avg_meal_price = avg_price;
      place.price_stats = priceStats;
    }
  }

  const photos = await getPlacePhotos(db, placeId, 40);

  return { place, reviews, visits, photos, priceStats };
}

export async function getDinnerReviews(db: D1Database, dinnerId: number) {
  const dinner = await db
    .prepare(
      `SELECT d.id, d.week_key, d.dinner_date, d.day_of_week, d.host_slug, d.host_label,
              d.restaurant_id, d.raw_location, d.meal_price,
              COALESCE(d.meal_price, (SELECT ROUND(AVG(rt.price), 2) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL)) AS dinner_avg_price,
              (SELECT COUNT(rt.price) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL) AS price_entry_count,
              r.name AS restaurant_name, r.address AS restaurant_address, r.avg_rating AS restaurant_avg_rating
       FROM dinners d
       LEFT JOIN restaurants r ON r.id = d.restaurant_id
       WHERE d.id = ?`,
    )
    .bind(dinnerId)
    .first();
  if (!dinner) throw new Error('Dinner not found');

  const reviews = (
    await db
      .prepare(
        `SELECT rt.id, rt.dinner_id, rt.restaurant_id, rt.user_slug, u.name AS user_name,
                rt.score, rt.dish, rt.appetizer, rt.comment, rt.price, rt.rated_at
         FROM ratings rt
         LEFT JOIN users u ON u.slug = rt.user_slug
         WHERE rt.dinner_id = ?
         ORDER BY rt.rated_at DESC, rt.id DESC`,
      )
      .bind(dinnerId)
      .all<RatingViewRow>()
  ).results ?? [];

  const photos = await getDinnerPhotos(db, dinnerId);

  return { dinner, reviews, photos };
}

async function signStandardWebhook(secret: string, msgId: string, timestamp: string, payload: string): Promise<string> {
  const b64 = secret.replace(/^whsec_/, '');
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${msgId}.${timestamp}.${payload}`));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `v1,${b64Sig}`;
}

export const OFF_TOPIC_RELEVANCE_PATTERNS: RegExp[] = [
  /\b(nfl|nba|mlb|nhl|fifa|uefa|premier\s+league|formula\s*1|f1|nascar|wnba|pga)\b/i,
  /\b(touchdown|quarterback|super\s*bowl|world\s*cup|playoffs?|box\s*scores?|sports?\s*scores?|sports?\s*betting|fantasy\s*football|fantasy\s*league)\b/i,
  /\b(crypto(currency)?|bitcoin|btc|ethereum|eth|solana|doge(coin)?|memecoin|nft[s]?)\b/i,
  /\b(stock\s*ticker|stock\s*prices?|nasdaq|dow\s*jones|s&p\s*500|tradingview|forex)\b/i,
  /\b(weather\s*forecast|weather\s*radar|7-day\s*forecast|hurricane\s*tracker)\b/i,
  /\b(flight\s*tracker|airline\s*status|boarding\s*pass|tsa\s*precheck)\b/i,
  /\b(uber\s*eats|doordash|grubhub|postmates|instacart)\b/i,
];

export function checkDeterministicOffTopic(text: string): { offTopic: boolean; matched?: string } {
  for (const pattern of OFF_TOPIC_RELEVANCE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { offTopic: true, matched: match[0] };
    }
  }
  return { offTopic: false };
}

export async function assertIssueRelevance(
  env: Env,
  report: {
    title: string;
    description: string;
    category?: string;
    pageContext?: string;
  },
): Promise<void> {
  const combinedText = `${report.title} ${report.description} ${report.pageContext || ''}`;

  // 1. Fast deterministic heuristic rejection
  const fastCheck = checkDeterministicOffTopic(combinedText);
  if (fastCheck.offTopic) {
    throw new Error(
      `Issue rejected: Request appears unrelated to Man Night Dinner Club (matched off-topic term: "${fastCheck.matched}"). Issues must relate directly to dinners, restaurants, host rotation, ratings, beers/appetizers, notifications, or app bugs.`,
    );
  }

  // 2. Cloudflare Workers AI classification (when AI binding is present)
  if (env.AI) {
    try {
      const systemPrompt = `You are a strict guardrail classifier for "Man Night Dinner Club", a private web application used by a close crew to track weekly dinners.
The application ONLY covers:
- Weekly dinner scheduling, Tuesday vs Wednesday voting, and attendance / RSVPs / extra guests.
- Restaurant directory, place suggestions, place voting/polls, maps, addresses, and history.
- Host rotation queue, King of Hosting, Crown of Shame, and sellout tracking.
- Reviews, star ratings, meal prices, beer tracking, appetizer tracking, and meal photos.
- App functionality, notifications (Web Push), Google Calendar syncing, and bug reports.

Determine whether the user's issue/feature submission is directly relevant to this dinner club app.
Unrelated topics (such as live sports scores, fantasy leagues, stock/crypto prices, weather, ride sharing, generic chatbots, or unrelated external tools/games) MUST be rejected.

Respond ONLY with valid JSON in this exact structure:
{"relevant": true}
or
{"relevant": false, "reason": "<brief explanation under 25 words>"}`;

      const userContent = `Title: ${report.title}\nCategory: ${report.category || 'bug'}\nContext: ${report.pageContext || ''}\nDescription: ${report.description}`;

      const aiResponse = (await env.AI.run('@cf/meta/llama-3.2-3b-instruct', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 120,
        temperature: 0.1,
      })) as { response?: string };

      if (aiResponse && typeof aiResponse.response === 'string') {
        const jsonMatch = aiResponse.response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as { relevant?: boolean; reason?: string };
          if (parsed.relevant === false) {
            throw new Error(
              parsed.reason
                ? `Issue rejected: ${parsed.reason}`
                : 'Issue rejected: Request does not appear directly related to Man Night Dinner Club (dinners, restaurants, rotation, ratings, or app features).',
            );
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Issue rejected:')) {
        throw err;
      }
      console.warn('Workers AI relevance classification check skipped or failed:', err);
    }
  }
}

export async function createIssueReport(
  env: Env,
  reporter: UserRow,
  body: {
    title: string;
    description: string;
    category?: string;
    pageContext?: string;
    imageData?: string | null;
    mimeType?: string;
    width?: number | null;
    height?: number | null;
  },
) {
  const title = body.title.trim().slice(0, 140);
  const description = body.description.trim().slice(0, 4000);
  const category = ['bug', 'data', 'feature', 'access'].includes(body.category || '') ? body.category! : 'bug';
  const pageContext = (body.pageContext || '').trim().slice(0, 300);

  if (!title || !description) throw new Error('Title and description are required');

  await assertIssueRelevance(env, { title, description, category, pageContext });

  const screenshot = body.imageData ? parsePhotoDataInput(body.imageData) : null;
  const screenshotWidth =
    typeof body.width === 'number' && Number.isInteger(body.width) && body.width > 0 && body.width <= 12000
      ? body.width
      : null;
  const screenshotHeight =
    typeof body.height === 'number' && Number.isInteger(body.height) && body.height > 0 && body.height <= 12000
      ? body.height
      : null;

  const ins = await env.DB.prepare(
    `INSERT INTO issue_reports (reporter_slug, title, description, category, page_context)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(reporter.slug, title, description, category, pageContext)
    .run();

  const reportId = Number(ins.meta.last_row_id);

  if (screenshot) {
    await env.DB.prepare('INSERT INTO issue_report_screenshots (report_id, image_base64) VALUES (?, ?)')
      .bind(reportId, screenshot.canonicalBase64)
      .run();
    await env.DB.prepare(
      `UPDATE issue_reports
       SET screenshot_mime = ?, screenshot_byte_size = ?, screenshot_width = ?, screenshot_height = ?
       WHERE id = ?`,
    )
      .bind(screenshot.mimeType, screenshot.byteSize, screenshotWidth, screenshotHeight, reportId)
      .run();
  }

  let githubIssueNumber: number | null = null;
  let githubIssueUrl: string | null = null;
  let webhookStatus = env.GITHUB_TOKEN ? 'pending' : 'no_github_token';

  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    const screenshotUrl = `${(env.APP_URL || '').replace(/\/+$/, '')}/api/issues/${reportId}/screenshot`;
    const isFeature = category === 'feature';
    const issueLabels = ['user-reported', category];
    if (isFeature) {
      issueLabels.push('feature-request', 'needs-review');
    } else {
      issueLabels.push('auto-fix');
    }

    const issueBody = [
      `Reported from **Man Night PWA** by **${reporter.name}** (\`${reporter.email}\`)`,
      pageContext ? `- **Context**: \`${pageContext}\`` : '',
      `- **Category**: \`${category}\``,
      `- **Report ID**: \`#${reportId}\``,
      screenshot ? `- **Screenshot**: \`${screenshotUrl}\` (Cloudflare Access protected — fetch with the service token)` : '',
      '',
      '### Details',
      description,
      '',
      '---',
      isFeature ? '_Submitted as a feature request for review._' : '_Labeled `auto-fix` for OpenBot Man Night Desk._',
    ]
      .filter(Boolean)
      .join('\n');

    const ghResp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'man-night-worker/1.0',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        title: `[App Report] ${title}`,
        body: issueBody,
        labels: issueLabels,
      }),
    });

    if (ghResp.ok) {
      const ghData = (await ghResp.json()) as { number: number; html_url: string };
      githubIssueNumber = ghData.number;
      githubIssueUrl = ghData.html_url;
      webhookStatus = 'github_created';
    } else {
      webhookStatus = `github_err_${ghResp.status}`;
    }
  }

  if (env.OPENBOT_WEBHOOK_URL && githubIssueNumber) {
    const nowIso = new Date().toISOString();
    const eventData = {
      event: 'man_night.issue_reported',
      repo: env.GITHUB_REPO,
      issue_number: githubIssueNumber,
      issue_url: githubIssueUrl,
      title,
      category,
      reporter: reporter.slug,
      page_context: pageContext,
    };
    const payload = JSON.stringify({
      type: 'man_night.issue_reported',
      occurredAt: nowIso,
      timestamp: nowIso,
      data: eventData,
      ...eventData,
    });
    const msgId = `msg_${crypto.randomUUID()}`;
    const ts = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (env.OPENBOT_WEBHOOK_SECRET) {
      headers['webhook-id'] = msgId;
      headers['webhook-timestamp'] = ts;
      headers['webhook-signature'] = await signStandardWebhook(env.OPENBOT_WEBHOOK_SECRET, msgId, ts, payload);
    }
    try {
      const whResp = await fetch(env.OPENBOT_WEBHOOK_URL, { method: 'POST', headers, body: payload });
      if (whResp.ok) webhookStatus = 'github_and_openbot_notified';
    } catch {
      // OpenBot webhook retry or manual issue check will still pick up the labeled GitHub issue
    }
  }

  await env.DB.prepare(
    'UPDATE issue_reports SET github_issue_number = ?, github_issue_url = ?, webhook_status = ? WHERE id = ?',
  )
    .bind(githubIssueNumber, githubIssueUrl, webhookStatus, reportId)
    .run();

  return {
    id: reportId,
    title,
    category,
    github_issue_number: githubIssueNumber,
    github_issue_url: githubIssueUrl,
    webhook_status: webhookStatus,
  };
}

export const MAX_BEERS_LISTED = 200;

interface RawBeerSelect {
  id: number;
  user_slug: string;
  user_name: string | null;
  name: string;
  brewery: string;
  style: string;
  purchased_where: string;
  rating: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
  has_photo: number;
}

function mapBeerRow(row: RawBeerSelect): BeerViewRow {
  const id = Number(row.id);
  const hasPhoto = Number(row.has_photo) === 1;
  return {
    id,
    user_slug: row.user_slug,
    user_name: row.user_name ?? null,
    name: row.name,
    brewery: row.brewery || '',
    style: row.style || '',
    purchased_where: row.purchased_where || '',
    rating: row.rating !== null && row.rating !== undefined ? Number(row.rating) : null,
    notes: row.notes || '',
    created_at: row.created_at,
    updated_at: row.updated_at,
    has_photo: hasPhoto,
    image_url: hasPhoto ? `/api/beers/${id}/image` : null,
  };
}

const BEER_SELECT_SQL = `
  SELECT b.id, b.user_slug, u.name AS user_name, b.name, b.brewery, b.style, b.purchased_where,
         b.rating, b.notes, b.created_at, b.updated_at,
         CASE WHEN bp.beer_id IS NULL THEN 0 ELSE 1 END AS has_photo
  FROM beers b
  LEFT JOIN users u ON u.slug = b.user_slug
  LEFT JOIN beer_photos bp ON bp.beer_id = b.id
`;

function cleanBeerText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function normalizeBeerRating(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new Error('Beer rating must be a whole number from 1 to 5');
  }
  return n;
}

function cleanImageDimension(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 12000 ? value : null;
}

export async function listBeers(
  db: D1Database,
  opts: { q?: string; userSlug?: string; sort?: string; limit?: number } = {},
): Promise<BeerListPayload> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const q = (opts.q ?? '').trim().toLowerCase();
  if (q) {
    const pat = `%${q}%`;
    where.push(
      `(LOWER(b.name) LIKE ? OR LOWER(b.brewery) LIKE ? OR LOWER(b.style) LIKE ?
        OR LOWER(b.purchased_where) LIKE ? OR LOWER(b.notes) LIKE ? OR LOWER(COALESCE(u.name, b.user_slug)) LIKE ?)`,
    );
    binds.push(pat, pat, pat, pat, pat, pat);
  }
  if (opts.userSlug) {
    where.push('b.user_slug = ?');
    binds.push(opts.userSlug);
  }
  const sortSql =
    opts.sort === 'rating'
      ? 'b.rating IS NULL ASC, b.rating DESC, b.created_at DESC, b.id DESC'
      : opts.sort === 'name'
        ? 'b.name COLLATE NOCASE ASC, b.id DESC'
        : 'b.created_at DESC, b.id DESC';
  const rawLimit = Number(opts.limit ?? MAX_BEERS_LISTED);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_BEERS_LISTED, Math.trunc(rawLimit)))
    : MAX_BEERS_LISTED;

  const rows =
    (
      await db
        .prepare(`${BEER_SELECT_SQL} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${sortSql} LIMIT ?`)
        .bind(...binds, limit)
        .all<RawBeerSelect>()
    ).results ?? [];

  const statsRow = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              ROUND(AVG(rating), 2) AS avg_rating,
              COUNT(DISTINCT CASE WHEN TRIM(brewery) != '' THEN LOWER(TRIM(brewery)) END) AS breweries,
              COUNT(DISTINCT CASE WHEN TRIM(style) != '' THEN LOWER(TRIM(style)) END) AS styles
       FROM beers`,
    )
    .first<{ total: number; avg_rating: number | null; breweries: number; styles: number }>();

  const stats: BeerStats = {
    total: Number(statsRow?.total ?? 0),
    avg_rating:
      statsRow?.avg_rating !== null && statsRow?.avg_rating !== undefined ? Number(statsRow.avg_rating) : null,
    breweries: Number(statsRow?.breweries ?? 0),
    styles: Number(statsRow?.styles ?? 0),
  };

  const beers = rows.map(mapBeerRow);
  return { beers, total: beers.length, stats };
}

async function loadBeerRow(db: D1Database, beerId: number): Promise<BeerViewRow> {
  const row = await db.prepare(`${BEER_SELECT_SQL} WHERE b.id = ?`).bind(beerId).first<RawBeerSelect>();
  if (!row) throw new Error('Beer not found');
  return mapBeerRow(row);
}

export interface BeerInput {
  name?: string;
  brewery?: string;
  style?: string;
  purchasedWhere?: string;
  rating?: number | string | null;
  notes?: string;
  imageData?: string | null;
  width?: number | null;
  height?: number | null;
}

export async function createBeer(db: D1Database, userSlug: string, input: BeerInput): Promise<BeerViewRow> {
  const name = cleanBeerText(input.name, 120);
  if (!name) throw new Error('Beer name is required');
  const brewery = cleanBeerText(input.brewery, 120);
  const style = cleanBeerText(input.style, 120);
  const purchasedWhere = cleanBeerText(input.purchasedWhere, 120);
  const notes = cleanBeerText(input.notes, 600);
  const rating = normalizeBeerRating(input.rating);
  const photo = input.imageData ? parsePhotoDataInput(input.imageData) : null;

  const ins = await db
    .prepare(
      `INSERT INTO beers (user_slug, name, brewery, style, purchased_where, rating, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    )
    .bind(userSlug, name, brewery, style, purchasedWhere, rating, notes)
    .run();

  const beerId = Number(ins.meta.last_row_id);
  if (photo) {
    try {
      await db
        .prepare(
          `INSERT INTO beer_photos (beer_id, mime_type, width, height, byte_size, image_base64)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          beerId,
          photo.mimeType,
          cleanImageDimension(input.width),
          cleanImageDimension(input.height),
          photo.byteSize,
          photo.canonicalBase64,
        )
        .run();
    } catch (err) {
      await db.prepare('DELETE FROM beers WHERE id = ?').bind(beerId).run().catch(() => {});
      throw err;
    }
  }

  return loadBeerRow(db, beerId);
}

export async function updateBeer(
  db: D1Database,
  beerId: number,
  userSlug: string,
  input: BeerInput,
): Promise<BeerViewRow> {
  const existing = await db
    .prepare('SELECT id, user_slug FROM beers WHERE id = ?')
    .bind(beerId)
    .first<{ id: number; user_slug: string }>();
  if (!existing) throw new Error('Beer not found');
  if (existing.user_slug !== userSlug) throw new Error('Forbidden: you can only edit your own beers');

  const name = cleanBeerText(input.name, 120);
  if (!name) throw new Error('Beer name is required');
  const brewery = cleanBeerText(input.brewery, 120);
  const style = cleanBeerText(input.style, 120);
  const purchasedWhere = cleanBeerText(input.purchasedWhere, 120);
  const notes = cleanBeerText(input.notes, 600);
  const rating = normalizeBeerRating(input.rating);
  const photo = input.imageData ? parsePhotoDataInput(input.imageData) : null;

  await db
    .prepare(
      `UPDATE beers
       SET name = ?, brewery = ?, style = ?, purchased_where = ?, rating = ?, notes = ?, updated_at = datetime('now')
       WHERE id = ?`,
    )
    .bind(name, brewery, style, purchasedWhere, rating, notes, beerId)
    .run();

  if (photo) {
    await db
      .prepare(
        `INSERT INTO beer_photos (beer_id, mime_type, width, height, byte_size, image_base64)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(beer_id) DO UPDATE SET
           mime_type = excluded.mime_type,
           width = excluded.width,
           height = excluded.height,
           byte_size = excluded.byte_size,
           image_base64 = excluded.image_base64`,
      )
      .bind(
        beerId,
        photo.mimeType,
        cleanImageDimension(input.width),
        cleanImageDimension(input.height),
        photo.byteSize,
        photo.canonicalBase64,
      )
      .run();
  }

  return loadBeerRow(db, beerId);
}

export async function deleteBeer(
  db: D1Database,
  beerId: number,
  userSlug: string,
): Promise<{ deleted: true; id: number }> {
  const existing = await db
    .prepare('SELECT id, user_slug FROM beers WHERE id = ?')
    .bind(beerId)
    .first<{ id: number; user_slug: string }>();
  if (!existing) throw new Error('Beer not found');
  if (existing.user_slug !== userSlug) throw new Error('Forbidden: you can only delete your own beers');
  await db.prepare('DELETE FROM beers WHERE id = ?').bind(beerId).run();
  return { deleted: true, id: beerId };
}

export async function getBeerPhotoBinary(
  db: D1Database,
  beerId: number,
): Promise<{ id: number; mimeType: AllowedPhotoMime; bytes: Uint8Array; byteSize: number } | null> {
  const row = await db
    .prepare(
      `SELECT bp.beer_id, bp.mime_type, bp.byte_size, bp.image_base64
       FROM beer_photos bp
       WHERE bp.beer_id = ?`,
    )
    .bind(beerId)
    .first<{ beer_id: number; mime_type: string; byte_size: number; image_base64: string }>();
  if (!row) return null;
  const mimeType = ALLOWED_PHOTO_MIMES.has(row.mime_type as AllowedPhotoMime)
    ? (row.mime_type as AllowedPhotoMime)
    : 'image/jpeg';
  return {
    id: Number(row.beer_id),
    mimeType,
    bytes: base64ToUint8(row.image_base64),
    byteSize: Number(row.byte_size),
  };
}

export async function getIssueReportScreenshot(
  db: D1Database,
  reportId: number,
): Promise<{ id: number; mimeType: AllowedPhotoMime; bytes: Uint8Array; byteSize: number } | null> {
  const row = await db
    .prepare(
      `SELECT ir.id, ir.screenshot_mime, ir.screenshot_byte_size, s.image_base64
       FROM issue_reports ir
       JOIN issue_report_screenshots s ON s.report_id = ir.id
       WHERE ir.id = ?`,
    )
    .bind(reportId)
    .first<{ id: number; screenshot_mime: string | null; screenshot_byte_size: number | null; image_base64: string }>();
  if (!row) return null;
  const mimeType = ALLOWED_PHOTO_MIMES.has(row.screenshot_mime as AllowedPhotoMime)
    ? (row.screenshot_mime as AllowedPhotoMime)
    : 'image/jpeg';
  return {
    id: Number(row.id),
    mimeType,
    bytes: base64ToUint8(row.image_base64),
    byteSize: Number(row.screenshot_byte_size ?? 0),
  };
}

export async function getBootstrapPayload(env: Env, currentUser: UserRow) {
  const todayStr = getCentralDateStr(new Date(), env.CLUB_TIMEZONE || 'America/Chicago');
  const active = await getActiveDinner(env.DB);
  const users = (
    await env.DB.prepare('SELECT id, slug, name, avatar_class, initials, is_rotation, rotation_order FROM users ORDER BY COALESCE(rotation_order, 99), id')
      .all<UserRow>()
  ).results ?? [];

  let activePlace: RestaurantRow | null = null;
  let nightVotes: NightVoteViewRow[] = [];
  let noonVotes: Array<{ user_slug: string; restaurant_id: number }> = [];
  let noonCandidates: RestaurantRow[] = [];
  let rsvps: Array<{
    user_slug: string;
    user_name: string | null;
    status: string;
    eta_minutes: number | null;
    extra_guests: number;
    note: string;
    recorded_by: string | null;
    updated_at: string;
  }> = [];
  let headcount: Awaited<ReturnType<typeof computeDinnerHeadcount>> | null = null;
  let ratings: Array<{ user_slug: string; score: number; dish: string; appetizer?: string; comment: string; price?: number | null }> = [];
  let activePhotos: MealPhotoViewRow[] = [];

  if (active) {
    if (active.restaurant_id) {
      activePlace = await env.DB.prepare(
        `SELECT ${safeRestaurantSelectSql('r')},
                (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count,
                (SELECT COUNT(*) FROM meal_photos mp WHERE mp.restaurant_id = r.id) AS photo_count
         FROM restaurants r
         WHERE r.id = ?`,
      )
        .bind(todayStr, todayStr, todayStr, todayStr, active.restaurant_id)
        .first<RestaurantRow>();
    }
    nightVotes = await getNightVotesForDinner(env.DB, active.id);
    noonVotes = (await env.DB.prepare('SELECT user_slug, restaurant_id FROM noon_votes WHERE dinner_id = ?').bind(active.id).all()).results as typeof noonVotes;
    rsvps = (
      await env.DB.prepare(
        `SELECT r.user_slug, u.name AS user_name, r.status, r.eta_minutes, r.extra_guests, r.note, r.recorded_by, r.updated_at
         FROM rsvps r
         LEFT JOIN users u ON u.slug = r.user_slug
         WHERE r.dinner_id = ?
         ORDER BY r.updated_at ASC, r.id ASC`,
      )
        .bind(active.id)
        .all()
    ).results as typeof rsvps;
    headcount = await computeDinnerHeadcount(env.DB, active.id);
    ratings = (await env.DB.prepare('SELECT user_slug, score, dish, appetizer, comment, price FROM ratings WHERE dinner_id = ?').bind(active.id).all()).results as typeof ratings;
    activePhotos = await getDinnerPhotos(env.DB, active.id);

    const ids = parseIdListJson(active.noon_draw_ids);
    if (ids.length > 0) {
      const candRows = (
        await env.DB.prepare(
          `SELECT ${safeRestaurantSelectSql('r')},
                  (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count,
                  (SELECT COUNT(*) FROM meal_photos mp WHERE mp.restaurant_id = r.id) AS photo_count
           FROM restaurants r
           WHERE r.id IN (${ids.map(() => '?').join(',')})`,
        )
          .bind(todayStr, todayStr, todayStr, todayStr, ...ids)
          .all<RestaurantRow>()
      ).results ?? [];
      const candMap = new Map(candRows.map((r) => [Number(r.id), r]));
      noonCandidates = ids.map((id) => candMap.get(id)).filter((r): r is RestaurantRow => Boolean(r));
    }
  }

  const upcoming = (
    await env.DB.prepare(
      `SELECT d.*, r.name AS restaurant_name, r.address AS restaurant_address
       FROM dinners d
       LEFT JOIN restaurants r ON r.id = d.restaurant_id
       WHERE d.is_historical = 0 AND d.id != COALESCE(?, -1) AND d.dinner_date >= COALESCE(?, '2026-01-01')
       ORDER BY d.dinner_date ASC LIMIT 5`,
    )
      .bind(active?.id ?? null, active?.dinner_date ?? null)
      .all()
  ).results ?? [];

  const recentDinners = (
    await env.DB.prepare(
      `SELECT d.*,
              r.name AS restaurant_name,
              r.address AS restaurant_address,
              r.visit_count AS restaurant_visits,
              r.avg_rating AS restaurant_avg_rating,
              (SELECT COUNT(*) FROM ratings rt WHERE rt.dinner_id = d.id) AS rating_count,
              (SELECT ROUND(AVG(rt.score), 2) FROM ratings rt WHERE rt.dinner_id = d.id) AS dinner_avg_rating,
              COALESCE(d.meal_price, (SELECT ROUND(AVG(rt.price), 2) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL)) AS dinner_avg_price,
              (SELECT COUNT(*) FROM meal_photos mp WHERE mp.dinner_id = d.id) AS photo_count
       FROM dinners d
       LEFT JOIN restaurants r ON r.id = d.restaurant_id
       WHERE d.status = 'completed'
       ORDER BY d.dinner_date DESC LIMIT 8`,
    ).all()
  ).results ?? [];

  const lastDinnerId = (recentDinners[0] as { id?: number } | undefined)?.id ?? null;
  const lastDinnerRatings: RatingViewRow[] = lastDinnerId
    ? (
        await env.DB.prepare(
          `SELECT rt.id, rt.dinner_id, rt.restaurant_id, rt.user_slug, u.name AS user_name,
                  rt.score, rt.dish, rt.appetizer, rt.comment, rt.price, rt.rated_at
           FROM ratings rt
           LEFT JOIN users u ON u.slug = rt.user_slug
           WHERE rt.dinner_id = ?
           ORDER BY rt.rated_at DESC, rt.id DESC`,
        )
          .bind(lastDinnerId)
          .all<RatingViewRow>()
      ).results ?? []
    : [];
  const lastDinnerPhotos: MealPhotoViewRow[] = lastDinnerId ? await getDinnerPhotos(env.DB, lastDinnerId) : [];

  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM dinners WHERE status = 'completed') AS total_dinners,
       (SELECT COUNT(*) FROM restaurants) AS total_places,
       (SELECT COUNT(*) FROM dinners WHERE status = 'completed' AND dinner_date >= '2025-01-01') AS recent_weeks,
       (SELECT COUNT(*) FROM dinners WHERE status = 'completed' AND dinner_date >= '2025-01-01' AND day_of_week = 'Tuesday') AS recent_tuesdays,
       (SELECT ROUND(AVG(price), 2) FROM ratings WHERE price IS NOT NULL AND price > 0) AS avg_meal_price,
       (SELECT COUNT(*) FROM ratings WHERE price IS NOT NULL AND price > 0) AS total_price_entries`,
  ).first<{ total_dinners: number; total_places: number; recent_weeks: number; recent_tuesdays: number; avg_meal_price: number | null; total_price_entries: number }>();

  const hostStats = (
    await env.DB.prepare(
      `SELECT d.host_slug,
              COALESCE(u.name, MAX(d.host_label)) AS host_label,
              COUNT(*) AS hosted_count,
              MAX(d.dinner_date) AS last_hosted
       FROM dinners d
       LEFT JOIN users u ON u.slug = d.host_slug
       WHERE d.status = 'completed' AND d.host_slug IS NOT NULL
       GROUP BY d.host_slug
       ORDER BY hosted_count DESC, COALESCE(u.rotation_order, 99) ASC, host_label ASC`,
    ).all<HostStatRow>()
  ).results ?? [];

  const favRows = (
    await env.DB.prepare(
      `SELECT d.host_slug,
              d.restaurant_id,
              r.name AS restaurant_name,
              COUNT(*) AS times_picked,
              MAX(d.dinner_date) AS last_picked
       FROM dinners d
       JOIN restaurants r ON r.id = d.restaurant_id
       WHERE d.status = 'completed' AND d.host_slug IS NOT NULL AND d.restaurant_id IS NOT NULL
       GROUP BY d.host_slug, d.restaurant_id
       ORDER BY d.host_slug, times_picked DESC, last_picked DESC`,
    ).all<{ host_slug: string; restaurant_id: number; restaurant_name: string; times_picked: number; last_picked: string }>()
  ).results ?? [];

  const favMap = new Map<string, HostFavoritePlace>();
  for (const row of favRows) {
    if (!favMap.has(row.host_slug)) {
      favMap.set(row.host_slug, {
        restaurant_id: row.restaurant_id,
        restaurant_name: row.restaurant_name,
        times_picked: row.times_picked,
        last_picked: row.last_picked,
      });
    }
  }

  for (const h of hostStats) {
    h.favorite_place = favMap.get(h.host_slug) ?? null;
  }

  const activeId = active?.id ?? -1;

  const selloutStats = (
    await env.DB.prepare(
      `SELECT u.slug AS user_slug,
              u.name AS user_name,
              u.avatar_class,
              u.initials,
              u.is_rotation,
              COUNT(CASE WHEN d.id IS NOT NULL AND rv.status = 'out' THEN 1 END) AS sellout_count,
              COUNT(CASE WHEN d.id IS NOT NULL AND rv.status IN ('in', 'late') THEN 1 END) AS attended_count,
              MAX(CASE WHEN d.id IS NOT NULL AND rv.status = 'out' THEN d.dinner_date END) AS last_sellout_date,
              (
                SELECT rv2.note
                FROM rsvps rv2
                JOIN dinners d2 ON d2.id = rv2.dinner_id
                WHERE rv2.user_slug = u.slug
                  AND rv2.status = 'out'
                  AND d2.is_historical = 0
                  AND (d2.status != 'scheduled' OR d2.id = ?)
                ORDER BY d2.dinner_date DESC, rv2.updated_at DESC
                LIMIT 1
              ) AS last_sellout_note
       FROM users u
       LEFT JOIN rsvps rv ON rv.user_slug = u.slug
       LEFT JOIN dinners d
         ON d.id = rv.dinner_id
        AND d.is_historical = 0
        AND (d.status != 'scheduled' OR d.id = ?)
       WHERE u.email NOT LIKE '%@history.local'
         AND (u.is_rotation = 1 OR EXISTS (
           SELECT 1 FROM rsvps rv3
           JOIN dinners d3 ON d3.id = rv3.dinner_id
           WHERE rv3.user_slug = u.slug
             AND rv3.status = 'out'
             AND d3.is_historical = 0
             AND (d3.status != 'scheduled' OR d3.id = ?)
         ))
       GROUP BY u.id
       ORDER BY sellout_count DESC,
                last_sellout_date DESC,
                COALESCE(u.rotation_order, 99) ASC,
                u.id ASC`,
    )
      .bind(activeId, activeId, activeId)
      .all<SelloutStatRow>()
  ).results ?? [];

  const recentSellouts = (
    await env.DB.prepare(
      `SELECT rv.dinner_id, d.week_key, d.dinner_date, d.day_of_week, d.host_label,
              r.name AS restaurant_name,
              rv.user_slug, COALESCE(u.name, rv.user_slug) AS user_name,
              rv.note, rv.recorded_by, rv.updated_at
       FROM rsvps rv
       JOIN dinners d ON d.id = rv.dinner_id
       LEFT JOIN users u ON u.slug = rv.user_slug
       LEFT JOIN restaurants r ON r.id = d.restaurant_id
       WHERE rv.status = 'out'
         AND d.is_historical = 0
         AND (d.status != 'scheduled' OR d.id = ?)
       ORDER BY d.dinner_date DESC, rv.updated_at DESC, rv.id DESC
       LIMIT 60`,
    )
      .bind(activeId)
      .all<SelloutLogRow>()
  ).results ?? [];

  const trackableDinners = (
    await env.DB.prepare(
      `SELECT d.id, d.week_key, d.dinner_date, d.day_of_week, d.host_slug, d.host_label, d.status,
              r.name AS restaurant_name
       FROM dinners d
       LEFT JOIN restaurants r ON r.id = d.restaurant_id
       WHERE d.is_historical = 0
         AND (d.status != 'scheduled' OR d.id = ?)
       ORDER BY d.dinner_date DESC
       LIMIT 12`,
    )
      .bind(activeId)
      .all<TrackableDinnerRow>()
  ).results ?? [];

  const myPushCount = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM push_subscriptions WHERE user_slug = ?')
    .bind(currentUser.slug)
    .first<{ cnt: number }>();

  return {
    user: {
      slug: currentUser.slug,
      name: currentUser.name,
      email: currentUser.email,
      avatar_class: currentUser.avatar_class,
      initials: currentUser.initials,
      is_rotation: currentUser.is_rotation === 1,
      notify_night_vote: currentUser.notify_night_vote === 1,
      notify_place: currentUser.notify_place === 1,
      notify_reminder: currentUser.notify_reminder === 1,
      walkthrough_seen: Boolean(currentUser.walkthrough_seen_at),
      whats_new_seen_id: currentUser.whats_new_seen_id ?? null,
      push_enabled: Number(myPushCount?.cnt ?? 0) > 0,
    },
    whatsNew: buildWhatsNewPayload(currentUser.whats_new_seen_id ?? null, users),
    stats: counts,
    hostStats,
    selloutStats,
    recentSellouts,
    trackableDinners,
    users,
    thisWeek: active
      ? {
          dinner: active,
          place: activePlace,
          directions_url: activePlace ? buildDirectionsUrl(activePlace) : null,
          nightVotes,
          noonVotes,
          noonCandidates,
          rsvps,
          headcount,
          ratings,
          photos: activePhotos,
        }
      : null,
    upcoming,
    recentDinners,
    lastDinnerRatings,
    lastDinnerPhotos,
    today: todayStr,
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
    appUrl: env.APP_URL,
    githubRepo: env.GITHUB_REPO,
  };
}
