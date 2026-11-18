import type { DinnerRow, Env, RestaurantRow } from './types';

interface CachedGcalToken {
  token: string;
  expiresAt: number;
  email: string;
}

interface GcalEventItem {
  id: string;
  summary?: string;
  status?: string;
  location?: string;
  description?: string;
  start?: { dateTime?: string; date?: string };
}

let cachedToken: CachedGcalToken | null = null;

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const normalized = pem.replace(/\\n/g, '\n');
  const body = normalized
    .replace(/-----BEGIN [A-Z ]+-----/g, '')
    .replace(/-----END [A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function bytesToB64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getGoogleCalendarToken(env: Env): Promise<{ token?: string; errorReason?: string }> {
  const email = env.GCAL_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = env.GCAL_PRIVATE_KEY?.trim();
  if (!email || !privateKey) {
    return { errorReason: 'service_account_unconfigured' };
  }
  if (cachedToken && cachedToken.email === email && Date.now() < cachedToken.expiresAt) {
    return { token: cachedToken.token };
  }

  try {
    const now = Math.floor(Date.now() / 1000);
    const enc = new TextEncoder();
    const header = bytesToB64Url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
    const claim = bytesToB64Url(
      enc.encode(
        JSON.stringify({
          iss: email,
          scope: 'https://www.googleapis.com/auth/calendar.events',
          aud: 'https://oauth2.googleapis.com/token',
          exp: now + 3600,
          iat: now,
        }),
      ),
    );
    const unsigned = `${header}.${claim}`;
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToArrayBuffer(privateKey),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned)));
    const assertion = `${unsigned}.${bytesToB64Url(sig)}`;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!resp.ok) {
      return { errorReason: `oauth_token_${resp.status}` };
    }
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      return { errorReason: 'oauth_token_missing' };
    }
    cachedToken = {
      token: data.access_token,
      email,
      expiresAt: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000,
    };
    return { token: data.access_token };
  } catch (err) {
    return { errorReason: err instanceof Error ? `oauth_error:${err.message}` : 'oauth_token_error' };
  }
}

