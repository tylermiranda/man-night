import { buildDirectionsUrl, syncLockedPlaceToCalendar } from './gcal';
import { sendWebPushToSubscribers } from './push';
import type {
  DinnerRow,
  Env,
  HostStatRow,
  NightVoteViewRow,
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

    await sendWebPushToSubscribers(
      env,
      {
        title: `${updated.host_label} picked ${updatedRestaurant.name}`,
        body: 'Spot is set! Vote Tuesday or Wednesday before Monday noon.',
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
  await sendWebPushToSubscribers(
    env,
    {
      title: `Place locked: ${updatedRestaurant.name}`,
      body: wasEarlyAdvanceLock
        ? `${updated.host_label} picked ${updatedRestaurant.name} for ${updated.day_of_week} (${updated.dinner_date}) — no vote needed`
        : `${updated.day_of_week} 6:30 PM · ${viaText}`,
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

  await env.DB.prepare(
    `DELETE FROM noon_votes WHERE dinner_id = ? AND restaurant_id NOT IN (${candIds.map(() => '?').join(',')})`,
  )
    .bind(dinnerId, ...candIds)
    .run();

  const updated = (await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>())!;
  await sendWebPushToSubscribers(
    env,
    {
      title: `${updated.host_label} opened a place poll`,
      body: `${candidates.map((c) => c.name).join(', ')}${shouldKeepNightVote ? ' · Vote on place & Tue/Wed' : ` · For ${updated.day_of_week}`}`,
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

export async function castRsvp(
  db: D1Database,
  dinnerId: number,
  userSlug: string,
  status: 'in' | 'late' | 'out' | 'clear',
  etaMinutes: number | null,
  note?: string,
  recordedBy?: string,
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
    return;
  }

  if (status === 'out') {
    const hasNote = typeof note === 'string';
    const cleanNote = hasNote ? note.trim().slice(0, 140) : '';
    await db
      .prepare(
        `INSERT INTO rsvps (dinner_id, user_slug, status, eta_minutes, note, recorded_by, updated_at)
         VALUES (?, ?, 'out', NULL, ?, ?, datetime('now'))
         ON CONFLICT(dinner_id, user_slug)
         DO UPDATE SET
           status = 'out',
           eta_minutes = NULL,
           note = CASE WHEN ? = 1 THEN excluded.note ELSE CASE WHEN rsvps.status = 'out' THEN rsvps.note ELSE '' END END,
           recorded_by = excluded.recorded_by,
           updated_at = datetime('now')`,
      )
      .bind(dinnerId, userSlug, cleanNote, actor, hasNote ? 1 : 0)
      .run();
    return;
  }

  const cleanNote = typeof note === 'string' ? note.trim().slice(0, 140) : '';
  const eta = status === 'late' ? etaMinutes : null;
  await db
    .prepare(
      `INSERT INTO rsvps (dinner_id, user_slug, status, eta_minutes, note, recorded_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(dinner_id, user_slug)
       DO UPDATE SET
         status = excluded.status,
         eta_minutes = excluded.eta_minutes,
         note = excluded.note,
         recorded_by = excluded.recorded_by,
         updated_at = datetime('now')`,
    )
    .bind(dinnerId, userSlug, status, eta, cleanNote, actor)
    .run();
}

export async function submitRating(
  db: D1Database,
  dinnerId: number,
  userSlug: string,
  score: number,
  dish: string,
  comment: string,
) {
  const dinner = await db
    .prepare('SELECT id, restaurant_id FROM dinners WHERE id = ?')
    .bind(dinnerId)
    .first<{ id: number; restaurant_id: number | null }>();
  if (!dinner) throw new Error('Dinner not found');

  const cleanDish = dish.trim().slice(0, 140);
  const cleanComment = comment.trim().slice(0, 500);

  await db
    .prepare(
      `INSERT INTO ratings (dinner_id, restaurant_id, user_slug, score, dish, comment, rated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(dinner_id, user_slug)
       DO UPDATE SET restaurant_id = excluded.restaurant_id, score = excluded.score, dish = excluded.dish, comment = excluded.comment, rated_at = datetime('now')`,
    )
    .bind(dinnerId, dinner.restaurant_id ?? null, userSlug, score, cleanDish, cleanComment)
    .run();

  await recalcRestaurantAvgRating(db, dinner.restaurant_id);

  return {
    dinner_id: dinnerId,
    restaurant_id: dinner.restaurant_id,
    score,
    dish: cleanDish,
    comment: cleanComment,
  };
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
  await recalcRestaurantAvgRating(db, restaurant.id);
  if (prevRestaurantId && prevRestaurantId !== restaurant.id) {
    await recalcRestaurantAvgRating(db, prevRestaurantId);
  }

  return {
    dinner: (await db.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinnerId).first<DinnerRow>())!,
    restaurant: (await db.prepare('SELECT * FROM restaurants WHERE id = ?').bind(restaurant.id).first<RestaurantRow>())!,
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
              (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count
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
                rt.score, rt.dish, rt.comment, rt.rated_at,
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
        `SELECT d.id, d.week_key, d.dinner_date, d.day_of_week, d.host_slug, d.host_label,
                (SELECT rt.score FROM ratings rt WHERE rt.dinner_id = d.id AND rt.user_slug = ?) AS my_score,
                (SELECT COUNT(*) FROM ratings rt WHERE rt.dinner_id = d.id) AS rating_count,
                (SELECT ROUND(AVG(rt.score), 2) FROM ratings rt WHERE rt.dinner_id = d.id) AS dinner_avg_rating
         FROM dinners d
         WHERE d.restaurant_id = ? AND d.status = 'completed' AND d.dinner_date <= ?
         ORDER BY d.dinner_date DESC
         LIMIT 12`,
      )
      .bind(currentUserSlug, placeId, todayStr)
      .all()
  ).results ?? [];

  return { place, reviews, visits };
}

export async function getDinnerReviews(db: D1Database, dinnerId: number) {
  const dinner = await db
    .prepare(
      `SELECT d.id, d.week_key, d.dinner_date, d.day_of_week, d.host_slug, d.host_label,
              d.restaurant_id, d.raw_location,
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
                rt.score, rt.dish, rt.comment, rt.rated_at
         FROM ratings rt
         LEFT JOIN users u ON u.slug = rt.user_slug
         WHERE rt.dinner_id = ?
         ORDER BY rt.rated_at DESC, rt.id DESC`,
      )
      .bind(dinnerId)
      .all<RatingViewRow>()
  ).results ?? [];

  return { dinner, reviews };
}

async function signStandardWebhook(secret: string, msgId: string, timestamp: string, payload: string): Promise<string> {
  const b64 = secret.replace(/^whsec_/, '');
  const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${msgId}.${timestamp}.${payload}`));
  const b64Sig = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `v1,${b64Sig}`;
}

export async function createIssueReport(
  env: Env,
  reporter: UserRow,
  body: { title: string; description: string; category?: string; pageContext?: string },
) {
  const title = body.title.trim().slice(0, 140);
  const description = body.description.trim().slice(0, 4000);
  const category = ['bug', 'data', 'feature', 'access'].includes(body.category || '') ? body.category! : 'bug';
  const pageContext = (body.pageContext || '').trim().slice(0, 300);

  if (!title || !description) throw new Error('Title and description are required');

  const ins = await env.DB.prepare(
    `INSERT INTO issue_reports (reporter_slug, title, description, category, page_context)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(reporter.slug, title, description, category, pageContext)
    .run();

  const reportId = Number(ins.meta.last_row_id);
  let githubIssueNumber: number | null = null;
  let githubIssueUrl: string | null = null;
  let webhookStatus = env.GITHUB_TOKEN ? 'pending' : 'no_github_token';

  if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
    const issueBody = [
      `Reported from **Man Night PWA** by **${reporter.name}** (\`${reporter.email}\`)`,
      pageContext ? `- **Context**: \`${pageContext}\`` : '',
      `- **Category**: \`${category}\``,
      `- **Report ID**: \`#${reportId}\``,
      '',
      '### Details',
      description,
      '',
      '---',
      '_Labeled `auto-fix` for OpenBot Man Night Desk._',
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
        labels: ['user-reported', 'auto-fix', category],
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
    note: string;
    recorded_by: string | null;
    updated_at: string;
  }> = [];
  let ratings: Array<{ user_slug: string; score: number; dish: string; comment: string }> = [];

  if (active) {
    if (active.restaurant_id) {
      activePlace = await env.DB.prepare(
        `SELECT ${safeRestaurantSelectSql('r')},
                (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count
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
        `SELECT r.user_slug, u.name AS user_name, r.status, r.eta_minutes, r.note, r.recorded_by, r.updated_at
         FROM rsvps r
         LEFT JOIN users u ON u.slug = r.user_slug
         WHERE r.dinner_id = ?
         ORDER BY r.updated_at ASC, r.id ASC`,
      )
        .bind(active.id)
        .all()
    ).results as typeof rsvps;
    ratings = (await env.DB.prepare('SELECT user_slug, score, dish, comment FROM ratings WHERE dinner_id = ?').bind(active.id).all()).results as typeof ratings;

    const ids = parseIdListJson(active.noon_draw_ids);
    if (ids.length > 0) {
      const candRows = (
        await env.DB.prepare(
          `SELECT ${safeRestaurantSelectSql('r')},
                  (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count
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
              (SELECT ROUND(AVG(rt.score), 2) FROM ratings rt WHERE rt.dinner_id = d.id) AS dinner_avg_rating
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
                  rt.score, rt.dish, rt.comment, rt.rated_at
           FROM ratings rt
           LEFT JOIN users u ON u.slug = rt.user_slug
           WHERE rt.dinner_id = ?
           ORDER BY rt.rated_at DESC, rt.id DESC`,
        )
          .bind(lastDinnerId)
          .all<RatingViewRow>()
      ).results ?? []
    : [];

  const counts = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM dinners WHERE status = 'completed') AS total_dinners,
       (SELECT COUNT(*) FROM restaurants) AS total_places,
       (SELECT COUNT(*) FROM dinners WHERE status = 'completed' AND dinner_date >= '2025-01-01') AS recent_weeks,
       (SELECT COUNT(*) FROM dinners WHERE status = 'completed' AND dinner_date >= '2025-01-01' AND day_of_week = 'Tuesday') AS recent_tuesdays`,
  ).first<{ total_dinners: number; total_places: number; recent_weeks: number; recent_tuesdays: number }>();

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
      push_enabled: Number(myPushCount?.cnt ?? 0) > 0,
    },
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
          ratings,
        }
      : null,
    upcoming,
    recentDinners,
    lastDinnerRatings,
    today: todayStr,
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
    appUrl: env.APP_URL,
    githubRepo: env.GITHUB_REPO,
  };
}
