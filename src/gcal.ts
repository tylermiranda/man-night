import type { DinnerRow, Env, RestaurantRow } from './types';

let cachedToken: { token: string; expiresAt: number } | null = null;

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

async function getGoogleCalendarToken(env: Env): Promise<string | null> {
  if (!env.GCAL_SERVICE_ACCOUNT_EMAIL || !env.GCAL_PRIVATE_KEY) return null;
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;

  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = bytesToB64Url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = bytesToB64Url(
    enc.encode(
      JSON.stringify({
        iss: env.GCAL_SERVICE_ACCOUNT_EMAIL,
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
    pemToArrayBuffer(env.GCAL_PRIVATE_KEY),
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
  if (!resp.ok) return null;
  const data = (await resp.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) return null;
  cachedToken = { token: data.access_token, expiresAt: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000 };
  return data.access_token;
}

export function buildDirectionsUrl(restaurant: Pick<RestaurantRow, 'name' | 'address' | 'google_place_id'>): string {
  const dest = restaurant.address || restaurant.name;
  const params = new URLSearchParams({ api: '1', destination: dest });
  if (restaurant.google_place_id) {
    params.set('destination_place_id', restaurant.google_place_id);
  }
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

export function formatCalendarSummary(hostLabel: string, placeName: string): string {
  const cleanHost = hostLabel.replace(/['’]s?$/i, '').trim();
  const possessive = cleanHost.endsWith('s') ? `${cleanHost}'` : `${cleanHost}'s`;
  return `Man Night @ ${possessive}. Dinner @ ${placeName}`;
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

async function findCalendarEventForDinner(
  env: Env,
  token: string,
  dinner: DinnerRow,
): Promise<{ event?: { id: string; summary?: string }; errorReason?: string }> {
  const calendarId = encodeURIComponent(env.GCAL_CALENDAR_ID);
  const timeMin = encodeURIComponent(`${dinner.dinner_date}T00:00:00-06:00`);
  const timeMax = encodeURIComponent(`${dinner.dinner_date}T23:59:59-05:00`);
  const listUrl = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true`;

  const listResp = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  if (!listResp.ok) {
    return { errorReason: `calendar_list_${listResp.status}` };
  }
  const listData = (await listResp.json()) as {
    items?: Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string } }>;
  };
  const items = listData.items ?? [];
  const hostFirst = dinner.host_label.split(/\s+/)[0].replace(/[^a-z]/gi, '').toLowerCase();
  const match =
    (dinner.gcal_event_id ? items.find((e) => e.id === dinner.gcal_event_id) : undefined) ||
    items.find((e) => {
      const s = (e.summary ?? '').toLowerCase();
      return s.includes('man night') && (!hostFirst || s.includes(hostFirst));
    }) ||
    items.find((e) => (e.summary ?? '').toLowerCase().includes('man night'));

  return { event: match };
}

export async function syncLockedPlaceToCalendar(
  env: Env,
  dinner: DinnerRow,
  restaurant: RestaurantRow,
  note: string,
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  const token = await getGoogleCalendarToken(env);
  if (!token) {
    return { synced: false, reason: 'service_account_unconfigured' };
  }
  const calendarId = encodeURIComponent(env.GCAL_CALENDAR_ID);
  const summary = formatCalendarSummary(dinner.host_label, restaurant.name);
  const location = restaurant.address || restaurant.name;
  const mapsUrl = buildDirectionsUrl(restaurant);
  const description = `${note}\n\nDirections: ${mapsUrl}\nApp: ${env.APP_URL}`;

  try {
    const found = await findCalendarEventForDinner(env, token, dinner);
    if (found.errorReason) {
      return { synced: false, reason: found.errorReason };
    }

    const tz = env.CLUB_TIMEZONE || 'America/Chicago';
    const { startDT, endDT } = computeEventWindow(dinner.dinner_date, dinner.start_time || '18:30');

    if (found.event) {
      const patchResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(found.event.id)}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            summary,
            location,
            description,
            start: { dateTime: startDT, timeZone: tz },
            end: { dateTime: endDT, timeZone: tz },
          }),
        },
      );
      if (!patchResp.ok) return { synced: false, reason: `calendar_patch_${patchResp.status}` };
      return { synced: true, eventId: found.event.id };
    }

    const createResp = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        location,
        description,
        start: { dateTime: startDT, timeZone: tz },
        end: { dateTime: endDT, timeZone: tz },
      }),
    });
    if (!createResp.ok) return { synced: false, reason: `calendar_create_${createResp.status}` };
    const created = (await createResp.json()) as { id: string };
    return { synced: true, eventId: created.id };
  } catch (err) {
    return { synced: false, reason: err instanceof Error ? err.message : 'calendar_error' };
  }
}

export async function syncCancelledNightToCalendar(
  env: Env,
  dinner: DinnerRow,
  cancelledByName: string,
  reason: string,
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  const token = await getGoogleCalendarToken(env);
  if (!token) {
    return { synced: false, reason: 'service_account_unconfigured' };
  }
  const calendarId = encodeURIComponent(env.GCAL_CALENDAR_ID);
  try {
    const found = await findCalendarEventForDinner(env, token, dinner);
    if (found.errorReason) {
      return { synced: false, reason: found.errorReason };
    }
    if (!found.event) {
      return { synced: false, reason: 'no_matching_event' };
    }
    const baseSummary = (found.event.summary || `Man Night @ ${dinner.host_label}'s`).replace(/^\[CANCELLED\]\s*/i, '');
    const summary = `[CANCELLED] ${baseSummary}`;
    const description = `Man Night cancelled by ${cancelledByName}${reason ? `: ${reason}` : ''}.\n\nApp: ${env.APP_URL}`;

    const patchResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(found.event.id)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary, description }),
      },
    );
    if (!patchResp.ok) return { synced: false, reason: `calendar_patch_${patchResp.status}` };
    return { synced: true, eventId: found.event.id };
  } catch (err) {
    return { synced: false, reason: err instanceof Error ? err.message : 'calendar_error' };
  }
}

export async function restoreCalendarForNight(
  env: Env,
  dinner: DinnerRow,
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  const token = await getGoogleCalendarToken(env);
  if (!token) {
    return { synced: false, reason: 'service_account_unconfigured' };
  }
  const calendarId = encodeURIComponent(env.GCAL_CALENDAR_ID);
  try {
    const found = await findCalendarEventForDinner(env, token, dinner);
    if (found.errorReason) {
      return { synced: false, reason: found.errorReason };
    }
    if (!found.event) {
      return { synced: false, reason: 'no_matching_event' };
    }
    const cleanSummary = (found.event.summary || `Man Night @ ${dinner.host_label}'s`).replace(/^\[CANCELLED\]\s*/i, '');
    const description = `App: ${env.APP_URL}`;

    const patchResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(found.event.id)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ summary: cleanSummary, description }),
      },
    );
    if (!patchResp.ok) return { synced: false, reason: `calendar_patch_${patchResp.status}` };
    return { synced: true, eventId: found.event.id };
  } catch (err) {
    return { synced: false, reason: err instanceof Error ? err.message : 'calendar_error' };
  }
}

export async function syncStartTimeToCalendar(
  env: Env,
  dinner: DinnerRow,
): Promise<{ synced: boolean; eventId?: string; reason?: string }> {
  const token = await getGoogleCalendarToken(env);
  if (!token) {
    return { synced: false, reason: 'service_account_unconfigured' };
  }
  const calendarId = encodeURIComponent(env.GCAL_CALENDAR_ID);
  try {
    const found = await findCalendarEventForDinner(env, token, dinner);
    if (found.errorReason) {
      return { synced: false, reason: found.errorReason };
    }
    if (!found.event) {
      return { synced: false, reason: 'no_matching_event' };
    }
    const tz = env.CLUB_TIMEZONE || 'America/Chicago';
    const { startDT, endDT } = computeEventWindow(dinner.dinner_date, dinner.start_time || '18:30');
    const patchResp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(found.event.id)}`,
      {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: { dateTime: startDT, timeZone: tz },
          end: { dateTime: endDT, timeZone: tz },
        }),
      },
    );
    if (!patchResp.ok) return { synced: false, reason: `calendar_patch_${patchResp.status}` };
    return { synced: true, eventId: found.event.id };
  } catch (err) {
    return { synced: false, reason: err instanceof Error ? err.message : 'calendar_error' };
  }
}