export function buildDirectionsUrl(restaurant: Pick<RestaurantRow, 'name' | 'address' | 'google_place_id'>): string {
  const dest = restaurant.address || restaurant.name;
  const params = new URLSearchParams({ api: '1', destination: dest });
  if (restaurant.google_place_id) {
    params.set('destination_place_id', restaurant.google_place_id);
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function formatPossessiveHost(hostLabel: string): string {
  const cleanHost = (hostLabel || 'Host').replace(/['’]s?$/i, '').trim();
  return cleanHost.endsWith('s') ? `${cleanHost}'` : `${cleanHost}'s`;
}

export function formatHostCalendarSummary(hostLabel: string): string {
  return `Man Night @ ${formatPossessiveHost(hostLabel)}`;
}

export function formatCalendarSummary(hostLabel: string, placeName: string): string {
  return `${formatHostCalendarSummary(hostLabel)}. Dinner @ ${placeName}`;
}

function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function computeEventWindow(dinnerDate: string, startTime: string): { startDT: string; endDT: string } {
  const raw = startTime || '18:30';
  const [rawH, rawM] = raw.split(':').map((n) => parseInt(n, 10));
  const h = Number.isFinite(rawH) && rawH >= 0 && rawH <= 23 ? rawH : 18;
  const m = Number.isFinite(rawM) && rawM >= 0 && rawM <= 59 ? rawM : 30;
  const totalEndMin = h * 60 + m + 120;
  const dayOffset = Math.floor(totalEndMin / 1440);
  const endMin = totalEndMin % 1440;
  const endH = Math.floor(endMin / 60);
  const endM = endMin % 60;
  const endDate = dayOffset > 0 ? addDaysIso(dinnerDate, dayOffset) : dinnerDate;
  return {
    startDT: `${dinnerDate}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`,
    endDT: `${endDate}T${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}:00`,
  };
}

function getCentralDateFromEventStart(
  start: { dateTime?: string; date?: string } | undefined,
  timeZone = 'America/Chicago',
): string | null {
  if (!start) return null;
  if (start.date) return start.date;
  if (!start.dateTime) return null;
  const dt = new Date(start.dateTime);
  if (Number.isNaN(dt.getTime())) return start.dateTime.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(dt);
  const map: Record<string, string> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  return `${map.year}-${map.month}-${map.day}`;
}

function getWeekSearchBounds(dinner: Pick<DinnerRow, 'dinner_date' | 'day_of_week'>): {
  altDate: string | null;
  timeMin: string;
  timeMax: string;
} {
  let altDate: string | null = null;
  if (dinner.day_of_week === 'Wednesday') {
    altDate = addDaysIso(dinner.dinner_date, -1);
  } else if (dinner.day_of_week === 'Tuesday') {
    altDate = addDaysIso(dinner.dinner_date, 1);
  }
  const startDate = altDate && altDate < dinner.dinner_date ? altDate : dinner.dinner_date;
  const endDate = altDate && altDate > dinner.dinner_date ? altDate : dinner.dinner_date;
  return {
    altDate,
    timeMin: encodeURIComponent(`${addDaysIso(startDate, -1)}T18:00:00Z`),
    timeMax: encodeURIComponent(`${addDaysIso(endDate, 1)}T12:00:00Z`),
  };
}

async function findCalendarEventForDinner(
  env: Env,
  token: string,
  dinner: Pick<DinnerRow, 'dinner_date' | 'day_of_week' | 'host_label' | 'gcal_event_id'>,
): Promise<{ event?: GcalEventItem; errorReason?: string }> {
  const calendarId = encodeURIComponent(env.GCAL_CALENDAR_ID);
  const tz = env.CLUB_TIMEZONE || 'America/Chicago';

  if (dinner.gcal_event_id) {
    const directResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(dinner.gcal_event_id)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (directResp.ok) {
      const directEvent = (await directResp.json()) as GcalEventItem;
      if (directEvent.id && directEvent.status !== 'cancelled') {
        return { event: directEvent };
      }
    }
  }

  const { altDate, timeMin, timeMax } = getWeekSearchBounds(dinner);
  const listUrl = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true`;

  const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!listResp.ok) {
    return { errorReason: `calendar_list_${listResp.status}` };
  }
  const listData = (await listResp.json()) as { items?: GcalEventItem[] };
  const items = (listData.items ?? []).filter((e) => e.status !== 'cancelled');
  const hostFirst = dinner.host_label.split(/\s+/)[0].replace(/[^a-z]/gi, '').toLowerCase();

  const isManNight = (e: GcalEventItem) => (e.summary ?? '').toLowerCase().includes('man night');
  const isHostMatch = (e: GcalEventItem) => Boolean(hostFirst && (e.summary ?? '').toLowerCase().includes(hostFirst));
  const eventDate = (e: GcalEventItem) => getCentralDateFromEventStart(e.start, tz);

  const match =
    (dinner.gcal_event_id ? items.find((e) => e.id === dinner.gcal_event_id) : undefined) ||
    items.find((e) => eventDate(e) === dinner.dinner_date && isManNight(e) && isHostMatch(e)) ||
    items.find((e) => eventDate(e) === dinner.dinner_date && isManNight(e)) ||
    (altDate ? items.find((e) => eventDate(e) === altDate && isManNight(e) && isHostMatch(e)) : undefined) ||
    (altDate ? items.find((e) => eventDate(e) === altDate && isManNight(e)) : undefined);

  return { event: match };
}

export interface CalendarSyncOptions {
  note?: string;
  createIfMissing?: boolean;
  cancelledByName?: string;
  cancelReason?: string;
}

/**
 * Synchronizes a Man Night dinner row (date, time, host, restaurant, or cancellation)
 * to the shared Google Calendar event, locating the existing instance across Tue/Wed
 * night shifts so recurring calendar events are updated in place instead of duplicated.
 */
export async function syncDinnerToCalendar(
  env: Env,
  dinner: DinnerRow,
  restaurant: RestaurantRow | null,
  options: CalendarSyncOptions = {},
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  const auth = await getGoogleCalendarToken(env);
  if (!auth.token) {
    return { synced: false, reason: auth.errorReason || 'service_account_unconfigured' };
  }

  const calendarId = encodeURIComponent(env.GCAL_CALENDAR_ID);
  const tz = env.CLUB_TIMEZONE || 'America/Chicago';

  try {
    const found = await findCalendarEventForDinner(env, auth.token, dinner);
    if (found.errorReason) {
      return { synced: false, reason: found.errorReason };
    }

    if (dinner.status === 'cancelled') {
      if (!found.event) {
        return { synced: false, reason: 'no_matching_event' };
      }
      const baseSummary = (found.event.summary || formatHostCalendarSummary(dinner.host_label)).replace(
        /^\[CANCELLED\]\s*/i,
        '',
      );
      const summary = `[CANCELLED] ${baseSummary}`;
      const actor = options.cancelledByName || dinner.cancelled_by || 'Crew';
      const reasonText = options.cancelReason ?? dinner.cancel_reason ?? '';
      const description = `Man Night cancelled by ${actor}${reasonText ? `: ${reasonText}` : ''}.\n\nApp: ${env.APP_URL}`;

      const patchResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(found.event.id)}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ summary, description }),
        },
      );
      if (!patchResp.ok) return { synced: false, reason: `calendar_patch_${patchResp.status}` };
      return { synced: true, eventId: found.event.id };
    }

    const summary = restaurant
      ? formatCalendarSummary(dinner.host_label, restaurant.name)
      : formatHostCalendarSummary(dinner.host_label);
    const location = restaurant ? restaurant.address || restaurant.name : '';
    const note = (options.note || '').trim();
    const descriptionParts: string[] = [];
    if (note) descriptionParts.push(note);
    if (restaurant) {
      descriptionParts.push(`Directions: ${buildDirectionsUrl(restaurant)}`);
    }
    descriptionParts.push(`App: ${env.APP_URL}`);
    const description = descriptionParts.join('\n\n');

    const { startDT, endDT } = computeEventWindow(dinner.dinner_date, dinner.start_time || '18:30');
    const payload = {
      summary,
      location,
      description,
      start: { dateTime: startDT, timeZone: tz },
      end: { dateTime: endDT, timeZone: tz },
    };

    if (found.event) {
      const patchResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(found.event.id)}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      if (!patchResp.ok) return { synced: false, reason: `calendar_patch_${patchResp.status}` };
      return { synced: true, eventId: found.event.id };
    }

    const shouldCreate = options.createIfMissing ?? Boolean(restaurant);
    if (!shouldCreate) {
      return { synced: false, reason: 'no_matching_event' };
    }

    const createResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${auth.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!createResp.ok) return { synced: false, reason: `calendar_create_${createResp.status}` };
    const created = (await createResp.json()) as { id: string };
    return { synced: true, eventId: created.id };
  } catch (err) {
    return { synced: false, reason: err instanceof Error ? err.message : 'calendar_error' };
  }
}

export async function syncLockedPlaceToCalendar(
  env: Env,
  dinner: DinnerRow,
  restaurant: RestaurantRow,
  note: string,
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  return syncDinnerToCalendar(env, dinner, restaurant, { note, createIfMissing: true });
}

export async function syncCancelledNightToCalendar(
  env: Env,
  dinner: DinnerRow,
  cancelledByName: string,
  reason: string,
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  return syncDinnerToCalendar(
    env,
    { ...dinner, status: 'cancelled' },
    null,
    { cancelledByName, cancelReason: reason, createIfMissing: false },
  );
}

export async function restoreCalendarForNight(
  env: Env,
  dinner: DinnerRow,
  restaurant: RestaurantRow | null = null,
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  return syncDinnerToCalendar(env, dinner, restaurant, { createIfMissing: Boolean(restaurant) });
}

export async function syncStartTimeToCalendar(
  env: Env,
  dinner: DinnerRow,
  restaurant: RestaurantRow | null = null,
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  return syncDinnerToCalendar(env, dinner, restaurant, {
    createIfMissing: Boolean(restaurant) || dinner.status !== 'scheduled',
  });
}
