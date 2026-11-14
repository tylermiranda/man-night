import { buildDirectionsUrl } from './gcal';
import { sendWebPushToSubscribers } from './push';
import type { DinnerRow, Env, RestaurantRow } from './types';
import {
  closeNoonVote,
  completeDinner,
  ensureNextScheduledDinner,
  lockNight,
  openNoonDraw,
} from './workflow';

export interface CentralClock {
  dateStr: string;
  weekday: string;
  minutesOfDay: number;
}

export function getCentralClock(now = new Date(), timeZone = 'America/Chicago'): CentralClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = Number(map.hour === '24' ? '0' : map.hour);
  const minute = Number(map.minute);
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    weekday: map.weekday,
    minutesOfDay: hour * 60 + minute,
  };
}

function parseHHMMMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return (Number.isFinite(h) ? h : 18) * 60 + (Number.isFinite(m) ? m : 30);
}

/**
 * Advances Man Night weekly workflow based on Central Time rules:
 * - Sun >= 10:00: open night poll for upcoming week
 * - Mon >= 12:00: lock night (Tuesday wins ties)
 * - Dinner day >= 12:00: if no place picked, trigger 4-place noon rule (skip last 8 weeks)
 * - Dinner day >= 16:00: close noon vote, lock winner (random tiebreak), update GCal + push
 * - Dinner day >= (start_time - 30m): push reminder with Google Maps directions link
 * - Dinner day >= (start_time + 150m) or past date: mark completed
 */
export async function runWeeklyCronTick(env: Env, now = new Date()): Promise<{ actions: string[] }> {
  const clock = getCentralClock(now, env.CLUB_TIMEZONE || 'America/Chicago');
  const actions: string[] = [];

  await ensureNextScheduledDinner(env.DB);

  // 1. Promote scheduled week on Sunday >= 10:00 CT
  if (clock.weekday === 'Sunday' && clock.minutesOfDay >= 10 * 60) {
    const nextScheduled = await env.DB.prepare(
      `SELECT * FROM dinners
       WHERE is_historical = 0 AND status = 'scheduled' AND dinner_date > ?
       ORDER BY dinner_date ASC LIMIT 1`,
    )
      .bind(clock.dateStr)
      .first<DinnerRow>();

    if (nextScheduled && nextScheduled.night_poll_opened_at === null) {
      // Only promote if within 4 days (this week's Tuesday/Wednesday)
      const diffDays =
        (Date.parse(nextScheduled.dinner_date + 'T00:00:00Z') - Date.parse(clock.dateStr + 'T00:00:00Z')) /
        86400000;
      if (diffDays <= 4) {
        await env.DB.prepare(
          `UPDATE dinners
           SET status = 'night_poll',
               night_poll_opened_at = COALESCE(night_poll_opened_at, datetime('now')),
               updated_at = datetime('now')
           WHERE id = ?`,
        )
          .bind(nextScheduled.id)
          .run();

        await sendWebPushToSubscribers(
          env,
          {
            title: `This week: ${nextScheduled.host_label}'s pick — vote Tuesday or Wednesday`,
            body: 'Tuesday is listed first and wins ties at Monday noon.',
            tag: `night-open-${nextScheduled.id}`,
            url: env.APP_URL,
            dinnerId: nextScheduled.id,
          },
          'notify_night_vote',
        );
        actions.push(`opened_night_poll:${nextScheduled.week_key}`);
      }
    }
  }

  // Inspect active non-completed dinners
  const activeList = (
    await env.DB.prepare(
      `SELECT * FROM dinners
       WHERE is_historical = 0 AND status IN ('night_poll', 'awaiting_pick', 'noon_vote', 'place_locked')
       ORDER BY dinner_date ASC`,
    ).all<DinnerRow>()
  ).results ?? [];

  for (const dinner of activeList) {
    // 2. Monday >= 12:00 CT (or later in week): lock night poll
    if (
      dinner.status === 'night_poll' &&
      ((clock.weekday === 'Monday' && clock.minutesOfDay >= 12 * 60) ||
        clock.dateStr >= dinner.dinner_date)
    ) {
      await lockNight(env, dinner.id);
      actions.push(`locked_night:${dinner.week_key}`);
    }

    // Refresh row state in case step 2 changed status/date
    const fresh = await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinner.id).first<DinnerRow>();
    if (!fresh) continue;

    // 3. Dinner day >= 12:00 CT: Noon rule if still unpicked
    if (
      fresh.status === 'awaiting_pick' &&
      !fresh.restaurant_id &&
      (clock.dateStr > fresh.dinner_date ||
        (clock.dateStr === fresh.dinner_date && clock.minutesOfDay >= 12 * 60))
    ) {
      await openNoonDraw(env, fresh.id);
      actions.push(`opened_noon_draw:${fresh.week_key}`);
    }

    // 4. Dinner day >= 16:00 CT: Close noon vote
    if (
      fresh.status === 'noon_vote' &&
      (clock.dateStr > fresh.dinner_date ||
        (clock.dateStr === fresh.dinner_date && clock.minutesOfDay >= 16 * 60))
    ) {
      await closeNoonVote(env, fresh.id);
      actions.push(`closed_noon_vote:${fresh.week_key}`);
    }

    // Refresh again before reminder/completion
    const postPick = await env.DB.prepare('SELECT * FROM dinners WHERE id = ?').bind(dinner.id).first<DinnerRow>();
    if (!postPick) continue;

    const startMin = parseHHMMMinutes(postPick.start_time || '18:30');

    // 5. 30 minutes before dinner: push reminder carrying Google Maps URL
    if (
      postPick.status === 'place_locked' &&
      postPick.restaurant_id &&
      !postPick.reminder_sent_at &&
      clock.dateStr === postPick.dinner_date &&
      clock.minutesOfDay >= startMin - 30 &&
      clock.minutesOfDay < startMin + 90
    ) {
      const place = await env.DB.prepare('SELECT * FROM restaurants WHERE id = ?')
        .bind(postPick.restaurant_id)
        .first<RestaurantRow>();
      if (place) {
        const mapsUrl = buildDirectionsUrl(place);
        await sendWebPushToSubscribers(
          env,
          {
            title: `Dinner in 30 min — ${place.name}`,
            body: `${place.address || place.name} · Tap for Google Maps directions`,
            tag: `reminder-${postPick.id}`,
            url: mapsUrl,
            actions: [
              { action: 'directions', title: 'Directions' },
              { action: 'late', title: 'Running late' },
            ],
            dinnerId: postPick.id,
          },
          'notify_reminder',
        );
        await env.DB.prepare("UPDATE dinners SET reminder_sent_at = datetime('now') WHERE id = ?")
          .bind(postPick.id)
          .run();
        actions.push(`sent_reminder:${postPick.week_key}`);
      }
    }

    // 6. Post-dinner completion (>= start + 2.5h or past date)
    if (
      postPick.status !== 'completed' &&
      (clock.dateStr > postPick.dinner_date ||
        (clock.dateStr === postPick.dinner_date && clock.minutesOfDay >= startMin + 150))
    ) {
      await completeDinner(env.DB, postPick.id);
      actions.push(`completed:${postPick.week_key}`);
    }
  }

  return { actions };
}
