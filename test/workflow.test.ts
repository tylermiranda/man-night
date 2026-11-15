import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWeeklyCronTick } from '../src/cron';
import { buildDirectionsUrl, formatCalendarSummary } from '../src/gcal';
import worker from '../src/index';
import { createVapidAuthHeader, encryptWebPushPayload } from '../src/push';
import type { Env } from '../src/types';
import { addDaysToIsoDate, drawFourRandomPlaces } from '../src/workflow';
import { createTestD1 } from './d1-shim';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const schemaSql = readFileSync(resolve(rootDir, 'migrations/0001_schema.sql'), 'utf8');
const seedSql = readFileSync(resolve(rootDir, 'migrations/0002_seed_history.sql'), 'utf8');
const migration0003Sql = readFileSync(resolve(rootDir, 'migrations/0003_ratings_indexes.sql'), 'utf8');
const migration0004Sql = readFileSync(resolve(rootDir, 'migrations/0004_fix_future_visit_dates.sql'), 'utf8');

function makeEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    ASSETS: { fetch: async () => new Response('ok', { status: 200 }) } as unknown as Fetcher,
    APP_URL: 'https://dinner.tylermiranda.com',
    CLUB_TIMEZONE: 'America/Chicago',
    GCAL_CALENDAR_ID: 'cqubssbfpc3ofjf3anej422tec@group.calendar.google.com',
    GITHUB_REPO: 'tylermiranda/man-night',
    ...overrides,
  };
}

