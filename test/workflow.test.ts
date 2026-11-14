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

  beforeEach(() => {
    const db = createTestD1(schemaSql, seedSql);
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
    };

    expect(data.stats.total_dinners).toBe(614);
    expect(data.stats.total_places).toBe(226);
    expect(data.thisWeek.dinner.week_key).toBe('2026-W47');
    expect(data.thisWeek.dinner.host_slug).toBe('eric');
    expect(data.thisWeek.dinner.status).toBe('night_poll');
    expect(data.upcoming[0].host_slug).toBe('tyler');
    expect(data.upcoming[1].host_slug).toBe('heath');
  });

  it('blocks unauthenticated requests on production host and prevents dev-header spoofing', async () => {
    const spoofReq = new Request('https://dinner.tylermiranda.com/api/bootstrap', {
      headers: { 'X-Dev-User': 'eric' },
    });
    const res = await worker.fetch(spoofReq, env);
    expect(res.status).toBe(403);
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

  it('creates GitHub issues via /api/issues with proper labels and reporter metadata', async () => {
    env.GITHUB_TOKEN = 'ghp_test_token';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ number: 42, html_url: 'https://github.com/tylermiranda/man-night/issues/42' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

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
    expect(body.issue.webhook_status).toBe('github_created');
    expect(fetchMock).toHaveBeenCalledOnce();
    const callBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(callBody.labels).toContain('auto-fix');
    expect(callBody.labels).toContain('user-reported');
  });
});