function makeReq(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://dinner.tylermiranda.com${path}`, {
    method,
    headers: {
      'Cf-Access-Authenticated-User-Email': 'tyler.miranda@gmail.com',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('Man Night PWA Worker & Seed', () => {
  let env: Env;

  beforeEach(async () => {
    const db = createTestD1(schemaSql, seedSql);
    await db.exec(migration0003Sql);
    await db.exec(migration0004Sql);
    env = makeEnv(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seeds exact historical ledger counts and upcoming rotation queue', async () => {
    const res = await worker.fetch(makeReq('/api/bootstrap'), env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      stats: { total_dinners: number; total_places: number };
      thisWeek: { dinner: { week_key: string; host_slug: string; status: string } };
      upcoming: Array<{ host_slug: string; dinner_date: string }>;
      recentDinners: Array<{ dinner_date: string; restaurant_name: string | null; restaurant_address: string | null }>;
    };

    expect(data.stats.total_dinners).toBe(614);
    expect(data.stats.total_places).toBe(225);
    expect(data.thisWeek.dinner.week_key).toBe('2026-W47');
    expect(data.thisWeek.dinner.host_slug).toBe('eric');
    expect(data.thisWeek.dinner.status).toBe('night_poll');
    expect(data.upcoming[0].host_slug).toBe('tyler');
    expect(data.upcoming[1].host_slug).toBe('heath');
    expect(data.recentDinners[0].dinner_date).toBe('2026-11-10');
    expect(data.recentDinners[0].restaurant_name).toBe('El Mexico Cafe');
    expect(data.recentDinners[0].restaurant_address).toContain('2544 S Seneca St');
  });

  it('blocks unauthenticated requests on production host and prevents dev-header spoofing', async () => {
    const spoofReq = new Request('https://dinner.tylermiranda.com/api/bootstrap', {
      headers: { 'X-Dev-User': 'eric' },
    });
    const res = await worker.fetch(spoofReq, env);
    expect(res.status).toBe(403);

    // Service token JWT forwarding common_name (<id>.access) resolves cleanly
    const payload = btoa(JSON.stringify({ type: 'app', common_name: 'abc123.access' }))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const stReq = new Request('https://dinner.tylermiranda.com/api/bootstrap', {
      headers: { 'Cf-Access-Jwt-Assertion': `h.${payload}.s` },
    });
    const stRes = await worker.fetch(stReq, env);
    expect(stRes.status).toBe(200);
  });

  it('runs Tuesday-first night vote with Monday noon tie-breaking to Tuesday', async () => {
    // Eric votes Wednesday, Tyler votes Tuesday -> 1-1 tie -> Tuesday wins!
    await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'wednesday' }, { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' }),
      env,
    );
    await worker.fetch(makeReq('/api/week/vote-night', 'POST', { choice: 'tuesday' }), env);

    // Monday 2026-11-16 at 12:05 PM CST (18:05 UTC)
    const tick = await runWeeklyCronTick(env, new Date('2026-11-16T18:05:00Z'));
    expect(tick.actions).toContain('locked_night:2026-W47');

    const boot = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { day_of_week: string; dinner_date: string; status: string } };
    };
    expect(boot.thisWeek.dinner.day_of_week).toBe('Tuesday');
    expect(boot.thisWeek.dinner.dinner_date).toBe('2026-11-17');
    expect(boot.thisWeek.dinner.status).toBe('awaiting_pick');
  });

  it('flips dinner_date to Wednesday when Wednesday wins night vote', async () => {
    await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'wednesday' }, { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' }),
      env,
    );
    await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'wednesday' }, { 'Cf-Access-Authenticated-User-Email': 'bigheadwillie@gmail.com' }),
      env,
    );

    await runWeeklyCronTick(env, new Date('2026-11-16T18:05:00Z'));

    const boot = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { day_of_week: string; dinner_date: string } };
    };
    expect(boot.thisWeek.dinner.day_of_week).toBe('Wednesday');
    expect(boot.thisWeek.dinner.dinner_date).toBe('2026-11-18');
  });

  it('enforces Noon Rule: draws 4 places skipping last 8 weeks, then locks at 4 PM with random tiebreak', async () => {
    // Advance Monday noon -> awaiting_pick
    await runWeeklyCronTick(env, new Date('2026-11-16T18:05:00Z'));

    // Find places visited within 8 weeks of 2026-11-17
    const cutoff = addDaysToIsoDate('2026-11-17', -56);
    const draw = await drawFourRandomPlaces(env.DB, '2026-11-17');
    expect(draw.length).toBe(4);
    for (const p of draw) {
      expect(!p.last_visited || p.last_visited < cutoff).toBe(true);
    }

    // Tuesday 2026-11-17 at 12:05 PM CST (18:05 UTC) opens noon draw
    const noonTick = await runWeeklyCronTick(env, new Date('2026-11-17T18:05:00Z'));
    expect(noonTick.actions).toContain('opened_noon_draw:2026-W47');

    const boot1 = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number; status: string }; noonCandidates: Array<{ id: number; name: string }> };
    };
    expect(boot1.thisWeek.dinner.status).toBe('noon_vote');
    expect(boot1.thisWeek.noonCandidates).toHaveLength(4);

    // Cast tied votes for candidates 0 and 1
    const c0 = boot1.thisWeek.noonCandidates[0].id;
    const c1 = boot1.thisWeek.noonCandidates[1].id;
    await worker.fetch(makeReq('/api/week/vote-noon', 'POST', { restaurantId: c0 }), env);
    await worker.fetch(
      makeReq('/api/week/vote-noon', 'POST', { restaurantId: c1 }, { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' }),
      env,
    );

    // Tuesday 2026-11-17 at 4:05 PM CST (22:05 UTC) closes noon vote
    const closeTick = await runWeeklyCronTick(env, new Date('2026-11-17T22:05:00Z'));
    expect(closeTick.actions).toContain('closed_noon_vote:2026-W47');

    const boot2 = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { status: string; chosen_via: string; restaurant_id: number } };
    };
    expect(boot2.thisWeek.dinner.status).toBe('place_locked');
    expect(boot2.thisWeek.dinner.chosen_via).toBe('noon_draw');
    expect([c0, c1]).toContain(boot2.thisWeek.dinner.restaurant_id);
  });

  it('supports RSVP, ratings, history backfill, and pass/swap rotation', async () => {
    // RSVP
    const rsvpRes = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { status: 'late', etaMinutes: 15 }),
      env,
    );
    expect(rsvpRes.status).toBe(200);

    // Pass Eric's turn -> Tyler becomes host
    const rotRes = await worker.fetch(makeReq('/api/week/rotation', 'POST', { action: 'pass' }), env);
    expect(rotRes.status).toBe(200);
    const rotData = (await rotRes.json()) as { dinner: { host_slug: string } };
    expect(rotData.dinner.host_slug).toBe('tyler');

    // Backfill an unplaced historical dinner
    const missing = await env.DB.prepare(
      "SELECT id FROM dinners WHERE status = 'completed' AND restaurant_id IS NULL LIMIT 1",
    ).first<{ id: number }>();
    expect(missing).toBeTruthy();
    const bfRes = await worker.fetch(
      makeReq(`/api/dinners/${missing!.id}/backfill`, 'POST', { restaurantId: 1 }),
      env,
    );
    expect(bfRes.status).toBe(200);

    // Submit 5-star rating on last dinner
    const rateRes = await worker.fetch(
      makeReq('/api/week/rate', 'POST', { dinnerId: missing!.id, score: 5, dish: 'Tacos al Pastor' }),
      env,
    );
    expect(rateRes.status).toBe(200);
  });

  it('formats Google Calendar summaries & Google Maps reminder links cleanly', () => {
    expect(formatCalendarSummary('Eric', 'Poplar')).toBe("Man Night @ Eric's. Dinner @ Poplar");
    expect(formatCalendarSummary('Charles', 'Deano’s')).toBe("Man Night @ Charles'. Dinner @ Deano’s");
    const url = buildDirectionsUrl({
      name: 'Poplar',
      address: 'Poplar Restaurant, 127 US-54, Andover, KS 67002, USA',
      google_place_id: 'ChIJ_test123',
    });
    expect(url).toContain('https://www.google.com/maps/dir/?api=1');
    expect(url).toContain('destination_place_id=ChIJ_test123');
  });

  it('encrypts Web Push RFC8291 payloads and signs ES256 VAPID headers', async () => {
    const kp = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
    const uaPub = new Uint8Array((await crypto.subtle.exportKey('raw', kp.publicKey)) as ArrayBuffer);
    const uaAuth = crypto.getRandomValues(new Uint8Array(16));
    const toB64u = (u: Uint8Array) =>
      btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const encrypted = await encryptWebPushPayload(
      JSON.stringify({ title: 'Dinner in 30 min' }),
      toB64u(uaPub),
      toB64u(uaAuth),
    );
    expect(encrypted.byteLength).toBeGreaterThan(86);

    const vapidPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const vapidJwk = (await crypto.subtle.exportKey('jwk', vapidPair.privateKey)) as JsonWebKey;
    const vapidPubRaw = new Uint8Array((await crypto.subtle.exportKey('raw', vapidPair.publicKey)) as ArrayBuffer);
    const authHeader = await createVapidAuthHeader(
      'https://web.push.apple.com/QTestEndpoint',
      'mailto:tyler.miranda@gmail.com',
      toB64u(vapidPubRaw),
      vapidJwk.d!,
    );
    expect(authHeader.startsWith('vapid t=')).toBe(true);
    expect(authHeader).toContain(', k=');
  });

  it('creates GitHub issues via /api/issues with proper labels, reporter metadata, and signed OpenBot webhook', async () => {
    env.GITHUB_TOKEN = 'ghp_test_token';
    env.OPENBOT_WEBHOOK_URL = 'https://signal.openbot.run/v1/webhooks/d91a1bad-eadf-44b9-9ee2-cefd7f37ac4f';
    env.OPENBOT_WEBHOOK_SECRET = 'whsec_dGVzdGtleTEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU=';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://signal.openbot.run/')) {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({ number: 42, html_url: 'https://github.com/tylermiranda/man-night/issues/42' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const res = await worker.fetch(
      makeReq('/api/issues', 'POST', {
        title: 'Poplar missing suite',
        category: 'data',
        description: 'Need suite number check',
        pageContext: 'Tab: places',
      }),
      env,
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { issue: { github_issue_number: number; webhook_status: string } };
    expect(body.issue.github_issue_number).toBe(42);
    expect(body.issue.webhook_status).toBe('github_and_openbot_notified');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const callBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(callBody.labels).toContain('auto-fix');
    expect(callBody.labels).toContain('user-reported');

    const [whUrl, whInit] = fetchMock.mock.calls[1];
    expect(whUrl).toBe('https://signal.openbot.run/v1/webhooks/d91a1bad-eadf-44b9-9ee2-cefd7f37ac4f');
    const whHeaders = whInit?.headers as Record<string, string>;
    expect(whHeaders['webhook-id']).toMatch(/^msg_/);
    expect(whHeaders['webhook-timestamp']).toMatch(/^\d+$/);
    expect(whHeaders['webhook-signature']).toMatch(/^v1,/);
    const whPayload = JSON.parse(String(whInit?.body));
    expect(whPayload.type).toBe('man_night.issue_reported');
    expect(whPayload.occurredAt).toBeTruthy();
    expect(whPayload.data.issue_number).toBe(42);
    expect(whPayload.data.repo).toBe('tylermiranda/man-night');

    const listRes = await worker.fetch(makeReq('/api/issues'), env);
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      issues: Array<{ title: string; github_issue_number: number; webhook_status: string }>;
    };
    expect(listBody.issues.length).toBeGreaterThanOrEqual(1);
    expect(listBody.issues[0].title).toBe('Poplar missing suite');
    expect(listBody.issues[0].github_issue_number).toBe(42);
    expect(listBody.issues[0].webhook_status).toBe('github_and_openbot_notified');
  });

  it('lets host pick place and night in advance so voting and noon draw are skipped', async () => {
    const bootRes = await worker.fetch(makeReq('/api/bootstrap'), env);
    const boot = (await bootRes.json()) as {
      thisWeek: { dinner: { id: number; dinner_date: string } };
      upcoming: Array<{ id: number; dinner_date: string; day_of_week: string; host_slug: string }>;
    };
    const nextWeek = boot.upcoming[0];
    expect(nextWeek.host_slug).toBe('tyler');
    expect(nextWeek.dinner_date).toBe('2026-11-24');

    const poplar = await env.DB.prepare("SELECT id FROM restaurants WHERE name LIKE '%Poplar%' LIMIT 1").first<{ id: number }>();
    expect(poplar).toBeTruthy();

    // Pick Poplar in advance for Tyler's upcoming week on Wednesday (no vote)
    const pickRes = await worker.fetch(
      makeReq('/api/week/pick-place', 'POST', {
        dinnerId: nextWeek.id,
        restaurantId: poplar!.id,
        dayOfWeek: 'Wednesday',
      }),
      env,
    );
    expect(pickRes.status).toBe(200);
    const picked = (await pickRes.json()) as {
      ok: boolean;
      dinner: { status: string; day_of_week: string; dinner_date: string; night_locked_at: string | null; chosen_via: string };
    };
    expect(picked.dinner.status).toBe('place_locked');
    expect(picked.dinner.day_of_week).toBe('Wednesday');
    expect(picked.dinner.dinner_date).toBe('2026-11-25');
    expect(picked.dinner.night_locked_at).toBeTruthy();
    expect(picked.dinner.chosen_via).toBe('picker');

    // Earlier active week (Nov 17) must remain thisWeek on bootstrap
    const bootAfter = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number } };
    };
    expect(bootAfter.thisWeek.dinner.id).toBe(boot.thisWeek.dinner.id);

    // Running cron ticks on Sun 10:05 CT, Mon 12:05 CT, and Wed 12:05 CT of next week keeps status place_locked (no poll/noon draw)
    await runWeeklyCronTick(env, new Date('2026-11-22T16:05:00Z')); // Sun 10:05 CST
    await runWeeklyCronTick(env, new Date('2026-11-23T18:05:00Z')); // Mon 12:05 CST
    await runWeeklyCronTick(env, new Date('2026-11-25T18:05:00Z')); // Wed 12:05 CST
    const rowAfterCron = await env.DB.prepare('SELECT status, noon_draw_ids, night_poll_opened_at FROM dinners WHERE id = ?')
      .bind(nextWeek.id)
      .first<{ status: string; noon_draw_ids: string | null; night_poll_opened_at: string | null }>();
    expect(rowAfterCron?.status).toBe('place_locked');
    expect(rowAfterCron?.noon_draw_ids).toBeNull();
    expect(rowAfterCron?.night_poll_opened_at).toBeNull();
  });

  it('clears Cloudflare Access session cookies and redirects on /api/logout', async () => {
    const getRes = await worker.fetch(new Request('https://dinner.tylermiranda.com/api/logout', { method: 'GET' }), env);
    expect(getRes.status).toBe(302);
    expect(getRes.headers.get('Location')).toBe('https://dinner.tylermiranda.com/cdn-cgi/access/logout');
    const cookie = getRes.headers.get('Set-Cookie') || '';
    expect(cookie).toContain('CF_Authorization=;');

    const postRes = await worker.fetch(new Request('https://dinner.tylermiranda.com/api/logout', { method: 'POST' }), env);
    expect(postRes.status).toBe(200);
    const body = (await postRes.json()) as { ok: boolean; logoutUrl: string };
    expect(body.ok).toBe(true);
    expect(body.logoutUrl).toBe('/cdn-cgi/access/logout');
  });

  it('surfaces dinner and place reviews across bootstrap, places, history, and backfill', async () => {
    const bootBefore = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      recentDinners: Array<{ id: number; restaurant_id: number; restaurant_name: string }>;
    };
    const lastDinner = bootBefore.recentDinners[0];
    expect(lastDinner.id).toBe(614);
    expect(lastDinner.restaurant_id).toBe(7);
    expect(lastDinner.restaurant_name).toBe('El Mexico Cafe');

    // 1. Tyler reviews last week's completed dinner (El Mexico Cafe)
    const rateRes = await worker.fetch(
      makeReq('/api/week/rate', 'POST', {
        dinnerId: lastDinner.id,
        score: 5,
        dish: 'Street Tacos',
        comment: 'Great salsa and quick service.',
      }),
      env,
    );
    expect(rateRes.status).toBe(200);
    const rateData = (await rateRes.json()) as {
      ok: boolean;
      rating: { dinner_id: number; restaurant_id: number; score: number; dish: string; comment: string };
    };
    expect(rateData.ok).toBe(true);
    expect(rateData.rating.dinner_id).toBe(614);
    expect(rateData.rating.restaurant_id).toBe(7);

    // Bootstrap surfaces lastDinnerRatings and rating aggregates on recentDinners[0]
    const bootAfter = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      recentDinners: Array<{ id: number; rating_count: number; dinner_avg_rating: number; restaurant_avg_rating: number }>;
      lastDinnerRatings: Array<{ user_slug: string; user_name: string; score: number; dish: string; comment: string }>;
    };
    expect(bootAfter.lastDinnerRatings).toHaveLength(1);
    expect(bootAfter.lastDinnerRatings[0].user_slug).toBe('tyler');
    expect(bootAfter.lastDinnerRatings[0].user_name).toBe('Tyler');
    expect(bootAfter.lastDinnerRatings[0].score).toBe(5);
    expect(bootAfter.lastDinnerRatings[0].dish).toBe('Street Tacos');
    expect(bootAfter.lastDinnerRatings[0].comment).toBe('Great salsa and quick service.');
    expect(bootAfter.recentDinners[0].rating_count).toBe(1);
    expect(bootAfter.recentDinners[0].dinner_avg_rating).toBe(5);
    expect(bootAfter.recentDinners[0].restaurant_avg_rating).toBe(5);

    // 2. Multi-member rating + updating an existing rating recalculates avg_rating
    await worker.fetch(
      makeReq(
        '/api/week/rate',
        'POST',
        { dinnerId: lastDinner.id, score: 3, dish: 'Enchiladas', comment: 'Good but loud.' },
        { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' },
      ),
      env,
    );
    await worker.fetch(
      makeReq('/api/week/rate', 'POST', {
        dinnerId: lastDinner.id,
        score: 4,
        dish: 'Street Tacos',
        comment: 'Updated note.',
      }),
      env,
    );

    const placesRes = await worker.fetch(makeReq('/api/places?q=el%20mexico'), env);
    expect(placesRes.status).toBe(200);
    const placesData = (await placesRes.json()) as {
      places: Array<{ id: number; avg_rating: number; rating_count: number }>;
    };
    expect(placesData.places[0].id).toBe(7);
    expect(placesData.places[0].avg_rating).toBe(3.5);
    expect(placesData.places[0].rating_count).toBe(2);

    const placeRevRes = await worker.fetch(makeReq('/api/places/7/reviews'), env);
    expect(placeRevRes.status).toBe(200);
    const placeRev = (await placeRevRes.json()) as {
      place: { id: number; avg_rating: number; rating_count: number };
      reviews: Array<{ user_slug: string; score: number; dinner_date: string }>;
      visits: Array<{ id: number; my_score: number | null; rating_count: number; dinner_avg_rating: number | null }>;
    };
    expect(placeRev.place.avg_rating).toBe(3.5);
    expect(placeRev.place.rating_count).toBe(2);
    expect(placeRev.reviews).toHaveLength(2);
    expect(placeRev.reviews[0].dinner_date).toBe('2026-11-10');
    expect(placeRev.visits[0].id).toBe(614);
    expect(placeRev.visits[0].my_score).toBe(4);
    expect(placeRev.visits[0].rating_count).toBe(2);
    expect(placeRev.visits[0].dinner_avg_rating).toBe(3.5);

    const dinnerRevRes = await worker.fetch(makeReq('/api/dinners/614/reviews'), env);
    expect(dinnerRevRes.status).toBe(200);
    const dinnerRev = (await dinnerRevRes.json()) as {
      dinner: { id: number; restaurant_name: string };
      reviews: Array<{ user_slug: string; score: number }>;
    };
    expect(dinnerRev.dinner.id).toBe(614);
    expect(dinnerRev.dinner.restaurant_name).toBe('El Mexico Cafe');
    expect(dinnerRev.reviews).toHaveLength(2);

    const histRes = await worker.fetch(makeReq('/api/history?placeId=7&limit=10'), env);
    expect(histRes.status).toBe(200);
    const histData = (await histRes.json()) as {
      items: Array<{ id: number; rating_count: number; dinner_avg_rating: number; my_score: number }>;
    };
    expect(histData.items[0].id).toBe(614);
    expect(histData.items[0].rating_count).toBe(2);
    expect(histData.items[0].dinner_avg_rating).toBe(3.5);
    expect(histData.items[0].my_score).toBe(4);

    // 3. Rating an unplaced dinner attaches to restaurant when backfilled
    const unplaced = await env.DB.prepare(
      "SELECT id FROM dinners WHERE status = 'completed' AND restaurant_id IS NULL LIMIT 1",
    ).first<{ id: number }>();
    expect(unplaced).toBeTruthy();

    await worker.fetch(
      makeReq('/api/week/rate', 'POST', {
        dinnerId: unplaced!.id,
        score: 5,
        dish: 'Ribeye',
        comment: 'Retrospective review.',
      }),
      env,
    );
    const bfRes = await worker.fetch(
      makeReq(`/api/dinners/${unplaced!.id}/backfill`, 'POST', { restaurantId: 1 }),
      env,
    );
    expect(bfRes.status).toBe(200);

    const backfilledPlaceRev = (await (await worker.fetch(makeReq('/api/places/1/reviews'), env)).json()) as {
      place: { avg_rating: number; rating_count: number };
      reviews: Array<{ dinner_id: number; restaurant_id: number; dish: string }>;
    };
    expect(backfilledPlaceRev.place.avg_rating).toBe(5);
    expect(backfilledPlaceRev.place.rating_count).toBe(1);
    expect(backfilledPlaceRev.reviews[0].dinner_id).toBe(unplaced!.id);
    expect(backfilledPlaceRev.reviews[0].restaurant_id).toBe(1);
    expect(backfilledPlaceRev.reviews[0].dish).toBe('Ribeye');
  });

  it('lets host pick a place during night_poll without closing Tuesday/Wednesday voting', async () => {
    const poplar = await env.DB.prepare("SELECT id, name FROM restaurants WHERE name LIKE '%Poplar%' LIMIT 1").first<{
      id: number;
      name: string;
    }>();
    expect(poplar).toBeTruthy();

    // Host picks Poplar with keepNightVote: true during 2026-W47 (night_poll)
    const pickRes = await worker.fetch(
      makeReq('/api/week/pick-place', 'POST', {
        restaurantId: poplar!.id,
        keepNightVote: true,
      }),
      env,
    );
    expect(pickRes.status).toBe(200);
    const pickData = (await pickRes.json()) as {
      dinner: { status: string; restaurant_id: number; night_locked_at: string | null; chosen_via: string };
    };
    expect(pickData.dinner.status).toBe('night_poll');
    expect(pickData.dinner.restaurant_id).toBe(poplar!.id);
    expect(pickData.dinner.night_locked_at).toBeNull();
    expect(pickData.dinner.chosen_via).toBe('picker');

    // Bootstrap exposes both the open night_poll and the picked place
    const bootMid = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { status: string; restaurant_id: number }; place: { id: number; name: string } | null };
    };
    expect(bootMid.thisWeek.dinner.status).toBe('night_poll');
    expect(bootMid.thisWeek.place?.id).toBe(poplar!.id);

    // Crew still votes for Wednesday after the place is picked
    const v1 = await worker.fetch(makeReq('/api/week/vote-night', 'POST', { choice: 'wednesday' }), env);
    expect(v1.status).toBe(200);
    const v2 = await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'wednesday' }, { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' }),
      env,
    );
    expect(v2.status).toBe(200);

    // Monday 2026-11-16 at 12:05 PM CST locks the night to Wednesday and moves straight to place_locked
    const tick = await runWeeklyCronTick(env, new Date('2026-11-16T18:05:00Z'));
    expect(tick.actions).toContain('locked_night:2026-W47');

    const bootAfter = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { status: string; day_of_week: string; dinner_date: string; restaurant_id: number; noon_draw_ids: string | null } };
    };
    expect(bootAfter.thisWeek.dinner.status).toBe('place_locked');
    expect(bootAfter.thisWeek.dinner.day_of_week).toBe('Wednesday');
    expect(bootAfter.thisWeek.dinner.dinner_date).toBe('2026-11-18');
    expect(bootAfter.thisWeek.dinner.restaurant_id).toBe(poplar!.id);
    expect(bootAfter.thisWeek.dinner.noon_draw_ids).toBeNull();

    // Tuesday 12:05 PM CST must NOT trigger a noon draw
    const tueTick = await runWeeklyCronTick(env, new Date('2026-11-17T18:05:00Z'));
    expect(tueTick.actions).not.toContain('opened_noon_draw:2026-W47');
  });

  it('supports creating, voting on, and locking a host place poll alongside the Tuesday/Wednesday vote', async () => {
    const spots = (
      await env.DB.prepare('SELECT id, name FROM restaurants ORDER BY id ASC LIMIT 3').all<{ id: number; name: string }>()
    ).results ?? [];
    expect(spots).toHaveLength(3);
    const [p1, p2, p3] = spots;

    // 1. Host creates a 3-place poll while night_poll stays open
    const createRes = await worker.fetch(
      makeReq('/api/week/create-poll', 'POST', {
        restaurantIds: [p1.id, p2.id, p3.id],
        keepNightVote: true,
      }),
      env,
    );
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as {
      dinner: { status: string; chosen_via: string; restaurant_id: number | null; night_locked_at: string | null };
      candidates: Array<{ id: number }>;
    };
    expect(created.dinner.status).toBe('night_poll');
    expect(created.dinner.chosen_via).toBe('host_poll');
    expect(created.dinner.restaurant_id).toBeNull();
    expect(created.dinner.night_locked_at).toBeNull();
    expect(created.candidates.map((c) => c.id)).toEqual([p1.id, p2.id, p3.id]);

    // Crew votes simultaneously on Tuesday/Wednesday AND on the host place poll
    await worker.fetch(makeReq('/api/week/vote-night', 'POST', { choice: 'tuesday' }), env);
    const vote1 = await worker.fetch(makeReq('/api/week/vote-noon', 'POST', { restaurantId: p2.id }), env);
    expect(vote1.status).toBe(200);
    const vote2 = await worker.fetch(
      makeReq('/api/week/vote-noon', 'POST', { restaurantId: p2.id }, { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' }),
      env,
    );
    expect(vote2.status).toBe(200);
    const vote3 = await worker.fetch(
      makeReq('/api/week/vote-noon', 'POST', { restaurantId: p1.id }, { 'Cf-Access-Authenticated-User-Email': 'bigheadwillie@gmail.com' }),
      env,
    );
    expect(vote3.status).toBe(200);

    // Monday 12:05 PM CST locks Tuesday and transitions to noon_vote while keeping host poll candidates & votes intact
    const monTick = await runWeeklyCronTick(env, new Date('2026-11-16T18:05:00Z'));
    expect(monTick.actions).toContain('locked_night:2026-W47');

    const bootMon = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: {
        dinner: { status: string; chosen_via: string };
        noonCandidates: Array<{ id: number }>;
        noonVotes: Array<{ restaurant_id: number }>;
      };
    };
    expect(bootMon.thisWeek.dinner.status).toBe('noon_vote');
    expect(bootMon.thisWeek.dinner.chosen_via).toBe('host_poll');
    expect(bootMon.thisWeek.noonCandidates.map((c) => c.id)).toEqual([p1.id, p2.id, p3.id]);
    expect(bootMon.thisWeek.noonVotes).toHaveLength(3);

    // Tuesday 12:05 PM CST skips random 4-place draw since status is already noon_vote; 4:05 PM closes with p2 (2 votes)
    const tueNoon = await runWeeklyCronTick(env, new Date('2026-11-17T18:05:00Z'));
    expect(tueNoon.actions).not.toContain('opened_noon_draw:2026-W47');
    const tueClose = await runWeeklyCronTick(env, new Date('2026-11-17T22:05:00Z'));
    expect(tueClose.actions).toContain('closed_noon_vote:2026-W47');

    const bootFinal = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { status: string; chosen_via: string; restaurant_id: number } };
    };
    expect(bootFinal.thisWeek.dinner.status).toBe('place_locked');
    expect(bootFinal.thisWeek.dinner.chosen_via).toBe('host_poll');
    expect(bootFinal.thisWeek.dinner.restaurant_id).toBe(p2.id);

    // 2. Host can also close a place poll early during an open night_poll without locking the night early
    const nextWeek = await env.DB.prepare("SELECT id FROM dinners WHERE status = 'scheduled' ORDER BY dinner_date ASC LIMIT 1").first<{
      id: number;
    }>();
    expect(nextWeek).toBeTruthy();
    await env.DB.prepare("UPDATE dinners SET status = 'night_poll' WHERE id = ?").bind(nextWeek!.id).run();

    await worker.fetch(
      makeReq('/api/week/create-poll', 'POST', {
        dinnerId: nextWeek!.id,
        restaurantIds: [p1.id, p3.id],
        keepNightVote: true,
      }),
      env,
    );
    await worker.fetch(
      makeReq('/api/week/vote-noon', 'POST', { dinnerId: nextWeek!.id, restaurantId: p3.id }),
      env,
    );
    const closeEarlyRes = await worker.fetch(
      makeReq('/api/week/close-poll', 'POST', { dinnerId: nextWeek!.id }),
      env,
    );
    expect(closeEarlyRes.status).toBe(200);
    const closedEarly = (await closeEarlyRes.json()) as {
      dinner: { status: string; restaurant_id: number; night_locked_at: string | null; chosen_via: string };
    };
    expect(closedEarly.dinner.status).toBe('night_poll');
    expect(closedEarly.dinner.restaurant_id).toBe(p3.id);
    expect(closedEarly.dinner.night_locked_at).toBeNull();
    expect(closedEarly.dinner.chosen_via).toBe('host_poll');
  });

  it('excludes future scheduled places from last_visited and Most Recent Stop rankings', async () => {
    const placesRes = await worker.fetch(makeReq('/api/places'), env);
    expect(placesRes.status).toBe(200);
    const { places } = (await placesRes.json()) as {
      places: Array<{ id: number; slug: string; name: string; visit_count: number; last_visited: string | null }>;
    };

    expect(places.find((p) => p.slug === 'deanos-tapworks-east')).toBeUndefined();
    const deanos = places.find((p) => p.slug === 'deanos');
    expect(deanos).toBeTruthy();
    expect(deanos!.id).toBe(38);
    expect(deanos!.visit_count).toBe(2);
    expect(deanos!.last_visited).toBe('2023-09-27');

    // Upcoming 2026-12-01 dinner stays linked to canonical Deano's
    const bootRes = await worker.fetch(makeReq('/api/bootstrap'), env);
    const boot = (await bootRes.json()) as {
      today: string;
      upcoming: Array<{ id: number; dinner_date: string; restaurant_id: number | null; restaurant_name: string | null }>;
    };
    expect(boot.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const heathDinner = boot.upcoming.find((u) => u.dinner_date === '2026-12-01');
    expect(heathDinner?.restaurant_id).toBe(38);
    expect(heathDinner?.restaurant_name).toBe("Deano's");

    // Seeded ledger must contain no future last_visited and El Mexico Cafe (2026-11-10) must be #1 most recent
    const withLast = places.filter((p) => p.last_visited !== null);
    for (const p of withLast) {
      expect(p.last_visited! <= '2026-11-10').toBe(true);
    }
    const byRecent = [...withLast].sort((a, b) => b.last_visited!.localeCompare(a.last_visited!));
    expect(byRecent[0].name).toBe('El Mexico Cafe');
    expect(byRecent[0].last_visited).toBe('2026-11-10');

    // Picking a place for an upcoming week must NOT alter visit_count or last_visited until completed
    const nextWeek = boot.upcoming[0];
    const poplar = places.find((p) => p.name.includes('Poplar'))!;
    const pickRes = await worker.fetch(
      makeReq('/api/week/pick-place', 'POST', {
        dinnerId: nextWeek.id,
        restaurantId: poplar.id,
        dayOfWeek: 'Tuesday',
      }),
      env,
    );
    expect(pickRes.status).toBe(200);

    const placesAfterPick = (
      (await (await worker.fetch(makeReq('/api/places'), env)).json()) as {
        places: Array<{ id: number; visit_count: number; last_visited: string | null }>;
      }
    ).places;
    const poplarAfter = placesAfterPick.find((p) => p.id === poplar.id)!;
    expect(poplarAfter.visit_count).toBe(poplar.visit_count);
    expect(poplarAfter.last_visited).toBe(poplar.last_visited);

    // Injecting a synthetic future last_visited into D1 is clamped on /api/places and /api/places/:id/reviews
    await env.DB.prepare("UPDATE restaurants SET visit_count = 99, last_visited = '2099-12-31' WHERE id = 38").run();
    const clampedList = (
      (await (await worker.fetch(makeReq('/api/places'), env)).json()) as {
        places: Array<{ id: number; visit_count: number; last_visited: string | null }>;
      }
    ).places;
    const deanosClamped = clampedList.find((p) => p.id === 38)!;
    expect(deanosClamped.visit_count).toBe(2);
    expect(deanosClamped.last_visited).toBe('2023-09-27');

    const placeRevRes = await worker.fetch(makeReq('/api/places/38/reviews'), env);
    expect(placeRevRes.status).toBe(200);
    const placeRev = (await placeRevRes.json()) as {
      place: { visit_count: number; last_visited: string | null };
      visits: Array<{ dinner_date: string }>;
    };
    expect(placeRev.place.visit_count).toBe(2);
    expect(placeRev.place.last_visited).toBe('2023-09-27');
    expect(placeRev.visits.every((v) => v.dinner_date <= boot.today)).toBe(true);

    // Backfilling an uncompleted upcoming dinner must be rejected
    const badBackfill = await worker.fetch(
      makeReq(`/api/dinners/${nextWeek.id}/backfill`, 'POST', { restaurantId: 38 }),
      env,
    );
    expect(badBackfill.status).toBe(400);
  });
});
