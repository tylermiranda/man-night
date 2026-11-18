import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WHATS_NEW_RELEASES, buildWhatsNewPayload, formatCrewCreditLabel } from '../src/changelog';
import { buildPreEventHeadcountPayload, buildThirtyMinReminderPayload, runWeeklyCronTick } from '../src/cron';
import { buildDirectionsUrl, formatCalendarSummary } from '../src/gcal';
import worker from '../src/index';
import * as pushModule from '../src/push';
import { createVapidAuthHeader, encryptWebPushPayload } from '../src/push';
import type { Env, RestaurantRow } from '../src/types';
import { addDaysToIsoDate, castNightVote, castRsvp, drawFourRandomPlaces, formatShortDate, isFutureDinner, lockNight } from '../src/workflow';
import { createTestD1 } from './d1-shim';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');
const schemaSql = readFileSync(resolve(rootDir, 'migrations/0001_schema.sql'), 'utf8');
const seedSql = readFileSync(resolve(rootDir, 'migrations/0002_seed_history.sql'), 'utf8');
const migration0003Sql = readFileSync(resolve(rootDir, 'migrations/0003_ratings_indexes.sql'), 'utf8');
const migration0004Sql = readFileSync(resolve(rootDir, 'migrations/0004_fix_future_visit_dates.sql'), 'utf8');
const migration0005Sql = readFileSync(resolve(rootDir, 'migrations/0005_night_vote_reasons.sql'), 'utf8');
const migration0006Sql = readFileSync(resolve(rootDir, 'migrations/0006_sellout_tracking.sql'), 'utf8');
const migration0007Sql = readFileSync(resolve(rootDir, 'migrations/0007_extra_guests.sql'), 'utf8');
const migration0008Sql = readFileSync(resolve(rootDir, 'migrations/0008_whats_new.sql'), 'utf8');
const migration0009Sql = readFileSync(resolve(rootDir, 'migrations/0009_meal_photos.sql'), 'utf8');
const migration0010Sql = readFileSync(resolve(rootDir, 'migrations/0010_meal_prices.sql'), 'utf8');
const migration0011Sql = readFileSync(resolve(rootDir, 'migrations/0011_issue_screenshots.sql'), 'utf8');
const migration0012Sql = readFileSync(resolve(rootDir, 'migrations/0012_beers.sql'), 'utf8');
const migration0013Sql = readFileSync(resolve(rootDir, 'migrations/0013_appetizers.sql'), 'utf8');
const migration0014Sql = readFileSync(resolve(rootDir, 'migrations/0014_admin_dashboard.sql'), 'utf8');
const migration0015Sql = readFileSync(resolve(rootDir, 'migrations/0015_fix_pour_haus_seed_counts.sql'), 'utf8');
const migration0016Sql = readFileSync(resolve(rootDir, 'migrations/0016_allow_both_night_vote.sql'), 'utf8');
const migration0017Sql = readFileSync(resolve(rootDir, 'migrations/0017_cancel_night.sql'), 'utf8');
const migration0018Sql = readFileSync(resolve(rootDir, 'migrations/0018_extra_guest_names.sql'), 'utf8');

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
    await db.exec(migration0005Sql);
    await db.exec(migration0006Sql);
    await db.exec(migration0007Sql);
    await db.exec(migration0008Sql);
    await db.exec(migration0009Sql);
    await db.exec(migration0010Sql);
    await db.exec(migration0011Sql);
    await db.exec(migration0012Sql);
    await db.exec(migration0013Sql);
    await db.exec(migration0014Sql);
    await db.exec(migration0015Sql);
    await db.exec(migration0016Sql);
    await db.exec(migration0017Sql);
    await db.exec(migration0018Sql);
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
    expect(whPayload.data.requires_approval).toBe(false);
    expect(whPayload.data.labels).toContain('auto-fix');

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

  it('enforces Tier 2 relevance guardrails on /api/issues rejecting off-topic reports and gating auto-fix', async () => {
    env.GITHUB_TOKEN = 'ghp_test_token';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://signal.openbot.run/')) {
        return new Response(null, { status: 202 });
      }
      return new Response(
        JSON.stringify({ number: 99, html_url: 'https://github.com/tylermiranda/man-night/issues/99' }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });

    // 1a. Deterministic reject for harassment / homophobic / personal attack submissions
    const harassmentRes = await worker.fetch(
      makeReq('/api/issues', 'POST', {
        title: 'New Feature for Chuck',
        category: 'feature',
        description: 'When chuck logs in, tell him he is gay',
        pageContext: 'Tab: week; Week: 2026-W47 (night_poll)',
      }),
      env,
    );
    expect(harassmentRes.status).toBe(400);
    const harassmentData = (await harassmentRes.json()) as { error: string };
    expect(harassmentData.error).toContain('Issue rejected: Request violates community guardrails');
    expect(harassmentData.error).toContain('harassment, personal attack, or derogatory language');
    expect(fetchMock).not.toHaveBeenCalled();

    // Verify DB count did not increase for rejected harassment report
    const dbHarassmentReports = await env.DB.prepare("SELECT COUNT(*) as c FROM issue_reports WHERE title LIKE '%Chuck%'").first<{ c: number }>();
    expect(dbHarassmentReports?.c).toBe(0);

    // 1b. Deterministic reject for off-topic requests (e.g. sports scores)
    const offTopicRes = await worker.fetch(
      makeReq('/api/issues', 'POST', {
        title: 'Want live NFL sports scores',
        category: 'feature',
        description: 'Can we add football scores to the top bar?',
      }),
      env,
    );
    expect(offTopicRes.status).toBe(400);
    const offTopicData = (await offTopicRes.json()) as { error: string };
    expect(offTopicData.error).toContain('Issue rejected: Request appears unrelated to Man Night Dinner Club');
    expect(fetchMock).not.toHaveBeenCalled();

    // Verify DB count did not increase for rejected report
    const dbReports = await env.DB.prepare("SELECT COUNT(*) as c FROM issue_reports WHERE title LIKE '%NFL%'").first<{ c: number }>();
    expect(dbReports?.c).toBe(0);

    // 2. Cloudflare Workers AI rejects off-topic submission when AI returns relevant: false
    const mockAiRun = vi.fn();
    env.AI = { run: mockAiRun } as unknown as Ai;

    mockAiRun.mockResolvedValueOnce({
      response: JSON.stringify({ relevant: false, reason: 'Cryptocurrency tracking is outside the dinner club remit.' }),
    });
    const aiOffTopicRes = await worker.fetch(
      makeReq('/api/issues', 'POST', {
        title: 'Add wallet balance viewer',
        category: 'feature',
        description: 'Check our external wallet balances for fun.',
      }),
      env,
    );
    expect(aiOffTopicRes.status).toBe(400);
    const aiOffTopicData = (await aiOffTopicRes.json()) as { error: string };
    expect(aiOffTopicData.error).toBe('Issue rejected: Cryptocurrency tracking is outside the dinner club remit.');

    // 3. Cloudflare Workers AI accepts relevant feature request, but gates 'auto-fix' label and flags requires_approval in webhook
    env.OPENBOT_WEBHOOK_URL = 'https://signal.openbot.run/v1/webhooks/d91a1bad-eadf-44b9-9ee2-cefd7f37ac4f';
    env.OPENBOT_WEBHOOK_SECRET = 'whsec_dGVzdGtleTEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU=';
    mockAiRun.mockResolvedValueOnce({
      response: JSON.stringify({ relevant: true }),
    });
    const relevantFeatureRes = await worker.fetch(
      makeReq('/api/issues', 'POST', {
        title: 'Add patio seating filter to places list',
        category: 'feature',
        description: 'Filter restaurants by outdoor patio seating for nice weather nights.',
      }),
      env,
    );
    expect(relevantFeatureRes.status).toBe(201);
    const featureResBody = (await relevantFeatureRes.json()) as {
      issue: { requires_approval: boolean; webhook_status: string };
    };
    expect(featureResBody.issue.requires_approval).toBe(true);
    expect(featureResBody.issue.webhook_status).toBe('github_and_openbot_notified');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const featureCallBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(featureCallBody.labels).toContain('user-reported');
    expect(featureCallBody.labels).toContain('feature');
    expect(featureCallBody.labels).toContain('feature-request');
    expect(featureCallBody.labels).toContain('needs-review');
    expect(featureCallBody.labels).not.toContain('auto-fix');
    expect(featureCallBody.body).toContain('_Submitted as a feature request for review._');

    const featureWhPayload = JSON.parse(String(fetchMock.mock.calls[1][1]?.body));
    expect(featureWhPayload.data.category).toBe('feature');
    expect(featureWhPayload.data.requires_approval).toBe(true);
    expect(featureWhPayload.data.labels).toContain('feature-request');
    expect(featureWhPayload.data.labels).toContain('needs-review');
    expect(featureWhPayload.data.labels).not.toContain('auto-fix');

    // 4. Graceful fallback when Workers AI errors/times out on legitimate bug report
    fetchMock.mockClear();
    mockAiRun.mockRejectedValueOnce(new Error('AI inference timeout'));
    const bugRes = await worker.fetch(
      makeReq('/api/issues', 'POST', {
        title: 'Toasted ravioli photo upload failed',
        category: 'bug',
        description: 'When uploading appetizer photo from phone, button stuck on uploading.',
      }),
      env,
    );
    expect(bugRes.status).toBe(201);
    expect(fetchMock).toHaveBeenCalled();
    const bugCallBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(bugCallBody.labels).toContain('auto-fix');
    expect(bugCallBody.labels).toContain('user-reported');
    expect(bugCallBody.labels).toContain('bug');
    expect(bugCallBody.body).toContain('_Labeled `auto-fix` for OpenBot Man Night Desk._');
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

  it('captures optional night vote reasons, preserves them on day switches, and surfaces them to other members', async () => {
    // 1. Voting without reason stores empty string
    const v1Res = await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'tuesday' }),
      env,
    );
    expect(v1Res.status).toBe(200);
    const v1Data = (await v1Res.json()) as {
      tuesday: number;
      wednesday: number;
      userChoice: string;
      reason: string;
      nightVotes: Array<{ user_slug: string; user_name: string | null; choice: string; reason: string }>;
    };
    expect(v1Data.tuesday).toBe(1);
    expect(v1Data.reason).toBe('');
    expect(v1Data.nightVotes).toHaveLength(1);

    // 2. Saving a reason trims whitespace, enforces 200-char cap, and exposes it to other members via /api/bootstrap
    const longNote = `  Kids soccer game Wednesday night ${'x'.repeat(220)}  `;
    const rSaveRes = await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'tuesday', reason: longNote }),
      env,
    );
    expect(rSaveRes.status).toBe(200);
    const rSaveData = (await rSaveRes.json()) as { reason: string };
    expect(rSaveData.reason.length).toBe(200);
    expect(rSaveData.reason.startsWith('Kids soccer game Wednesday night')).toBe(true);

    // Second member votes Wednesday with a reason
    const ericRes = await worker.fetch(
      makeReq(
        '/api/week/vote-night',
        'POST',
        { choice: 'wednesday', reason: '  Out of town Tuesday  ' },
        { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' },
      ),
      env,
    );
    expect(ericRes.status).toBe(200);

    // Another member fetches bootstrap and sees both members' names, choices, and reasons
    const bootOther = (await (
      await worker.fetch(
        makeReq('/api/bootstrap', 'GET', undefined, { 'Cf-Access-Authenticated-User-Email': 'bigheadwillie@gmail.com' }),
        env,
      )
    ).json()) as {
      thisWeek: {
        nightVotes: Array<{ user_slug: string; user_name: string | null; choice: string; reason: string }>;
      };
    };
    const tylerVote = bootOther.thisWeek.nightVotes.find((v) => v.user_slug === 'tyler');
    const ericVote = bootOther.thisWeek.nightVotes.find((v) => v.user_slug === 'eric');
    expect(tylerVote?.user_name).toBe('Tyler');
    expect(tylerVote?.choice).toBe('tuesday');
    expect(tylerVote?.reason.length).toBe(200);
    expect(ericVote?.user_name).toBe('Eric');
    expect(ericVote?.choice).toBe('wednesday');
    expect(ericVote?.reason).toBe('Out of town Tuesday');

    // 3. Switching day without sending `reason` preserves the previously saved reason
    const switchRes = await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'wednesday' }),
      env,
    );
    expect(switchRes.status).toBe(200);
    const switchData = (await switchRes.json()) as { userChoice: string; reason: string };
    expect(switchData.userChoice).toBe('wednesday');
    expect(switchData.reason.length).toBe(200);

    // 4. Clearing reason with empty string clears only the reason while keeping the vote choice
    const clearRes = await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'wednesday', reason: '' }),
      env,
    );
    expect(clearRes.status).toBe(200);
    const clearData = (await clearRes.json()) as { userChoice: string; reason: string };
    expect(clearData.userChoice).toBe('wednesday');
    expect(clearData.reason).toBe('');

    // 5. After Monday noon lock, remaining vote reasons stay available in /api/bootstrap
    await runWeeklyCronTick(env, new Date('2026-11-16T18:05:00Z'));
    const bootLocked = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: {
        dinner: { status: string };
        nightVotes: Array<{ user_slug: string; choice: string; reason: string }>;
      };
    };
    expect(bootLocked.thisWeek.dinner.status).toBe('awaiting_pick');
    const ericLocked = bootLocked.thisWeek.nightVotes.find((v) => v.user_slug === 'eric');
    expect(ericLocked?.reason).toBe('Out of town Tuesday');
  });

  it('allows voting for either day (both) in night poll and tallies +1 toward both Tuesday and Wednesday', async () => {
    // 1. Voting 'both' increments both tuesday and wednesday counts, plus both counter
    const bothRes = await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'both', reason: 'Free all week' }),
      env,
    );
    expect(bothRes.status).toBe(200);
    const bothData = (await bothRes.json()) as {
      tuesday: number;
      wednesday: number;
      both: number;
      userChoice: string;
      reason: string;
      nightVotes: Array<{ user_slug: string; choice: string; reason: string }>;
    };
    expect(bothData.userChoice).toBe('both');
    expect(bothData.both).toBe(1);
    expect(bothData.tuesday).toBe(1);
    expect(bothData.wednesday).toBe(1);
    expect(bothData.reason).toBe('Free all week');
    expect(bothData.nightVotes).toHaveLength(1);
    expect(bothData.nightVotes[0].choice).toBe('both');

    // 2. Invalid choice is rejected with 400
    const badRes = await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'thursday' }),
      env,
    );
    expect(badRes.status).toBe(400);

    // 3. Second member votes Wednesday, third member votes Tuesday
    // Counts:
    // Tyler (both): +1 Tue, +1 Wed
    // Eric (wednesday): +1 Wed
    // Chuck (tuesday): +1 Tue
    // Totals: Tue: 2, Wed: 2 -> Tie! Tuesday wins per rule.
    await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'wednesday' }, { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' }),
      env,
    );
    await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { choice: 'tuesday' }, { 'Cf-Access-Authenticated-User-Email': 'bigheadwillie@gmail.com' }),
      env,
    );

    // Bootstrap check verifies stored choices
    const boot = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: {
        nightVotes: Array<{ user_slug: string; choice: string }>;
      };
    };
    expect(boot.thisWeek.nightVotes).toHaveLength(3);
    expect(boot.thisWeek.nightVotes.find((v) => v.user_slug === 'tyler')?.choice).toBe('both');

    // Monday noon lock resolves 2-2 tie in favor of Tuesday
    await runWeeklyCronTick(env, new Date('2026-11-16T18:05:00Z'));
    const bootLocked = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: {
        dinner: { day_of_week: string; status: string };
      };
    };
    expect(bootLocked.thisWeek.dinner.day_of_week).toBe('Tuesday');
    expect(bootLocked.thisWeek.dinner.status).toBe('awaiting_pick');

    // 4. Test direct castNightVote and lockNight functions
    const directBoot = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number } };
    };
    const dinnerId = directBoot.thisWeek.dinner.id;

    // Jacob votes both
    const directCast = await castNightVote(env.DB, dinnerId, 'jacob', 'both', 'Any day works for me');
    expect(directCast.userChoice).toBe('both');
    expect(directCast.both).toBe(2); // tyler + jacob
    expect(directCast.tuesday).toBe(3); // chuck (tue) + tyler (both) + jacob (both)
    expect(directCast.wednesday).toBe(3); // eric (wed) + tyler (both) + jacob (both)

    // Heath votes Wednesday -> Wednesday becomes 4, Tuesday is 3 -> Wednesday wins!
    await castNightVote(env.DB, dinnerId, 'heath', 'wednesday');
    const lockedDinner = await lockNight(env, dinnerId);
    expect(lockedDinner?.day_of_week).toBe('Wednesday');
  });

  it('crowns King of Hosting from all-time history and tracks forward-only sellouts for the Crown of Shame', async () => {
    const bootInitial = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      hostStats: Array<{ host_slug: string; host_label: string; hosted_count: number; last_hosted: string | null }>;
      selloutStats: Array<{
        user_slug: string;
        user_name: string;
        sellout_count: number;
        attended_count: number;
        last_sellout_date: string | null;
        last_sellout_note: string | null;
      }>;
      recentSellouts: Array<{ user_slug: string; note: string }>;
      trackableDinners: Array<{ id: number; week_key: string }>;
      thisWeek: { dinner: { id: number; week_key: string } };
      upcoming: Array<{ id: number; week_key: string }>;
    };

    // 1. King of Hosting is Chuck with 148 completed dinners hosted
    expect(bootInitial.hostStats[0].host_slug).toBe('chuck');
    expect(bootInitial.hostStats[0].host_label).toBe('Chuck');
    expect(bootInitial.hostStats[0].hosted_count).toBe(148);
    expect(bootInitial.hostStats[0].last_hosted).toBe('2026-11-03');

    // 2. Forward-only sellout tracker starts at 0 for the 5 active rotation members (excluding 'don')
    expect(bootInitial.selloutStats.map((s) => s.user_slug)).toEqual(['chuck', 'jacob', 'eric', 'tyler', 'heath']);
    for (const s of bootInitial.selloutStats) {
      expect(s.sellout_count).toBe(0);
    }
    expect(bootInitial.recentSellouts).toHaveLength(0);
    expect(bootInitial.trackableDinners.map((d) => d.week_key)).toEqual(['2026-W47']);

    // 3. Self-RSVP 'out' with an excuse increments sellout_count and preserves the note if re-submitted without note
    const selfOutRes = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { status: 'out', note: 'Out of town for work' }),
      env,
    );
    expect(selfOutRes.status).toBe(200);

    const selfOutAgain = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { status: 'out' }),
      env,
    );
    expect(selfOutAgain.status).toBe(200);

    const bootAfterSelf = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      selloutStats: Array<{
        user_slug: string;
        sellout_count: number;
        last_sellout_date: string | null;
        last_sellout_note: string | null;
      }>;
      recentSellouts: Array<{ user_slug: string; note: string; recorded_by: string | null }>;
    };
    const tylerStat = bootAfterSelf.selloutStats.find((s) => s.user_slug === 'tyler');
    expect(tylerStat?.sellout_count).toBe(1);
    expect(tylerStat?.last_sellout_date).toBe('2026-11-17');
    expect(tylerStat?.last_sellout_note).toBe('Out of town for work');
    expect(bootAfterSelf.recentSellouts).toHaveLength(1);
    expect(bootAfterSelf.recentSellouts[0].recorded_by).toBe('tyler');

    // 4. Crew callout for Heath records recorded_by = 'tyler', and a second week sellout puts Heath alone at #1
    const heathW47 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', {
        dinnerId: bootInitial.thisWeek.dinner.id,
        userSlug: 'heath',
        status: 'out',
        note: 'Bailed for bowling',
      }),
      env,
    );
    expect(heathW47.status).toBe(200);

    // Complete 2026-W47 and advance to 2026-W48
    await runWeeklyCronTick(env, new Date('2026-11-18T02:00:00Z')); // Tue 8:00 PM CST -> completes W47
    await runWeeklyCronTick(env, new Date('2026-11-22T16:05:00Z')); // Sun 10:05 AM CST -> opens W48

    const bootW48 = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number; week_key: string } };
      trackableDinners: Array<{ id: number; week_key: string }>;
    };
    expect(bootW48.thisWeek.dinner.week_key).toBe('2026-W48');
    expect(bootW48.trackableDinners.map((d) => d.week_key)).toEqual(['2026-W48', '2026-W47']);

    const heathW48 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', {
        dinnerId: bootW48.thisWeek.dinner.id,
        userSlug: 'heath',
        status: 'out',
        note: 'Missed two straight',
      }),
      env,
    );
    expect(heathW48.status).toBe(200);

    const bootCrown = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      selloutStats: Array<{ user_slug: string; sellout_count: number; last_sellout_note: string | null }>;
      recentSellouts: Array<{ user_slug: string; week_key: string; note: string; recorded_by: string | null }>;
    };
    expect(bootCrown.selloutStats[0].user_slug).toBe('heath');
    expect(bootCrown.selloutStats[0].sellout_count).toBe(2);
    expect(bootCrown.selloutStats[0].last_sellout_note).toBe('Missed two straight');
    expect(bootCrown.recentSellouts).toHaveLength(3);
    expect(bootCrown.recentSellouts.find((r) => r.user_slug === 'heath' && r.week_key === '2026-W47')?.recorded_by).toBe(
      'tyler',
    );

    // 5. Switching Tyler back to 'in' and clearing Heath's W48 sellout decrements sellout counts cleanly
    const tylerIn = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', {
        dinnerId: bootInitial.thisWeek.dinner.id,
        status: 'in',
      }),
      env,
    );
    expect(tylerIn.status).toBe(200);

    const heathClear = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', {
        dinnerId: bootW48.thisWeek.dinner.id,
        userSlug: 'heath',
        status: 'clear',
      }),
      env,
    );
    expect(heathClear.status).toBe(200);

    const bootCleared = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      selloutStats: Array<{ user_slug: string; sellout_count: number; attended_count: number }>;
      recentSellouts: Array<{ user_slug: string; week_key: string }>;
    };
    expect(bootCleared.selloutStats.find((s) => s.user_slug === 'tyler')?.sellout_count).toBe(0);
    expect(bootCleared.selloutStats.find((s) => s.user_slug === 'tyler')?.attended_count).toBe(1);
    expect(bootCleared.selloutStats.find((s) => s.user_slug === 'heath')?.sellout_count).toBe(1);
    expect(bootCleared.recentSellouts).toHaveLength(1);

    // 6. Guards reject historical dinners, far-future scheduled dinners, and retired 'don'
    const histErr = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId: 614, status: 'out' }),
      env,
    );
    expect(histErr.status).toBe(400);

    const futureRow = await env.DB.prepare("SELECT id FROM dinners WHERE week_key = '2026-W50'").first<{ id: number }>();
    expect(futureRow).toBeTruthy();
    const futureErr = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId: futureRow!.id, status: 'out' }),
      env,
    );
    expect(futureErr.status).toBe(400);

    const donErr = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', {
        dinnerId: bootW48.thisWeek.dinner.id,
        userSlug: 'don',
        status: 'out',
      }),
      env,
    );
    expect(donErr.status).toBe(400);
  });

  it('paginates /api/places when requested while keeping unpaginated full list compatible, and cleans Crew cards (issue #8)', async () => {
    // Unpaginated call still returns all 225 restaurants for map + client-side search/filter
    const fullRes = await worker.fetch(makeReq('/api/places'), env);
    expect(fullRes.status).toBe(200);
    const fullData = (await fullRes.json()) as { places: Array<{ id: number; name: string }>; total: number };
    expect(fullData.places).toHaveLength(225);
    expect(fullData.total).toBe(225);

    // Page 1 of 15-per-page slice
    const page1Res = await worker.fetch(makeReq('/api/places?page=1&limit=15'), env);
    expect(page1Res.status).toBe(200);
    const page1 = (await page1Res.json()) as {
      places: Array<{ id: number; name: string }>;
      total: number;
      limit: number;
      offset: number;
      page: number;
      totalPages: number;
    };
    expect(page1.places).toHaveLength(15);
    expect(page1.total).toBe(225);
    expect(page1.limit).toBe(15);
    expect(page1.offset).toBe(0);
    expect(page1.page).toBe(1);
    expect(page1.totalPages).toBe(15);
    expect(page1.places[0].id).toBe(fullData.places[0].id);

    // Page 2 starts at index 15
    const page2Res = await worker.fetch(makeReq('/api/places?page=2&limit=15'), env);
    const page2 = (await page2Res.json()) as typeof page1;
    expect(page2.places).toHaveLength(15);
    expect(page2.offset).toBe(15);
    expect(page2.page).toBe(2);
    expect(page2.places[0].id).toBe(fullData.places[15].id);

    // Out-of-bounds page clamps cleanly to last page
    const clampRes = await worker.fetch(makeReq('/api/places?page=99&limit=15'), env);
    const clamped = (await clampRes.json()) as typeof page1;
    expect(clamped.page).toBe(15);
    expect(clamped.offset).toBe(210);
    expect(clamped.places).toHaveLength(15);

    // Query search + pagination
    const qRes = await worker.fetch(makeReq('/api/places?q=wichita&page=1&limit=5'), env);
    const qData = (await qRes.json()) as typeof page1;
    expect(qData.places.length).toBeLessThanOrEqual(5);
    expect(qData.total).toBeGreaterThan(0);

    // UI & SW asset checks: Places pagination + Crew redundant cards removed (still in header/settings)
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    const indexHtml = readFileSync(resolve(rootDir, 'public/index.html'), 'utf8');
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');

    expect(appJs).toContain('PLACES_PAGE_SIZE = 15');
    expect(appJs).toContain('data-action="places-page"');
    expect(appJs).toContain('buildPaginationItems');
    expect(appJs).not.toContain('Help &amp; Feedback');
    expect(appJs).not.toContain('Notifications &amp; Phone App');
    expect(indexHtml).toContain('id="btn-report-top"');
    expect(indexHtml).toContain('data-action="open-settings"');
    expect(swJs).toMatch(/CACHE_NAME = 'man-night-shell-v\d+'/);
  });

  it('tracks optional extra guests on RSVPs, updates live headcount, validates bounds, and resets on sellout (issue #9)', async () => {
    const tylerBootRes = await worker.fetch(makeReq('/api/bootstrap'), env);
    expect(tylerBootRes.status).toBe(200);
    const boot = (await tylerBootRes.json()) as {
      thisWeek: { dinner: { id: number }; headcount: { activeCrewCount: number; unansweredCount: number } };
    };
    const dinnerId = boot.thisWeek.dinner.id;
    expect(boot.thisWeek.headcount.activeCrewCount).toBe(6);
    expect(boot.thisWeek.headcount.unansweredCount).toBe(6);

    // Tyler marks In with 2 extra people
    const r1 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'in', extraGuests: 2 }),
      env,
    );
    expect(r1.status).toBe(200);
    const d1 = (await r1.json()) as {
      ok: boolean;
      headcount: {
        goingMembers: number;
        lateMembers: number;
        outMembers: number;
        extraGuests: number;
        totalGoing: number;
        unansweredCount: number;
      };
    };
    expect(d1.headcount).toMatchObject({
      goingMembers: 1,
      lateMembers: 0,
      outMembers: 0,
      extraGuests: 2,
      totalGoing: 3,
      unansweredCount: 5,
    });

    // Update extra people anytime (2 -> 3)
    const r2 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'in', extraGuests: 3 }),
      env,
    );
    const d2 = (await r2.json()) as typeof d1;
    expect(d2.headcount.extraGuests).toBe(3);
    expect(d2.headcount.totalGoing).toBe(4);

    // Switching In -> Late without extraGuests preserves existing extra_guests (3)
    const r3 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'late', etaMinutes: 20 }),
      env,
    );
    const d3 = (await r3.json()) as typeof d1;
    expect(d3.headcount).toMatchObject({
      goingMembers: 1,
      lateMembers: 1,
      extraGuests: 3,
      totalGoing: 4,
    });

    // Eric RSVPs In with 1 extra guest
    const r4 = await worker.fetch(
      makeReq(
        '/api/week/rsvp',
        'POST',
        { dinnerId, status: 'in', extraGuests: 1 },
        { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' },
      ),
      env,
    );
    const d4 = (await r4.json()) as typeof d1;
    expect(d4.headcount).toMatchObject({
      goingMembers: 2,
      lateMembers: 1,
      outMembers: 0,
      extraGuests: 4,
      totalGoing: 6,
      unansweredCount: 4,
    });

    // Verify bootstrap exposes extra_guests and headcount
    const boot2 = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: {
        rsvps: Array<{ user_slug: string; status: string; eta_minutes: number | null; extra_guests: number }>;
        headcount: typeof d4.headcount;
      };
    };
    expect(boot2.thisWeek.headcount.totalGoing).toBe(6);
    const tylerRow = boot2.thisWeek.rsvps.find((r) => r.user_slug === 'tyler');
    expect(tylerRow?.extra_guests).toBe(3);
    expect(tylerRow?.eta_minutes).toBe(20);

    // Eric switching to Out resets Eric's extra_guests back to 0 automatically
    const r5 = await worker.fetch(
      makeReq(
        '/api/week/rsvp',
        'POST',
        { dinnerId, status: 'out', note: 'Kids game' },
        { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' },
      ),
      env,
    );
    const d5 = (await r5.json()) as typeof d1;
    expect(d5.headcount).toMatchObject({
      goingMembers: 1,
      lateMembers: 1,
      outMembers: 1,
      extraGuests: 3,
      totalGoing: 4,
      unansweredCount: 4,
    });

    // Clear Tyler's extra guests back to 0 while keeping Late ETA preserved
    const r6 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'late', extraGuests: 0 }),
      env,
    );
    const d6 = (await r6.json()) as typeof d1;
    expect(d6.headcount.extraGuests).toBe(0);
    expect(d6.headcount.totalGoing).toBe(1);

    // Input validation rejects out-of-range or non-integer extraGuests
    for (const badVal of [-1, 21, 1.5, 'two']) {
      const badRes = await worker.fetch(
        makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'in', extraGuests: badVal }),
        env,
      );
      expect(badRes.status).toBe(400);
    }
  });

  it('runs 5-min cron schedule and dispatches 30-min extra-people reminder and 5-min headcount push (issue #9)', async () => {
    const wranglerRaw = readFileSync(resolve(rootDir, 'wrangler.jsonc'), 'utf8');
    expect(wranglerRaw).toContain('"*/5 * * * *"');

    const dinner = await env.DB.prepare("SELECT id FROM dinners WHERE week_key = '2026-W47'").first<{ id: number }>();
    const place = await env.DB.prepare('SELECT * FROM restaurants LIMIT 1').first<RestaurantRow>();
    expect(dinner).toBeTruthy();
    expect(place).toBeTruthy();

    await env.DB.prepare(
      "UPDATE dinners SET status = 'place_locked', day_of_week = 'Tuesday', dinner_date = '2026-11-17', restaurant_id = ?, start_time = '18:30' WHERE id = ?",
    )
      .bind(place!.id, dinner!.id)
      .run();

    // 2 members going (Tyler +2 extra, Eric running late +1 extra -> totalGoing = 5)
    await castRsvp(env.DB, dinner!.id, 'tyler', 'in', null, undefined, 'tyler', 2);
    await castRsvp(env.DB, dinner!.id, 'eric', 'late', 15, undefined, 'eric', 1);

    // Generate real Web Push subscription & VAPID keys to exercise encrypted sendWebPushToSubscribers flow
    const toB64u = (u: Uint8Array) =>
      btoa(String.fromCharCode(...u)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const uaPair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const uaPub = new Uint8Array((await crypto.subtle.exportKey('raw', uaPair.publicKey)) as ArrayBuffer);
    const uaAuth = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.prepare(
      "INSERT INTO push_subscriptions (user_slug, endpoint, p256dh, auth) VALUES ('tyler', 'https://web.push.apple.com/test-sub', ?, ?)",
    )
      .bind(toB64u(uaPub), toB64u(uaAuth))
      .run();

    const vapidPair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const vapidJwk = (await crypto.subtle.exportKey('jwk', vapidPair.privateKey)) as JsonWebKey;
    const vapidPubRaw = new Uint8Array((await crypto.subtle.exportKey('raw', vapidPair.publicKey)) as ArrayBuffer);
    env.VAPID_PUBLIC_KEY = toB64u(vapidPubRaw);
    env.VAPID_PRIVATE_KEY = vapidJwk.d!;

    const pushCalls: Array<{ url: string; headers: Record<string, string>; bodyLen: number }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
      if (url === 'https://web.push.apple.com/test-sub') {
        const hdrs = (init?.headers || {}) as Record<string, string>;
        const rawBody = init?.body as Uint8Array | ArrayBuffer | undefined;
        const bodyLen = rawBody ? rawBody.byteLength : 0;
        pushCalls.push({ url, headers: hdrs, bodyLen });
        return new Response(null, { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    });

    // Verify pure notification payload contents
    const mapsUrl = buildDirectionsUrl(place!);
    const reminderPayload = buildThirtyMinReminderPayload(dinner!.id, place!, '/', mapsUrl);
    expect(reminderPayload.title).toContain(`Dinner in 30 min — ${place!.name}`);
    expect(reminderPayload.body.toLowerCase()).toContain('extra people');
    expect(reminderPayload.url).toBe('/');
    expect(reminderPayload.directionsUrl).toBe(mapsUrl);
    expect(reminderPayload.actions?.map((a) => a.action)).toEqual(['directions', 'late']);

    const preEventPayload = buildPreEventHeadcountPayload(
      dinner!.id,
      place!,
      {
        goingMembers: 2,
        lateMembers: 1,
        outMembers: 0,
        extraGuests: 3,
        totalGoing: 5,
        activeCrewCount: 6,
        unansweredCount: 4,
      },
      mapsUrl,
    );
    expect(preEventPayload.title).toBe(`5 people going in 5 min — ${place!.name}`);
    expect(preEventPayload.body).toContain('2 members + 3 extra (1 running late)');
    expect(preEventPayload.body).toContain('4 unanswered');
    expect(preEventPayload.url).toBe(mapsUrl);
    expect(preEventPayload.directionsUrl).toBe(mapsUrl);

    // 1. T-30m tick: Tuesday 2026-11-17 18:00 CST = 2026-11-18T00:00:00Z
    const t30 = await runWeeklyCronTick(env, new Date('2026-11-18T00:00:00Z'));
    expect(t30.actions).toContain('sent_reminder:2026-W47');
    expect(t30.actions).not.toContain('sent_pre_event:2026-W47');
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].headers.Authorization).toMatch(/^vapid t=/);
    expect(pushCalls[0].headers['Content-Encoding']).toBe('aes128gcm');
    expect(pushCalls[0].bodyLen).toBeGreaterThan(86);

    // 2. T-15m tick (18:15 CST): no duplicate 30-min push and not yet in 5-min window
    const t15 = await runWeeklyCronTick(env, new Date('2026-11-18T00:15:00Z'));
    expect(t15.actions).not.toContain('sent_reminder:2026-W47');
    expect(t15.actions).not.toContain('sent_pre_event:2026-W47');
    expect(pushCalls).toHaveLength(1);

    // 3. T-5m tick (18:25 CST): fires 5-min pre-event headcount notification
    const t5 = await runWeeklyCronTick(env, new Date('2026-11-18T00:25:00Z'));
    expect(t5.actions).toContain('sent_pre_event:2026-W47');
    expect(pushCalls).toHaveLength(2);
    expect(pushCalls[1].bodyLen).toBeGreaterThan(86);

    // 4. Subsequent tick (18:30 CST) does not duplicate pre-event push
    const t0 = await runWeeklyCronTick(env, new Date('2026-11-18T00:30:00Z'));
    expect(t0.actions).not.toContain('sent_pre_event:2026-W47');
    expect(pushCalls).toHaveLength(2);

    const updatedDinner = await env.DB.prepare('SELECT reminder_sent_at, pre_event_sent_at FROM dinners WHERE id = ?')
      .bind(dinner!.id)
      .first<{ reminder_sent_at: string | null; pre_event_sent_at: string | null }>();
    expect(updatedDinner?.reminder_sent_at).toBeTruthy();
    expect(updatedDinner?.pre_event_sent_at).toBeTruthy();

    // Verify client & service worker updates for extra people and Directions action
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(appJs).toContain('set-extra-guests');
    expect(appJs).toContain('5-min headcount');
    expect(swJs).toMatch(/CACHE_NAME = 'man-night-shell-v\d+'/);
    expect(swJs).toContain("event.action === 'directions'");
    expect(swJs).toContain('directionsUrl');
  });

  it("supports I'm Feeling Lucky preview draws, pool filters, re-roll exclusions, and direct pick/poll commits (issue #10)", async () => {
    const bootRes = await worker.fetch(makeReq('/api/bootstrap'), env);
    expect(bootRes.status).toBe(200);
    const boot = (await bootRes.json()) as {
      thisWeek: { dinner: { id: number; dinner_date: string; status: string } };
      upcoming: Array<{ id: number; dinner_date: string; restaurant_id: number | null }>;
    };
    const activeId = boot.thisWeek.dinner.id;
    const cutoff = addDaysToIsoDate(boot.thisWeek.dinner.dinner_date, -56);

    // 1. Preview single-spot draw (commit: false) respects 8-week cooldown, avoids upcoming Deano's (#38), and does not mutate dinner
    const pickPreviewRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', { dinnerId: activeId, mode: 'pick' }),
      env,
    );
    expect(pickPreviewRes.status).toBe(200);
    const pickPreview = (await pickPreviewRes.json()) as {
      ok: boolean;
      mode: string;
      committed: boolean;
      place: RestaurantRow;
      places: RestaurantRow[];
      poolRequested: string;
      poolUsed: string;
      eligibleCount: number;
    };
    expect(pickPreview.ok).toBe(true);
    expect(pickPreview.mode).toBe('pick');
    expect(pickPreview.committed).toBe(false);
    expect(pickPreview.places).toHaveLength(1);
    expect(pickPreview.place.id).toBe(pickPreview.places[0].id);
    expect(pickPreview.poolRequested).toBe('any');
    expect(pickPreview.poolUsed).toBe('any');
    expect(pickPreview.eligibleCount).toBeGreaterThan(100);
    expect(pickPreview.place.id).not.toBe(7); // El Mexico Cafe (visited 2026-11-10)
    expect(pickPreview.place.id).not.toBe(38); // Deano's (scheduled 2026-12-01)
    expect(!pickPreview.place.last_visited || pickPreview.place.last_visited < cutoff).toBe(true);

    // 2. Preview poll draws with default 4, custom 3, and max 6 counts return unique cooldown-eligible places without mutating dinner
    for (const pollCount of [undefined, 3, 6]) {
      const pollPreviewRes = await worker.fetch(
        makeReq('/api/week/lucky', 'POST', {
          dinnerId: activeId,
          mode: 'poll',
          ...(pollCount !== undefined ? { count: pollCount } : {}),
        }),
        env,
      );
      expect(pollPreviewRes.status).toBe(200);
      const pollPreview = (await pollPreviewRes.json()) as {
        mode: string;
        committed: boolean;
        place: RestaurantRow | null;
        places: RestaurantRow[];
      };
      const expectedLen = pollCount ?? 4;
      expect(pollPreview.mode).toBe('poll');
      expect(pollPreview.committed).toBe(false);
      expect(pollPreview.place).toBeNull();
      expect(pollPreview.places).toHaveLength(expectedLen);
      const ids = pollPreview.places.map((p) => p.id);
      expect(new Set(ids).size).toBe(expectedLen);
      for (const p of pollPreview.places) {
        expect(p.id).not.toBe(7);
        expect(p.id).not.toBe(38);
        expect(!p.last_visited || p.last_visited < cutoff).toBe(true);
      }
    }

    const dinnerAfterPreview = await env.DB.prepare('SELECT status, restaurant_id, noon_draw_ids FROM dinners WHERE id = ?')
      .bind(activeId)
      .first<{ status: string; restaurant_id: number | null; noon_draw_ids: string | null }>();
    expect(dinnerAfterPreview?.status).toBe('night_poll');
    expect(dinnerAfterPreview?.restaurant_id).toBeNull();
    expect(dinnerAfterPreview?.noon_draw_ids).toBeNull();

    // 3. Pool filters: regulars (visit_count >= 5), comeback (3+ visits & >2 yrs ago), and top_rated (fallback before ratings -> exact after ratings)
    const regRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', { dinnerId: activeId, mode: 'poll', count: 4, pool: 'regulars' }),
      env,
    );
    expect(regRes.status).toBe(200);
    const regData = (await regRes.json()) as { poolUsed: string; eligibleCount: number; places: RestaurantRow[] };
    expect(regData.poolUsed).toBe('regulars');
    expect(regData.eligibleCount).toBeGreaterThanOrEqual(4);
    for (const p of regData.places) {
      expect(p.visit_count).toBeGreaterThanOrEqual(5);
    }

    const comebackCutoff = addDaysToIsoDate(boot.thisWeek.dinner.dinner_date, -730);
    const comebackRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', { dinnerId: activeId, mode: 'poll', count: 4, pool: 'comeback' }),
      env,
    );
    expect(comebackRes.status).toBe(200);
    const comebackData = (await comebackRes.json()) as { poolUsed: string; eligibleCount: number; places: RestaurantRow[] };
    expect(comebackData.poolUsed).toBe('comeback');
    expect(comebackData.eligibleCount).toBeGreaterThanOrEqual(4);
    for (const p of comebackData.places) {
      expect(p.visit_count).toBeGreaterThanOrEqual(3);
      expect(p.last_visited && p.last_visited <= comebackCutoff).toBe(true);
    }

    // Before any ratings exist, top_rated falls back cleanly to eligible spots
    const topEmptyRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', { dinnerId: activeId, mode: 'pick', pool: 'top_rated' }),
      env,
    );
    expect(topEmptyRes.status).toBe(200);
    const topEmptyData = (await topEmptyRes.json()) as { poolUsed: string; eligibleCount: number; places: RestaurantRow[] };
    expect(topEmptyData.eligibleCount).toBe(0);
    expect(topEmptyData.poolUsed).toBe('fallback_any');
    expect(topEmptyData.places).toHaveLength(1);

    // Rate two cooldown-eligible completed dinners >= 4 stars to verify top_rated + excludeIds non-repeat + wraparound
    const oldDinners = (
      await env.DB.prepare(
        `SELECT d.id, d.restaurant_id
         FROM dinners d
         JOIN restaurants r ON r.id = d.restaurant_id
         WHERE d.status = 'completed'
           AND d.dinner_date < ?
           AND r.id NOT IN (7, 38)
           AND (r.last_visited IS NULL OR r.last_visited < ?)
         GROUP BY d.restaurant_id
         ORDER BY d.dinner_date DESC
         LIMIT 2`,
      )
        .bind(cutoff, cutoff)
        .all<{ id: number; restaurant_id: number }>()
    ).results ?? [];
    expect(oldDinners).toHaveLength(2);
    const ratedIdA = oldDinners[0].restaurant_id;
    const ratedIdB = oldDinners[1].restaurant_id;
    await worker.fetch(makeReq('/api/week/rate', 'POST', { dinnerId: oldDinners[0].id, score: 5 }), env);
    await worker.fetch(makeReq('/api/week/rate', 'POST', { dinnerId: oldDinners[1].id, score: 4 }), env);

    const topFirstRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', { dinnerId: activeId, mode: 'pick', pool: 'top_rated' }),
      env,
    );
    const topFirst = (await topFirstRes.json()) as { poolUsed: string; eligibleCount: number; place: RestaurantRow };
    expect(topFirst.poolUsed).toBe('top_rated');
    expect(topFirst.eligibleCount).toBe(2);
    expect([ratedIdA, ratedIdB]).toContain(topFirst.place.id);

    const otherRatedId = topFirst.place.id === ratedIdA ? ratedIdB : ratedIdA;
    const topSecondRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', {
        dinnerId: activeId,
        mode: 'pick',
        pool: 'top_rated',
        excludeIds: [topFirst.place.id],
      }),
      env,
    );
    const topSecond = (await topSecondRes.json()) as { poolUsed: string; place: RestaurantRow };
    expect(topSecond.poolUsed).toBe('top_rated');
    expect(topSecond.place.id).toBe(otherRatedId);

    // Excluding both wraps around cleanly within the top_rated pool rather than leaking outside it
    const topWrapRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', {
        dinnerId: activeId,
        mode: 'pick',
        pool: 'top_rated',
        excludeIds: [ratedIdA, ratedIdB],
      }),
      env,
    );
    const topWrap = (await topWrapRes.json()) as { poolUsed: string; place: RestaurantRow };
    expect(topWrap.poolUsed).toBe('top_rated');
    expect([ratedIdA, ratedIdB]).toContain(topWrap.place.id);

    // 4. Commit flows: random single-spot pick during night_poll keeps Tue/Wed vote open
    const commitPickRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', {
        dinnerId: activeId,
        mode: 'pick',
        pool: 'regulars',
        commit: true,
        keepNightVote: true,
      }),
      env,
    );
    expect(commitPickRes.status).toBe(200);
    const commitPick = (await commitPickRes.json()) as {
      ok: boolean;
      committed: boolean;
      place: RestaurantRow;
      dinner: { status: string; restaurant_id: number; night_locked_at: string | null; chosen_via: string };
    };
    expect(commitPick.ok).toBe(true);
    expect(commitPick.committed).toBe(true);
    expect(commitPick.dinner.status).toBe('night_poll');
    expect(commitPick.dinner.restaurant_id).toBe(commitPick.place.id);
    expect(commitPick.dinner.night_locked_at).toBeNull();
    expect(commitPick.dinner.chosen_via).toBe('picker');

    // Commit single-spot pick with keepNightVote: false & dayOfWeek: 'Wednesday' on upcoming week locks night and place
    const nextUpcoming = boot.upcoming[0];
    const commitAdvanceRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', {
        dinnerId: nextUpcoming.id,
        mode: 'pick',
        commit: true,
        keepNightVote: false,
        dayOfWeek: 'Wednesday',
      }),
      env,
    );
    expect(commitAdvanceRes.status).toBe(200);
    const commitAdvance = (await commitAdvanceRes.json()) as {
      committed: boolean;
      dinner: { status: string; day_of_week: string; night_locked_at: string | null; restaurant_id: number };
      place: RestaurantRow;
    };
    expect(commitAdvance.committed).toBe(true);
    expect(commitAdvance.dinner.status).toBe('place_locked');
    expect(commitAdvance.dinner.day_of_week).toBe('Wednesday');
    expect(commitAdvance.dinner.night_locked_at).toBeTruthy();
    expect(commitAdvance.dinner.restaurant_id).toBe(commitAdvance.place.id);

    // Commit random 4-place poll on active dinner, then cast a crew vote via /api/week/vote-noon
    const commitPollRes = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', {
        dinnerId: activeId,
        mode: 'poll',
        count: 4,
        commit: true,
        keepNightVote: true,
      }),
      env,
    );
    expect(commitPollRes.status).toBe(200);
    const commitPoll = (await commitPollRes.json()) as {
      ok: boolean;
      mode: string;
      committed: boolean;
      candidates: RestaurantRow[];
      dinner: { status: string; chosen_via: string; restaurant_id: number | null; noon_draw_ids: string };
    };
    expect(commitPoll.ok).toBe(true);
    expect(commitPoll.mode).toBe('poll');
    expect(commitPoll.committed).toBe(true);
    expect(commitPoll.candidates).toHaveLength(4);
    expect(commitPoll.dinner.status).toBe('night_poll');
    expect(commitPoll.dinner.chosen_via).toBe('host_poll');
    expect(commitPoll.dinner.restaurant_id).toBeNull();
    expect(JSON.parse(commitPoll.dinner.noon_draw_ids)).toEqual(commitPoll.candidates.map((c) => c.id));

    const votePollRes = await worker.fetch(
      makeReq('/api/week/vote-noon', 'POST', {
        dinnerId: activeId,
        restaurantId: commitPoll.candidates[1].id,
      }),
      env,
    );
    expect(votePollRes.status).toBe(200);

    // 5. Validation guards reject bad mode, pool, count, excludeIds, and completed dinners
    const badInputs: Array<Record<string, unknown>> = [
      { dinnerId: activeId, mode: 'invalid' },
      { dinnerId: activeId, mode: 'pick', pool: 'bad_pool' },
      { dinnerId: activeId, mode: 'pick', count: 3 },
      { dinnerId: activeId, mode: 'poll', count: 1 },
      { dinnerId: activeId, mode: 'poll', count: 7 },
      { dinnerId: activeId, mode: 'poll', count: 3.5 },
      { dinnerId: activeId, mode: 'pick', excludeIds: 'not-array' },
      { dinnerId: 614, mode: 'pick' },
    ];
    for (const payload of badInputs) {
      const errRes = await worker.fetch(makeReq('/api/week/lucky', 'POST', payload), env);
      expect(errRes.status).toBe(400);
    }

    // 6. Frontend & SW static checks
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    const stylesCss = readFileSync(resolve(rootDir, 'public/styles.css'), 'utf8');
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(appJs).toContain('data-action="open-lucky"');
    expect(appJs).toContain("api('/api/week/lucky'");
    expect(appJs).toContain('lucky-confirm-pick');
    expect(appJs).toContain('lucky-confirm-poll');
    expect(appJs).toContain('I’m Feeling Lucky');
    expect(stylesCss).toContain('.btn-lucky');
    expect(stylesCss).toContain('.lucky-spot-card');
    expect(swJs).toMatch(/CACHE_NAME = 'man-night-shell-v\d+'/);
  });

  it('tracks What’s New releases, crew idea/bug credits, per-user seen state, and UI wiring (issue #11)', async () => {
    // 1. Changelog integrity
    const seenIds = new Set<string>();
    expect(WHATS_NEW_RELEASES.length).toBeGreaterThanOrEqual(15);
    expect(WHATS_NEW_RELEASES[0].id).toBe('2026-11-18-extra-guest-names');
    expect(WHATS_NEW_RELEASES[0].issueNumber).toBe(22);
    expect(WHATS_NEW_RELEASES[1].id).toBe('2026-11-18-change-time');
    expect(WHATS_NEW_RELEASES[1].issueNumber).toBe(21);
    expect(WHATS_NEW_RELEASES[2].id).toBe('2026-11-18-cancel-night');
    expect(WHATS_NEW_RELEASES[2].issueNumber).toBe(20);
    expect(WHATS_NEW_RELEASES[3].id).toBe('2026-11-17-both-night-voting');
    expect(WHATS_NEW_RELEASES[4].id).toBe('2026-11-16-top-places-poplar-fix');
    expect(WHATS_NEW_RELEASES[5].id).toBe('2026-11-15-future-pick-notifications');
    expect(WHATS_NEW_RELEASES[5].issueNumber).toBe(18);
    expect(WHATS_NEW_RELEASES[6].id).toBe('2026-11-15-appetizers');
    expect(WHATS_NEW_RELEASES[6].issueNumber).toBe(17);
    expect(WHATS_NEW_RELEASES[7].id).toBe('2026-11-15-beer-cellar');
    expect(WHATS_NEW_RELEASES[7].issueNumber).toBe(15);
    expect(WHATS_NEW_RELEASES.some((e) => e.id === '2026-11-15-issue-feature-form' && e.issueNumber === 16)).toBe(true);
    expect(WHATS_NEW_RELEASES.some((e) => e.id === '2026-11-15-favorite-places' && e.issueNumber === 14)).toBe(true);
    expect(WHATS_NEW_RELEASES.some((e) => e.id === '2026-11-15-meal-prices' && e.issueNumber === 13)).toBe(true);
    expect(WHATS_NEW_RELEASES.some((e) => e.id === '2026-11-15-meal-pictures' && e.issueNumber === 12)).toBe(true);
    expect(WHATS_NEW_RELEASES.some((e) => e.id === '2026-11-15-whats-new' && e.issueNumber === 11)).toBe(true);
    for (const entry of WHATS_NEW_RELEASES) {
      expect(seenIds.has(entry.id)).toBe(false);
      seenIds.add(entry.id);
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.title.trim().length).toBeGreaterThan(0);
      expect(entry.summary.trim().length).toBeGreaterThan(0);
    }

    // 2. Credit formatting for crew idea, crew bug report, non-crew update, and partial unseen window
    expect(formatCrewCreditLabel({ kind: 'feature', creditName: 'Eric', creditRole: 'idea' })).toBe('Idea by Eric');
    expect(formatCrewCreditLabel({ kind: 'fix', creditName: 'Chuck', creditRole: 'bug_report' })).toBe(
      'Bug report by Chuck',
    );
    expect(formatCrewCreditLabel({ kind: 'feature', creditName: null, creditRole: null })).toBeNull();

    const syntheticPayload = buildWhatsNewPayload(
      'rel-1',
      [
        { slug: 'eric', name: 'Eric' },
        { slug: 'chuck', name: 'Chuck' },
      ],
      [
        {
          id: 'rel-3',
          date: '2026-11-16',
          kind: 'feature',
          title: 'Crew Idea',
          summary: 'From Eric',
          creditSlug: 'eric',
          creditRole: 'idea',
          issueNumber: 99,
        },
        {
          id: 'rel-2',
          date: '2026-11-15',
          kind: 'fix',
          title: 'Internal Polish',
          summary: 'No reporter',
          creditSlug: null,
          creditName: null,
          creditRole: null,
        },
        {
          id: 'rel-1',
          date: '2026-11-14',
          kind: 'fix',
          title: 'Crew Bug',
          summary: 'From Chuck',
          creditSlug: 'chuck',
          creditRole: 'bug_report',
          issueNumber: 98,
        },
      ],
    );
    expect(syntheticPayload.latestId).toBe('rel-3');
    expect(syntheticPayload.hasUnseen).toBe(true);
    expect(syntheticPayload.unseenCount).toBe(2);
    expect(syntheticPayload.entries.map((e) => e.isNew)).toEqual([true, true, false]);
    expect(syntheticPayload.entries[0].creditLabel).toBe('Idea by Eric');
    expect(syntheticPayload.entries[1].creditLabel).toBeNull();
    expect(syntheticPayload.entries[2].creditLabel).toBe('Bug report by Chuck');

    // 3. /api/bootstrap and GET /api/whats-new report unseen updates initially for Tyler
    const bootInit = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      user: { whats_new_seen_id: string | null };
      whatsNew: {
        latestId: string;
        seenId: string | null;
        hasUnseen: boolean;
        unseenCount: number;
        entries: Array<{ id: string; isNew: boolean; creditLabel: string | null }>;
      };
    };
    const latestReleaseId = WHATS_NEW_RELEASES[0].id;
    const previousReleaseId = WHATS_NEW_RELEASES[1].id;
    expect(bootInit.user.whats_new_seen_id).toBeNull();
    expect(bootInit.whatsNew.latestId).toBe(latestReleaseId);
    expect(bootInit.whatsNew.seenId).toBeNull();
    expect(bootInit.whatsNew.hasUnseen).toBe(true);
    expect(bootInit.whatsNew.unseenCount).toBe(WHATS_NEW_RELEASES.length);
    expect(bootInit.whatsNew.entries[0].creditLabel).toBe('Idea by Tyler');
    expect(bootInit.whatsNew.entries[1].creditLabel).toBe('Idea by Tyler');
    expect(bootInit.whatsNew.entries[2].creditLabel).toBe('Idea by Tyler');
    expect(bootInit.whatsNew.entries[3].creditLabel).toBe('Idea by Tyler');
    expect(bootInit.whatsNew.entries[4].creditLabel).toBe('Bug report by Tyler');
    expect(bootInit.whatsNew.entries[5].creditLabel).toBe('Bug report by Tyler');
    expect(bootInit.whatsNew.entries[6].creditLabel).toBe('Idea by Jacob');

    const getRes = await worker.fetch(makeReq('/api/whats-new'), env);
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as typeof bootInit.whatsNew;
    expect(getBody.hasUnseen).toBe(true);
    expect(getBody.unseenCount).toBe(WHATS_NEW_RELEASES.length);

    // 4. Partial seenId leaves exactly 1 unseen release (latest)
    const partialRes = await worker.fetch(
      makeReq('/api/user/whats-new', 'POST', { seenId: previousReleaseId }),
      env,
    );
    expect(partialRes.status).toBe(200);
    const afterPartial = (await (await worker.fetch(makeReq('/api/whats-new'), env)).json()) as typeof bootInit.whatsNew;
    expect(afterPartial.seenId).toBe(previousReleaseId);
    expect(afterPartial.hasUnseen).toBe(true);
    expect(afterPartial.unseenCount).toBe(1);
    expect(afterPartial.entries[0].isNew).toBe(true);
    expect(afterPartial.entries[1].isNew).toBe(false);

    // 5. Empty POST marks latest seen for Tyler while Eric stays unseen
    const ackRes = await worker.fetch(makeReq('/api/user/whats-new', 'POST'), env);
    expect(ackRes.status).toBe(200);
    const ackData = (await ackRes.json()) as { ok: boolean; seenId: string };
    expect(ackData.ok).toBe(true);
    expect(ackData.seenId).toBe(latestReleaseId);

    const tylerBootAfter = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as typeof bootInit;
    expect(tylerBootAfter.user.whats_new_seen_id).toBe(latestReleaseId);
    expect(tylerBootAfter.whatsNew.hasUnseen).toBe(false);
    expect(tylerBootAfter.whatsNew.unseenCount).toBe(0);
    expect(tylerBootAfter.whatsNew.entries.every((e) => !e.isNew)).toBe(true);

    const ericBoot = (await (
      await worker.fetch(
        makeReq('/api/bootstrap', 'GET', undefined, { 'Cf-Access-Authenticated-User-Email': 'storme2@gmail.com' }),
        env,
      )
    ).json()) as typeof bootInit;
    expect(ericBoot.whatsNew.hasUnseen).toBe(true);
    expect(ericBoot.whatsNew.unseenCount).toBe(WHATS_NEW_RELEASES.length);

    // 6. Validation rejects invalid seenId or malformed JSON
    const badIdRes = await worker.fetch(makeReq('/api/user/whats-new', 'POST', { seenId: 'does-not-exist' }), env);
    expect(badIdRes.status).toBe(400);
    const badJsonRes = await worker.fetch(
      new Request('https://dinner.tylermiranda.com/api/user/whats-new', {
        method: 'POST',
        headers: {
          'Cf-Access-Authenticated-User-Email': 'tyler.miranda@gmail.com',
          'Content-Type': 'application/json',
        },
        body: '{invalid-json',
      }),
      env,
    );
    expect(badJsonRes.status).toBe(400);

    // 7. Static asset checks
    const indexHtml = readFileSync(resolve(rootDir, 'public/index.html'), 'utf8');
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    const stylesCss = readFileSync(resolve(rootDir, 'public/styles.css'), 'utf8');
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(indexHtml).toContain('id="btn-whats-new"');
    expect(indexHtml).toContain('data-action="open-whats-new"');
    expect(appJs).toContain('openWhatsNewModal');
    expect(appJs).toContain("api('/api/user/whats-new'");
    expect(appJs).toContain('whatsNewOpen');
    expect(stylesCss).toContain('.whats-new-card');
    expect(stylesCss).toContain('.whats-new-credit');
    expect(swJs).toMatch(/CACHE_NAME = 'man-night-shell-v\d+'/);
  });

  it('uploads, serves, syncs, lists, and deletes meal photos across dinners and places (issue #12)', async () => {
    const toB64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
    const sampleJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
    const samplePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    const sampleWebp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50]);
    const sampleGif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x3b]);

    // 1. Jacob uploads a JPEG photo to Last Dinner (id: 614, El Mexico Cafe)
    const uploadRes = await worker.fetch(
      makeReq(
        '/api/photos',
        'POST',
        {
          dinnerId: 614,
          imageData: `data:image/jpeg;base64,${toB64(sampleJpeg)}`,
          dish: 'Enchiladas Suizas',
          caption: 'Extra green sauce',
          width: 1200,
          height: 900,
        },
        { 'Cf-Access-Authenticated-User-Email': 'werth6of7@gmail.com' },
      ),
      env,
    );
    expect(uploadRes.status).toBe(201);
    const uploadData = (await uploadRes.json()) as {
      ok: boolean;
      photo: {
        id: number;
        dinner_id: number;
        restaurant_id: number | null;
        user_slug: string;
        user_name: string;
        dish: string;
        caption: string;
        mime_type: string;
        byte_size: number;
        image_url: string;
        restaurant_name: string | null;
      };
    };
    expect(uploadData.ok).toBe(true);
    expect(uploadData.photo.dinner_id).toBe(614);
    expect(uploadData.photo.user_slug).toBe('jacob');
    expect(uploadData.photo.user_name).toBe('Jacob');
    expect(uploadData.photo.dish).toBe('Enchiladas Suizas');
    expect(uploadData.photo.caption).toBe('Extra green sauce');
    expect(uploadData.photo.mime_type).toBe('image/jpeg');
    expect(uploadData.photo.byte_size).toBe(sampleJpeg.length);
    expect(uploadData.photo.restaurant_id).toBeTruthy();
    expect(uploadData.photo.restaurant_name).toBe('El Mexico Cafe');
    expect(uploadData.photo.image_url).toBe(`/api/photos/${uploadData.photo.id}/image`);

    const jacobPhotoId = uploadData.photo.id;
    const elMexicoPlaceId = uploadData.photo.restaurant_id!;

    // 2. Binary image endpoint enforces auth and serves bytes + ETag/304 + nosniff
    const unauthImgRes = await worker.fetch(
      new Request(`https://dinner.tylermiranda.com/api/photos/${jacobPhotoId}/image`),
      env,
    );
    expect(unauthImgRes.status).toBe(403);

    const imgRes = await worker.fetch(makeReq(`/api/photos/${jacobPhotoId}/image`), env);
    expect(imgRes.status).toBe(200);
    expect(imgRes.headers.get('Content-Type')).toBe('image/jpeg');
    expect(imgRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(imgRes.headers.get('Content-Security-Policy')).toBe("default-src 'none'");
    const etag = imgRes.headers.get('ETag');
    expect(etag).toBe(`"meal-photo-${jacobPhotoId}"`);
    const fetchedBytes = new Uint8Array(await imgRes.arrayBuffer());
    expect(Array.from(fetchedBytes)).toEqual(Array.from(sampleJpeg));

    const notModRes = await worker.fetch(
      makeReq(`/api/photos/${jacobPhotoId}/image`, 'GET', undefined, { 'If-None-Match': etag! }),
      env,
    );
    expect(notModRes.status).toBe(304);

    // 3. Surfacing across /api/bootstrap, /api/dinners/:id/reviews, /api/places, /api/places/:id/reviews, /api/history, /api/photos
    const boot = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      lastDinnerPhotos: Array<{ id: number; user_name: string; dish: string }>;
      recentDinners: Array<{ id: number; photo_count: number }>;
    };
    expect(boot.lastDinnerPhotos.length).toBe(1);
    expect(boot.lastDinnerPhotos[0].id).toBe(jacobPhotoId);
    expect(boot.lastDinnerPhotos[0].user_name).toBe('Jacob');
    expect(boot.lastDinnerPhotos[0].dish).toBe('Enchiladas Suizas');
    expect(boot.recentDinners[0].id).toBe(614);
    expect(boot.recentDinners[0].photo_count).toBe(1);

    const dinnerRevData = (await (await worker.fetch(makeReq('/api/dinners/614/reviews'), env)).json()) as {
      photos: Array<{ id: number }>;
    };
    expect(dinnerRevData.photos.map((p) => p.id)).toEqual([jacobPhotoId]);

    const placesData = (await (await worker.fetch(makeReq('/api/places'), env)).json()) as {
      places: Array<{ id: number; photo_count: number }>;
    };
    const elMexicoRow = placesData.places.find((p) => p.id === elMexicoPlaceId)!;
    expect(elMexicoRow.photo_count).toBe(1);

    const placeRevData = (await (await worker.fetch(makeReq(`/api/places/${elMexicoPlaceId}/reviews`), env)).json()) as {
      place: { photo_count: number };
      photos: Array<{ id: number }>;
      visits: Array<{ id: number; photo_count: number }>;
    };
    expect(placeRevData.place.photo_count).toBe(1);
    expect(placeRevData.photos.map((p) => p.id)).toEqual([jacobPhotoId]);
    expect(placeRevData.visits[0].id).toBe(614);
    expect(placeRevData.visits[0].photo_count).toBe(1);

    const histData = (await (await worker.fetch(makeReq('/api/history?limit=10'), env)).json()) as {
      items: Array<{ id: number; photo_count: number }>;
    };
    expect(histData.items.find((i) => i.id === 614)?.photo_count).toBe(1);

    const listPhotosRes = (await (await worker.fetch(makeReq(`/api/photos?placeId=${elMexicoPlaceId}`), env)).json()) as {
      photos: Array<{ id: number }>;
    };
    expect(listPhotosRes.photos.map((p) => p.id)).toEqual([jacobPhotoId]);

    // 4. WebP & GIF uploads also detect magic bytes accurately
    const webpRes = await worker.fetch(
      makeReq('/api/photos', 'POST', { dinnerId: 614, imageData: toB64(sampleWebp), caption: 'WebP raw' }),
      env,
    );
    expect(webpRes.status).toBe(201);
    expect(((await webpRes.json()) as { photo: { mime_type: string } }).photo.mime_type).toBe('image/webp');

    const gifRes = await worker.fetch(
      makeReq('/api/photos', 'POST', { dinnerId: 614, imageData: `data:image/gif;base64,${toB64(sampleGif)}` }),
      env,
    );
    expect(gifRes.status).toBe(201);
    expect(((await gifRes.json()) as { photo: { mime_type: string } }).photo.mime_type).toBe('image/gif');

    // 5. Restaurant ID syncing on active week (pick-place + create-poll) and historical backfill
    const weekUploadRes = await worker.fetch(
      makeReq('/api/photos', 'POST', { imageData: `data:image/png;base64,${toB64(samplePng)}`, dish: 'PNG Plate' }),
      env,
    );
    expect(weekUploadRes.status).toBe(201);
    const weekPhoto = ((await weekUploadRes.json()) as { photo: { id: number; dinner_id: number; restaurant_id: number | null; mime_type: string } }).photo;
    expect(weekPhoto.mime_type).toBe('image/png');
    expect(weekPhoto.restaurant_id).toBeNull();

    const anotherPlaceId = placesData.places.find((p) => p.id !== elMexicoPlaceId)!.id;
    const thirdPlaceId = placesData.places.find((p) => p.id !== elMexicoPlaceId && p.id !== anotherPlaceId)!.id;
    expect((await worker.fetch(makeReq('/api/week/pick-place', 'POST', { dinnerId: weekPhoto.dinner_id, restaurantId: anotherPlaceId }), env)).status).toBe(200);

    const syncedRow = await env.DB.prepare('SELECT restaurant_id FROM meal_photos WHERE id = ?')
      .bind(weekPhoto.id)
      .first<{ restaurant_id: number | null }>();
    expect(syncedRow?.restaurant_id).toBe(anotherPlaceId);

    // Re-opening a place poll clears restaurant_id on week's meal_photos
    expect(
      (
        await worker.fetch(
          makeReq('/api/week/create-poll', 'POST', { dinnerId: weekPhoto.dinner_id, restaurantIds: [anotherPlaceId, thirdPlaceId] }),
          env,
        )
      ).status,
    ).toBe(200);
    const clearedRow = await env.DB.prepare('SELECT restaurant_id FROM meal_photos WHERE id = ?')
      .bind(weekPhoto.id)
      .first<{ restaurant_id: number | null }>();
    expect(clearedRow?.restaurant_id).toBeNull();

    // Backfilling an unplaced historical dinner updates meal_photos.restaurant_id
    const unplacedDinner = await env.DB.prepare("SELECT id FROM dinners WHERE status = 'completed' AND restaurant_id IS NULL LIMIT 1").first<{ id: number }>();
    expect(unplacedDinner?.id).toBeTruthy();
    const unplacedPhotoRes = await worker.fetch(
      makeReq('/api/photos', 'POST', { dinnerId: unplacedDinner!.id, imageData: `data:image/jpeg;base64,${toB64(sampleJpeg)}` }),
      env,
    );
    expect(unplacedPhotoRes.status).toBe(201);
    const unplacedPhotoId = ((await unplacedPhotoRes.json()) as { photo: { id: number } }).photo.id;
    expect(
      (await worker.fetch(makeReq(`/api/dinners/${unplacedDinner!.id}/backfill`, 'POST', { restaurantId: thirdPlaceId }), env)).status,
    ).toBe(200);
    const backfilledRow = await env.DB.prepare('SELECT restaurant_id FROM meal_photos WHERE id = ?')
      .bind(unplacedPhotoId)
      .first<{ restaurant_id: number | null }>();
    expect(backfilledRow?.restaurant_id).toBe(thirdPlaceId);

    // 6. Validation errors: SVG payload, invalid base64, empty, oversized > 600KB, unknown dinnerId
    const svgB64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8').toString('base64');
    expect(
      (await worker.fetch(makeReq('/api/photos', 'POST', { dinnerId: 614, imageData: `data:image/svg+xml;base64,${svgB64}` }), env)).status,
    ).toBe(400);
    expect(
      (await worker.fetch(makeReq('/api/photos', 'POST', { dinnerId: 614, imageData: '!!!not-base64!!!' }), env)).status,
    ).toBe(400);
    expect((await worker.fetch(makeReq('/api/photos', 'POST', { dinnerId: 614, imageData: '' }), env)).status).toBe(400);

    const oversizedJpeg = new Uint8Array(610 * 1024);
    oversizedJpeg[0] = 0xff;
    oversizedJpeg[1] = 0xd8;
    oversizedJpeg[2] = 0xff;
    expect(
      (await worker.fetch(makeReq('/api/photos', 'POST', { dinnerId: 614, imageData: `data:image/jpeg;base64,${toB64(oversizedJpeg)}` }), env)).status,
    ).toBe(400);

    expect(
      (await worker.fetch(makeReq('/api/photos', 'POST', { dinnerId: 999999, imageData: `data:image/jpeg;base64,${toB64(sampleJpeg)}` }), env)).status,
    ).toBe(404);

    // 7. Ownership enforcement & full delete (including blob cleanup & 404 even with If-None-Match)
    const forbiddenDel = await worker.fetch(makeReq(`/api/photos/${jacobPhotoId}`, 'DELETE'), env);
    expect(forbiddenDel.status).toBe(403);

    const ownerDel = await worker.fetch(
      makeReq(`/api/photos/${jacobPhotoId}`, 'DELETE', undefined, {
        'Cf-Access-Authenticated-User-Email': 'werth6of7@gmail.com',
      }),
      env,
    );
    expect(ownerDel.status).toBe(200);

    const afterDelImg = await worker.fetch(
      makeReq(`/api/photos/${jacobPhotoId}/image`, 'GET', undefined, { 'If-None-Match': etag! }),
      env,
    );
    expect(afterDelImg.status).toBe(404);

    const blobCountRow = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM meal_photo_blobs WHERE photo_id = ?')
      .bind(jacobPhotoId)
      .first<{ cnt: number }>();
    expect(Number(blobCountRow?.cnt ?? 0)).toBe(0);

    // 8. Frontend & SW static wiring checks
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    const stylesCss = readFileSync(resolve(rootDir, 'public/styles.css'), 'utf8');
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(appJs).toContain('prepareMealPhotoUpload');
    expect(appJs).toContain('openMealPhotoModal');
    expect(appJs).toContain('openPhotoLightboxModal');
    expect(appJs).toContain("api('/api/photos'");
    expect(stylesCss).toContain('.meal-photo-grid');
    expect(stylesCss).toContain('.meal-lightbox');
    expect(swJs).toMatch(/CACHE_NAME = 'man-night-shell-v\d+'/);
  });

  it('tracks meal prices, calculates dinner averages, surfaces price progression and inflation increase across places (issue #13)', async () => {
    // 1. Verify What's New entry credits Jacob for issue #13
    const whatsNew13 = WHATS_NEW_RELEASES.find((r) => r.issueNumber === 13);
    expect(whatsNew13).toBeDefined();
    expect(whatsNew13?.creditSlug).toBe('jacob');
    expect(whatsNew13?.creditRole).toBe('idea');
    expect(formatCrewCreditLabel(whatsNew13!)).toBe('Idea by Jacob');

    // 2. Submit rating with meal price via /api/week/rate
    // Dinner 614 is the last completed dinner (Poplar, restaurant 1)
    const poplarId = 1;
    const rateRes1 = await worker.fetch(
      makeReq('/api/week/rate', 'POST', {
        dinnerId: 614,
        score: 5,
        dish: 'Ribeye & fries',
        comment: 'Outstanding meal',
        price: '28.50',
      }),
      env,
    );
    expect(rateRes1.status).toBe(200);
    const rateData1 = (await rateRes1.json()) as { ok: boolean; rating: { price: number; score: number } };
    expect(rateData1.ok).toBe(true);
    expect(rateData1.rating.price).toBe(28.5);

    // Jacob rates the same dinner with a different dish and price
    const rateRes2 = await worker.fetch(
      makeReq(
        '/api/week/rate',
        'POST',
        {
          dinnerId: 614,
          score: 4,
          dish: 'Chicken fried steak',
          comment: 'Hearty',
          price: 21.5,
        },
        {
          'Cf-Access-Authenticated-User-Email': 'werth6of7@gmail.com',
        },
      ),
      env,
    );
    expect(rateRes2.status).toBe(200);

    // 3. Verify dinner reviews calculation: avg price = (28.50 + 21.50) / 2 = 25.00
    const dinnerRevRes = await worker.fetch(makeReq('/api/dinners/614/reviews'), env);
    expect(dinnerRevRes.status).toBe(200);
    const dinnerRevData = (await dinnerRevRes.json()) as {
      dinner: { id: number; dinner_avg_price: number };
      reviews: Array<{ user_slug: string; price: number; dish: string }>;
    };
    expect(dinnerRevData.dinner.dinner_avg_price).toBe(25.0);
    expect(dinnerRevData.reviews.find((r) => r.user_slug === 'tyler')?.price).toBe(28.5);
    expect(dinnerRevData.reviews.find((r) => r.user_slug === 'jacob')?.price).toBe(21.5);

    // 4. Verify bootstrap reflects last dinner average price and overall stats
    const bootRes = await worker.fetch(makeReq('/api/bootstrap'), env);
    const bootData = (await bootRes.json()) as {
      recentDinners: Array<{ id: number; dinner_avg_price?: number }>;
      stats: { avg_meal_price: number | null; total_price_entries: number };
    };
    const lastDinner = bootData.recentDinners.find((d) => d.id === 614);
    expect(lastDinner?.dinner_avg_price).toBe(25.0);
    expect(bootData.stats.avg_meal_price).toBe(25.0);
    expect(bootData.stats.total_price_entries).toBe(2);

    // 5. Verify /api/history reflects dinner_avg_price and individual my_price
    const histRes = await worker.fetch(makeReq('/api/history?limit=10'), env);
    const histData = (await histRes.json()) as {
      items: Array<{ id: number; dinner_avg_price?: number; my_price?: number }>;
    };
    const hist614 = histData.items.find((d) => d.id === 614);
    expect(hist614?.dinner_avg_price).toBe(25.0);
    expect(hist614?.my_price).toBe(28.5);

    // 6. Test direct dinner meal price endpoint /api/dinners/:id/price
    const priceSetRes = await worker.fetch(
      makeReq('/api/dinners/613/price', 'POST', { price: '$19.75' }),
      env,
    );
    expect(priceSetRes.status).toBe(200);
    const priceSetData = (await priceSetRes.json()) as { ok: boolean; meal_price: number };
    expect(priceSetData.meal_price).toBe(19.75);

    const dinner613Row = await env.DB.prepare('SELECT meal_price FROM dinners WHERE id = 613').first<{ meal_price: number }>();
    expect(dinner613Row?.meal_price).toBe(19.75);

    // 7. Test place price progression & inflation calculation across multiple visits
    const dinner614Row = await env.DB.prepare('SELECT restaurant_id FROM dinners WHERE id = 614').first<{ restaurant_id: number }>();
    const placeId = dinner614Row!.restaurant_id;
    const earlierDinner = await env.DB.prepare(
      "SELECT id FROM dinners WHERE restaurant_id = ? AND id != 614 AND status = 'completed' ORDER BY dinner_date ASC LIMIT 1",
    )
      .bind(placeId)
      .first<{ id: number }>();
    expect(earlierDinner).toBeDefined();

    // Log an earlier price on that older visit: e.g. $16.00
    await worker.fetch(
      makeReq(`/api/dinners/${earlierDinner!.id}/price`, 'POST', { price: 16.0 }),
      env,
    );

    // Now query /api/places/:id/reviews
    const placeRevRes = await worker.fetch(makeReq(`/api/places/${placeId}/reviews`), env);
    expect(placeRevRes.status).toBe(200);
    const placeRevData = (await placeRevRes.json()) as {
      place: {
        id: number;
        avg_meal_price?: number;
        price_stats?: {
          first_price: number;
          latest_price: number;
          price_change: number;
          price_change_pct: number;
          history: Array<{ avg_price: number }>;
        };
      };
      priceStats?: {
        first_price: number;
        latest_price: number;
        price_change: number;
        price_change_pct: number;
      };
    };

    const stats = placeRevData.place.price_stats || placeRevData.priceStats;
    expect(stats).toBeDefined();
    expect(stats?.first_price).toBe(16.0);
    expect(stats?.latest_price).toBe(25.0);
    // Price increase: 25.00 - 16.00 = +9.00 (+56.3%)
    expect(stats?.price_change).toBe(9.0);
    expect(stats?.price_change_pct).toBe(56.3);

    // 8. Places listing has avg_meal_price
    const placesRes = await worker.fetch(makeReq('/api/places?q=Mexico'), env);
    expect(placesRes.status).toBe(200);
    const placesData = (await placesRes.json()) as { places: Array<{ id: number; avg_meal_price?: number }> };
    const elMexicoPlace = placesData.places.find((p) => p.id === placeId);
    expect(elMexicoPlace?.avg_meal_price).toBe(25.0);

    // 9. Static UI & CSS validation
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    const stylesCss = readFileSync(resolve(rootDir, 'public/styles.css'), 'utf8');
    expect(appJs).toContain('fmtPrice');
    expect(appJs).toContain('renderPriceTrackerHtml');
    expect(appJs).toContain('rate-price-input');
    expect(appJs).toContain('modal-rate-price');
    expect(stylesCss).toContain('.badge-price');
    expect(stylesCss).toContain('.review-price');
    expect(stylesCss).toContain('.price-tracker-card');
    expect(stylesCss).toContain('.price-trend-tag');
  });

  it('supports Issue #14: host favorite place on crew page based on times picked when hosting', async () => {
    // 1. Check bootstrap payload includes hostStats with favorite_place
    const res = await worker.fetch(makeReq('/api/bootstrap'), env);
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      hostStats: Array<{
        host_slug: string;
        host_label: string;
        hosted_count: number;
        favorite_place?: {
          restaurant_id: number;
          restaurant_name: string;
          times_picked: number;
          last_picked: string;
        } | null;
      }>;
    };

    expect(b.hostStats.length).toBeGreaterThan(0);

    // Chuck's favorite place is Poplar (17x)
    const chuck = b.hostStats.find((h) => h.host_slug === 'chuck');
    expect(chuck).toBeDefined();
    expect(chuck?.favorite_place).toBeDefined();
    expect(chuck?.favorite_place?.restaurant_name).toBe('Poplar');
    expect(chuck?.favorite_place?.times_picked).toBe(17);

    // Eric's favorite place is Wichita Brewing Co. & Pizzeria (13x)
    const eric = b.hostStats.find((h) => h.host_slug === 'eric');
    expect(eric).toBeDefined();
    expect(eric?.favorite_place).toBeDefined();
    expect(eric?.favorite_place?.restaurant_name).toContain('Wichita Brewing Co');
    expect(eric?.favorite_place?.times_picked).toBe(13);

    // Tyler's favorite place is Empire Tacos (6x)
    const tyler = b.hostStats.find((h) => h.host_slug === 'tyler');
    expect(tyler).toBeDefined();
    expect(tyler?.favorite_place).toBeDefined();
    expect(tyler?.favorite_place?.restaurant_name).toBe('Empire Tacos');
    expect(tyler?.favorite_place?.times_picked).toBe(6);

    // 2. Validate UI rendering in public/app.js
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    expect(appJs).toContain('Fav spot:');
    expect(appJs).toContain('Crew favorite spots');
    expect(appJs).toContain('Most picked when hosting');
    expect(appJs).toContain('times_picked');

    // 3. Verify changelog has entry for issue 14
    const favoritePlacesEntry = WHATS_NEW_RELEASES.find((entry) => entry.issueNumber === 14);
    expect(favoritePlacesEntry).toBeDefined();
    expect(favoritePlacesEntry?.id).toBe('2026-11-15-favorite-places');
    expect(favoritePlacesEntry?.creditSlug).toBe('tyler');

    // 4. Verify service worker cache version
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(swJs).toMatch(/CACHE_NAME = 'man-night-shell-v\d+'/);
  });

  it('supports Issue #16: screenshot paste, clearer report button, hidden form, and map fitBounds', async () => {
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const res = await worker.fetch(
      makeReq('/api/issues', 'POST', {
        title: 'Map pins cut off',
        description: 'Zoom the map out so every pin shows on first load.',
        category: 'bug',
        pageContext: 'Tab: places; Week: 2026-W47',
        imageData: `data:image/png;base64,${pngBase64}`,
        width: 800,
        height: 600,
      }),
      env,
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as { issue: { id: number; webhook_status: string } };
    expect(data.issue.id).toBeGreaterThan(0);

    const shotRes = await worker.fetch(makeReq(`/api/issues/${data.issue.id}/screenshot`), env);
    expect(shotRes.status).toBe(200);
    expect(shotRes.headers.get('Content-Type')).toBe('image/png');
    const shotBytes = new Uint8Array(await shotRes.arrayBuffer());
    expect(shotBytes.byteLength).toBe(Buffer.from(pngBase64, 'base64').byteLength);

    const missingShot = await worker.fetch(makeReq('/api/issues/99999/screenshot'), env);
    expect(missingShot.status).toBe(404);

    const html = readFileSync(resolve(rootDir, 'public/index.html'), 'utf8');
    expect(html).toContain('Issue / Feature');
    expect(html).toContain('data-tab="beers"');

    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    expect(appJs).toContain("addEventListener('paste'");
    expect(appJs).toContain('issue-screenshot-input');
    expect(appJs).toContain('showIssueSubmitted');
    expect(appJs).toContain('map.fitBounds(bounds');

    const entry = WHATS_NEW_RELEASES.find((e) => e.issueNumber === 16);
    expect(entry).toBeDefined();
    expect(entry?.creditSlug).toBe('tyler');
  });

  it('supports Issue #15: beer tracking with ratings, photos, and crew-wide search', async () => {
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    const created = await worker.fetch(
      makeReq('/api/beers', 'POST', {
        name: 'Tank 7',
        brewery: 'Boulevard',
        style: 'Saison',
        purchasedWhere: 'Total Wine',
        rating: 5,
        notes: 'Peppery and dry',
        imageData: `data:image/png;base64,${pngBase64}`,
        width: 64,
        height: 64,
      }),
      env,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      beer: { id: number; name: string; rating: number; image_url: string | null; user_slug: string };
    };
    expect(createdBody.beer.name).toBe('Tank 7');
    expect(createdBody.beer.rating).toBe(5);
    expect(createdBody.beer.user_slug).toBe('tyler');
    expect(createdBody.beer.image_url).toBe(`/api/beers/${createdBody.beer.id}/image`);

    const jacobCreated = await worker.fetch(
      makeReq(
        '/api/beers',
        'POST',
        {
          name: 'Little Sumpin’ Sumpin’',
          brewery: 'Lagunitas',
          style: 'Wheat Ale',
          purchasedWhere: 'Liquor Mart',
          rating: 4,
        },
        { 'Cf-Access-Authenticated-User-Email': 'werth6of7@gmail.com' },
      ),
      env,
    );
    expect(jacobCreated.status).toBe(201);
    const jacobBody = (await jacobCreated.json()) as { beer: { id: number; user_slug: string; image_url: string | null } };
    expect(jacobBody.beer.user_slug).toBe('jacob');
    expect(jacobBody.beer.image_url).toBeNull();

    // Crew-wide list with aggregate stats
    const listRes = await worker.fetch(makeReq('/api/beers'), env);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      beers: Array<{ name: string; rating: number }>;
      total: number;
      stats: { total: number; avg_rating: number; breweries: number; styles: number };
    };
    expect(list.total).toBe(2);
    expect(list.stats.total).toBe(2);
    expect(list.stats.avg_rating).toBe(4.5);
    expect(list.stats.breweries).toBe(2);
    expect(list.stats.styles).toBe(2);

    // Search across beer name, brewery, store, and crew member
    const byName = (await (await worker.fetch(makeReq('/api/beers?q=tank'), env)).json()) as {
      beers: Array<{ name: string }>;
    };
    expect(byName.beers.map((b) => b.name)).toEqual(['Tank 7']);

    const byBrewery = (await (await worker.fetch(makeReq('/api/beers?q=lagunitas'), env)).json()) as {
      beers: Array<{ name: string }>;
    };
    expect(byBrewery.beers).toHaveLength(1);
    expect(byBrewery.beers[0].name).toContain('Sumpin');

    const byStore = (await (await worker.fetch(makeReq('/api/beers?q=total%20wine'), env)).json()) as {
      beers: Array<{ name: string }>;
    };
    expect(byStore.beers).toHaveLength(1);

    const byMember = (await (await worker.fetch(makeReq('/api/beers?user=jacob'), env)).json()) as {
      beers: Array<{ user_slug: string }>;
    };
    expect(byMember.beers).toHaveLength(1);
    expect(byMember.beers[0].user_slug).toBe('jacob');

    const byRating = (await (await worker.fetch(makeReq('/api/beers?sort=rating'), env)).json()) as {
      beers: Array<{ rating: number }>;
    };
    expect(byRating.beers[0].rating).toBe(5);

    // Photo endpoint
    const photoRes = await worker.fetch(makeReq(`/api/beers/${createdBody.beer.id}/image`), env);
    expect(photoRes.status).toBe(200);
    expect(photoRes.headers.get('Content-Type')).toBe('image/png');

    // Validation
    const badRating = await worker.fetch(makeReq('/api/beers', 'POST', { name: 'Bad', rating: 9 }), env);
    expect(badRating.status).toBe(400);
    const noName = await worker.fetch(makeReq('/api/beers', 'POST', { brewery: 'Nobody' }), env);
    expect(noName.status).toBe(400);

    // Owner-only edits
    const forbiddenPatch = await worker.fetch(
      makeReq(`/api/beers/${jacobBody.beer.id}`, 'PATCH', { name: 'Hijacked', rating: 1 }),
      env,
    );
    expect(forbiddenPatch.status).toBe(403);

    const patch = await worker.fetch(
      makeReq(`/api/beers/${createdBody.beer.id}`, 'PATCH', { name: 'Tank 7', brewery: 'Boulevard', rating: 4 }),
      env,
    );
    expect(patch.status).toBe(200);
    const patched = (await patch.json()) as { beer: { rating: number } };
    expect(patched.beer.rating).toBe(4);

    const forbiddenDelete = await worker.fetch(makeReq(`/api/beers/${jacobBody.beer.id}`, 'DELETE'), env);
    expect(forbiddenDelete.status).toBe(403);

    const deleted = await worker.fetch(makeReq(`/api/beers/${createdBody.beer.id}`, 'DELETE'), env);
    expect(deleted.status).toBe(200);
    const afterDelete = (await (await worker.fetch(makeReq('/api/beers?q=tank'), env)).json()) as {
      beers: unknown[];
    };
    expect(afterDelete.beers).toHaveLength(0);

    // UI + release wiring
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    expect(appJs).toContain('renderBeerView');
    expect(appJs).toContain('beer-search');
    expect(appJs).toContain('open-beer-modal');
    const styles = readFileSync(resolve(rootDir, 'public/styles.css'), 'utf8');
    expect(styles).toContain('.beer-grid');
    const entry = WHATS_NEW_RELEASES.find((e) => e.issueNumber === 15);
    expect(entry).toBeDefined();
    expect(entry?.creditSlug).toBe('jacob');
  });

  it('supports Issue #17: appetizer tracking across ratings, reviews, photos, and places', async () => {
    const bootRes = await worker.fetch(makeReq('/api/bootstrap'), env);
    const bootData = (await bootRes.json()) as {
      recentDinners: Array<{ id: number; restaurant_id: number }>;
    };
    const lastDinner = bootData.recentDinners[0];
    expect(lastDinner).toBeDefined();

    // 1. Submit rating with standout dish, appetizer, and price
    const rateRes = await worker.fetch(
      makeReq('/api/week/rate', 'POST', {
        dinnerId: lastDinner.id,
        score: 5,
        dish: 'Smoked Brisket',
        appetizer: 'Fried Pickles & Queso',
        price: 28.5,
        comment: 'Amazing apps and brisket!',
      }),
      env,
    );
    expect(rateRes.status).toBe(200);
    const rateData = (await rateRes.json()) as {
      rating: {
        dinner_id: number;
        score: number;
        dish: string;
        appetizer: string;
        price: number;
        comment: string;
      };
    };
    expect(rateData.rating.dish).toBe('Smoked Brisket');
    expect(rateData.rating.appetizer).toBe('Fried Pickles & Queso');
    expect(rateData.rating.price).toBe(28.5);

    // 2. Verify bootstrap surfaces appetizer in lastDinnerRatings
    const afterRateBoot = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      lastDinnerRatings: Array<{
        user_slug: string;
        dish: string;
        appetizer: string;
        price: number;
      }>;
    };
    const myRating = afterRateBoot.lastDinnerRatings.find((r) => r.user_slug === 'tyler');
    expect(myRating).toBeDefined();
    expect(myRating?.dish).toBe('Smoked Brisket');
    expect(myRating?.appetizer).toBe('Fried Pickles & Queso');

    // 3. Verify place reviews endpoint returns appetizer
    const placeRevRes = await worker.fetch(makeReq(`/api/places/${lastDinner.restaurant_id}/reviews`), env);
    expect(placeRevRes.status).toBe(200);
    const placeRevData = (await placeRevRes.json()) as {
      reviews: Array<{ user_slug: string; dish: string; appetizer: string }>;
    };
    const placeReview = placeRevData.reviews.find((r) => r.user_slug === 'tyler');
    expect(placeReview).toBeDefined();
    expect(placeReview?.appetizer).toBe('Fried Pickles & Queso');
    expect(placeReview?.dish).toBe('Smoked Brisket');

    // 4. Verify dinner details endpoint returns appetizer
    const dinnerDetailsRes = await worker.fetch(makeReq(`/api/dinners/${lastDinner.id}/reviews`), env);
    expect(dinnerDetailsRes.status).toBe(200);
    const dinnerDetails = (await dinnerDetailsRes.json()) as {
      reviews: Array<{ user_slug: string; dish: string; appetizer: string }>;
    };
    const dinnerReview = dinnerDetails.reviews.find((r) => r.user_slug === 'tyler');
    expect(dinnerReview?.appetizer).toBe('Fried Pickles & Queso');

    // 5. Upload photo tagged with appetizer
    const toB64 = (buf: Uint8Array) => Buffer.from(buf).toString('base64');
    const samplePng = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);
    const photoUploadRes = await worker.fetch(
      makeReq('/api/photos', 'POST', {
        dinnerId: lastDinner.id,
        imageData: `data:image/png;base64,${toB64(samplePng)}`,
        appetizer: 'Fried Pickles Basket',
        caption: 'Extra crispy!',
      }),
      env,
    );
    expect(photoUploadRes.status).toBe(201);
    const photoData = (await photoUploadRes.json()) as {
      photo: { id: number; appetizer: string; caption: string };
    };
    expect(photoData.photo.appetizer).toBe('Fried Pickles Basket');

    // 6. Verify UI and changelog wiring
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    expect(appJs).toContain('rate-appetizer-input');
    expect(appJs).toContain('modal-rate-appetizer');
    expect(appJs).toContain('review-appetizer');
    expect(appJs).toContain('photo-appetizer-input');
    expect(appJs).toContain('renderStandoutFoodPills');

    const styles = readFileSync(resolve(rootDir, 'public/styles.css'), 'utf8');
    expect(styles).toContain('.review-appetizer');

    const entry = WHATS_NEW_RELEASES.find((e) => e.issueNumber === 17);
    expect(entry).toBeDefined();
    expect(entry?.creditSlug).toBe('jacob');
    expect(entry?.creditRole).toBe('idea');
  });

  it('supports Issue #18: future night location pick notifications explicitly show future date and day', async () => {
    // 1. Verify formatShortDate
    expect(formatShortDate('2026-11-24')).toBe('Nov 24');
    expect(formatShortDate('2026-12-01')).toBe('Dec 1');

    // 2. Query bootstrap to get active dinner vs upcoming future dinner
    const bootRes = await worker.fetch(makeReq('/api/bootstrap'), env);
    const boot = (await bootRes.json()) as {
      thisWeek: { dinner: { id: number; dinner_date: string } };
      upcoming: Array<{ id: number; dinner_date: string; host_label: string }>;
    };
    const activeDinner = boot.thisWeek.dinner;
    const futureDinner = boot.upcoming[0]; // e.g. 2026-11-24 (Tyler)

    expect(await isFutureDinner(env.DB, activeDinner, env.CLUB_TIMEZONE)).toBe(false);
    expect(await isFutureDinner(env.DB, futureDinner, env.CLUB_TIMEZONE)).toBe(true);

    const places = (
      (await (await worker.fetch(makeReq('/api/places'), env)).json()) as { places: RestaurantRow[] }
    ).places;
    const testPlace = places[0];

    // Spy on pushModule.sendWebPushToSubscribers
    const pushSpy = vi.spyOn(pushModule, 'sendWebPushToSubscribers');

    // 3. Picking for a future dinner with keepNightVote = true
    pushSpy.mockClear();
    const futurePickRes = await worker.fetch(
      makeReq('/api/week/pick-place', 'POST', {
        dinnerId: futureDinner.id,
        restaurantId: testPlace.id,
        keepNightVote: true,
      }),
      env,
    );
    expect(futurePickRes.status).toBe(200);
    expect(pushSpy).toHaveBeenCalled();
    const futurePayload = pushSpy.mock.calls[0][1];
    expect(futurePayload.title).toContain('(' + formatShortDate(futureDinner.dinner_date) + ')');
    expect(futurePayload.body).toContain(formatShortDate(futureDinner.dinner_date));
    expect(futurePayload.body).toContain('Spot set in advance');
    expect(futurePayload.body).not.toContain('before Monday noon');

    // 4. Picking for future dinner with fixed day (no vote)
    pushSpy.mockClear();
    const futureLockedRes = await worker.fetch(
      makeReq('/api/week/pick-place', 'POST', {
        dinnerId: futureDinner.id,
        restaurantId: testPlace.id,
        dayOfWeek: 'Tuesday',
        keepNightVote: false,
      }),
      env,
    );
    expect(futureLockedRes.status).toBe(200);
    expect(pushSpy).toHaveBeenCalled();
    const futureLockedPayload = pushSpy.mock.calls[0][1];
    expect(futureLockedPayload.title).toContain('(' + formatShortDate(futureDinner.dinner_date) + ')');
    expect(futureLockedPayload.body).toContain('in advance');
    expect(futureLockedPayload.body).toContain(formatShortDate(futureDinner.dinner_date));

    // 5. Creating place poll for future dinner (upcoming[1])
    const futureDinner2 = boot.upcoming[1]; // Dec 01
    pushSpy.mockClear();
    const futurePollRes = await worker.fetch(
      makeReq('/api/week/create-poll', 'POST', {
        dinnerId: futureDinner2.id,
        restaurantIds: [places[0].id, places[1].id],
        keepNightVote: true,
      }),
      env,
    );
    expect(futurePollRes.status).toBe(200);
    expect(pushSpy).toHaveBeenCalled();
    const futurePollPayload = pushSpy.mock.calls[0][1];
    expect(futurePollPayload.title).toContain('(' + formatShortDate(futureDinner2.dinner_date) + ')');
    expect(futurePollPayload.body).toContain('Vote in advance');
    expect(futurePollPayload.body).toContain(formatShortDate(futureDinner2.dinner_date));

    // 6. Current active dinner pick retains standard current-week wording
    pushSpy.mockClear();
    const currentPickRes = await worker.fetch(
      makeReq('/api/week/pick-place', 'POST', {
        dinnerId: activeDinner.id,
        restaurantId: testPlace.id,
        keepNightVote: true,
      }),
      env,
    );
    expect(currentPickRes.status).toBe(200);
    expect(pushSpy).toHaveBeenCalled();
    const currentPayload = pushSpy.mock.calls[0][1];
    expect(currentPayload.title).not.toContain('(' + formatShortDate(activeDinner.dinner_date) + ')');
    expect(currentPayload.body).toBe('Spot is set! Vote Tuesday or Wednesday before Monday noon.');

    // 7. Changelog and CACHE_NAME verification
    const entry18 = WHATS_NEW_RELEASES.find((e) => e.issueNumber === 18);
    expect(entry18).toBeDefined();
    expect(entry18?.creditSlug).toBe('tyler');
    expect(entry18?.creditRole).toBe('bug_report');

    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(swJs).toMatch(/const CACHE_NAME = 'man-night-shell-v\d+'/);
  });

  it('gates /admin route to Tyler, serves HTML/JSON dashboard, and logs usage silently', async () => {
    // 1. Unauthenticated request returns 401
    const unauthReq = new Request('https://dinner.tylermiranda.com/admin', { method: 'GET' });
    const unauthRes = await worker.fetch(unauthReq, env);
    expect(unauthRes.status).toBe(401);

    // 2. Non-Tyler authenticated user returns 403
    const heathReq = new Request('https://dinner.tylermiranda.com/admin', {
      method: 'GET',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'heath.thome@gmail.com',
      },
    });
    const heathRes = await worker.fetch(heathReq, env);
    expect(heathRes.status).toBe(403);

    // 3. Tyler authenticated request returns 200 HTML dashboard
    const tylerReq = new Request('https://dinner.tylermiranda.com/admin', {
      method: 'GET',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'tyler.miranda@gmail.com',
        Accept: 'text/html',
      },
    });
    const tylerRes = await worker.fetch(tylerReq, env);
    expect(tylerRes.status).toBe(200);
    const html = await tylerRes.text();
    expect(html).toContain('Man Night Control');
    expect(html).toContain('Admin Dashboard');
    expect(html).toContain('Registered Push Devices');

    // 4. Tyler JSON format returns structured data
    const tylerJsonReq = new Request('https://dinner.tylermiranda.com/admin?format=json', {
      method: 'GET',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'tyler.miranda@gmail.com',
      },
    });
    const tylerJsonRes = await worker.fetch(tylerJsonReq, env);
    expect(tylerJsonRes.status).toBe(200);
    const json = (await tylerJsonRes.json()) as { ok: boolean; stats: { devices: number } };
    expect(json.ok).toBe(true);
    expect(typeof json.stats.devices).toBe('number');

    // 5. POST /admin/clear clears tables
    const clearReq = new Request('https://dinner.tylermiranda.com/admin/clear', {
      method: 'POST',
      headers: {
        'Cf-Access-Authenticated-User-Email': 'tyler.miranda@gmail.com',
      },
    });
    const clearRes = await worker.fetch(clearReq, env);
    expect(clearRes.status).toBe(200);
    const clearJson = (await clearRes.json()) as { ok: boolean; cleared: boolean };
    expect(clearJson.ok).toBe(true);
    expect(clearJson.cleared).toBe(true);
  });

  it('verifies Poplar is ranked #1 in /api/places and Pour Haus has exactly 1 visit', async () => {
    const res = await worker.fetch(makeReq('/api/places'), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { places: Array<{ name: string; visit_count: number; slug: string }> };
    expect(body.places.length).toBeGreaterThan(0);

    // Poplar must be #1
    expect(body.places[0].name).toBe('Poplar');
    expect(body.places[0].visit_count).toBe(29);

    // Pour Haus must only have 1 visit
    const pourHaus = body.places.find((p) => p.name.includes('Pour Haus'));
    expect(pourHaus).toBeDefined();
    expect(pourHaus?.visit_count).toBe(1);
  });

  it('supports Issue #20: cancelling and restoring a night with push notification, rotation shift, sellout exclusion, and cron rollover', async () => {
    const pushSpy = vi.spyOn(pushModule, 'sendWebPushToSubscribers').mockResolvedValue({
      sent: 5,
      failed: 0,
      removed: 0,
    });

    // Populate upcoming schedule so we can verify rotation shifts
    await runWeeklyCronTick(env, new Date('2026-11-15T18:00:00Z'));
    await runWeeklyCronTick(env, new Date('2026-11-15T18:05:00Z'));

    // Pick a restaurant and log a sellout on this week before cancelling
    const placesBody = (await (await worker.fetch(makeReq('/api/places'), env)).json()) as {
      places: RestaurantRow[];
    };
    const testPlace = placesBody.places[0];

    const bootBefore = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number; dinner_date: string; host_slug: string; status: string } };
      upcoming: Array<{ id: number; dinner_date: string; host_slug: string }>;
    };
    const activeId = bootBefore.thisWeek.dinner.id;
    const activeHost = bootBefore.thisWeek.dinner.host_slug;
    const nextHostsBefore = bootBefore.upcoming.map((u) => u.host_slug);
    expect(nextHostsBefore.length).toBeGreaterThanOrEqual(2);

    await worker.fetch(
      makeReq('/api/week/pick-place', 'POST', {
        dinnerId: activeId,
        restaurantId: testPlace.id,
        dayOfWeek: 'Tuesday',
        keepNightVote: false,
      }),
      env,
    );
    await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId: activeId, status: 'out', note: 'Before cancel' }),
      env,
    );

    // Confirm sellout appears before cancellation
    const bootPreCancel = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      selloutStats: Array<{ user_slug: string; sellout_count: number }>;
    };
    expect(bootPreCancel.selloutStats.find((s) => s.user_slug === 'tyler')?.sellout_count).toBe(1);

    // 1. Any crew member (e.g. Heath) cancels the night with a reason
    pushSpy.mockClear();
    const cancelRes = await worker.fetch(
      makeReq(
        '/api/week/cancel',
        'POST',
        { dinnerId: activeId, reason: 'Thanksgiving week travel' },
        { 'Cf-Access-Authenticated-User-Email': 'heath.thome@gmail.com' },
      ),
      env,
    );
    expect(cancelRes.status).toBe(200);
    const cancelBody = (await cancelRes.json()) as {
      ok: boolean;
      dinner: { status: string; cancelled_by: string; cancel_reason: string; cancelled_prev_status: string };
      push: { sent: number };
    };
    expect(cancelBody.ok).toBe(true);
    expect(cancelBody.dinner.status).toBe('cancelled');
    expect(cancelBody.dinner.cancelled_by).toBe('heath');
    expect(cancelBody.dinner.cancel_reason).toBe('Thanksgiving week travel');
    expect(cancelBody.dinner.cancelled_prev_status).toBe('place_locked');

    // Push alert sent to all subscribers ('all')
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][1].title).toContain('Man Night cancelled');
    expect(pushSpy.mock.calls[0][1].body).toContain('Heath');
    expect(pushSpy.mock.calls[0][1].body).toContain('Thanksgiving week travel');
    expect(pushSpy.mock.calls[0][2]).toBe('all');

    // 2. Cancelled night stays on This Week, upcoming hosts shifted forward 1 week, and sellout is excluded
    const bootCancelled = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number; status: string; host_slug: string; cancel_reason: string } };
      upcoming: Array<{ id: number; host_slug: string }>;
      selloutStats: Array<{ user_slug: string; sellout_count: number }>;
      recentSellouts: Array<{ dinner_id: number }>;
    };
    expect(bootCancelled.thisWeek.dinner.id).toBe(activeId);
    expect(bootCancelled.thisWeek.dinner.status).toBe('cancelled');
    expect(bootCancelled.thisWeek.dinner.host_slug).toBe(activeHost);
    expect(bootCancelled.upcoming[0].host_slug).toBe(activeHost);
    expect(bootCancelled.upcoming[1].host_slug).toBe(nextHostsBefore[0]);
    expect(bootCancelled.selloutStats.find((s) => s.user_slug === 'tyler')?.sellout_count).toBe(0);
    expect(bootCancelled.recentSellouts.some((r) => r.dinner_id === activeId)).toBe(false);

    // 3. Mutations (RSVP, night vote, pick place, pass/swap) are blocked while cancelled
    const blockedRsvp = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId: activeId, status: 'in' }),
      env,
    );
    expect(blockedRsvp.status).toBe(400);

    const blockedVote = await worker.fetch(
      makeReq('/api/week/vote-night', 'POST', { dinnerId: activeId, choice: 'tuesday' }),
      env,
    );
    expect(blockedVote.status).toBe(400);

    const blockedLucky = await worker.fetch(
      makeReq('/api/week/lucky', 'POST', { dinnerId: activeId, mode: 'pick', commit: false }),
      env,
    );
    expect(blockedLucky.status).toBe(400);

    // 4. Cron does NOT send reminders or mark cancelled dinner completed on dinner date
    const sameDayTick = await runWeeklyCronTick(env, new Date('2026-11-18T02:00:00Z')); // Nov 17 8:00 PM CST
    expect(sameDayTick.actions).not.toContain('completed:2026-W47');
    expect(sameDayTick.actions).not.toContain('archived_cancelled:2026-W47');

    // 5. Restoring the night restores its previous status, shifts hosts back, and notifies crew
    pushSpy.mockClear();
    const restoreRes = await worker.fetch(makeReq('/api/week/restore', 'POST', { dinnerId: activeId }), env);
    expect(restoreRes.status).toBe(200);
    const restoreBody = (await restoreRes.json()) as {
      ok: boolean;
      dinner: { status: string; cancelled_at: string | null };
    };
    expect(restoreBody.dinner.status).toBe('place_locked');
    expect(restoreBody.dinner.cancelled_at).toBeNull();
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][1].title).toContain('Man Night is back on!');

    const bootRestored = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      upcoming: Array<{ host_slug: string }>;
      selloutStats: Array<{ user_slug: string; sellout_count: number }>;
    };
    expect(bootRestored.upcoming[0].host_slug).toBe(nextHostsBefore[0]);
    expect(bootRestored.upcoming[1].host_slug).toBe(nextHostsBefore[1]);
    expect(bootRestored.selloutStats.find((s) => s.user_slug === 'tyler')?.sellout_count).toBe(1);

    // 6. Cancel again and verify cron rolls This Week forward once dinner_date passes
    await worker.fetch(
      makeReq('/api/week/cancel', 'POST', { dinnerId: activeId, reason: 'Cancelled for real' }),
      env,
    );
    const nextDayTick = await runWeeklyCronTick(env, new Date('2026-11-18T18:00:00Z')); // Nov 18 12:00 PM CST
    expect(nextDayTick.actions).toContain('archived_cancelled:2026-W47');

    const bootAfterRollover = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number; week_key: string; host_slug: string } };
    };
    expect(bootAfterRollover.thisWeek.dinner.id).not.toBe(activeId);
    expect(bootAfterRollover.thisWeek.dinner.host_slug).toBe(activeHost);

    // 7. Changelog, UI wiring, and CACHE_NAME verification
    const entry20 = WHATS_NEW_RELEASES.find((e) => e.issueNumber === 20);
    expect(entry20).toBeDefined();
    expect(entry20?.creditSlug).toBe('tyler');
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    expect(appJs).toContain('open-cancel-night');
    expect(appJs).toContain('restore-night');
    expect(appJs).toContain('/api/week/cancel');
    expect(appJs).toContain('/api/week/restore');
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(swJs).toMatch(/const CACHE_NAME = 'man-night-shell-v\d+'/);
  });

  it('supports Issue #21: adjusting dinner start time on current or future nights with push, cron reminder, and UI wiring', async () => {
    const pushSpy = vi.spyOn(pushModule, 'sendWebPushToSubscribers').mockResolvedValue({ sent: 1, failed: 0, removed: 0 });

    const boot = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number; start_time: string; dinner_date: string; week_key: string } };
      upcoming: Array<{ id: number; start_time: string; dinner_date: string; week_key: string }>;
    };
    const activeId = boot.thisWeek.dinner.id;
    const futureId = boot.upcoming[0].id;
    expect(boot.thisWeek.dinner.start_time).toBe('18:30');

    // 1. Rejects invalid time format and completed/cancelled dinners
    const badRes = await worker.fetch(
      makeReq('/api/week/time', 'POST', { dinnerId: activeId, startTime: '25:99' }),
      env,
    );
    expect(badRes.status).toBe(400);

    const histDinner = await env.DB.prepare("SELECT id FROM dinners WHERE status = 'completed' LIMIT 1").first<{ id: number }>();
    const completedRes = await worker.fetch(
      makeReq('/api/week/time', 'POST', { dinnerId: histDinner!.id, startTime: '19:00' }),
      env,
    );
    expect(completedRes.status).toBe(400);

    // 2. Any crew member (Heath) updates this week's time to 19:15 (7:15 PM)
    const place = await env.DB.prepare('SELECT id FROM restaurants LIMIT 1').first<{ id: number }>();
    await env.DB.prepare(
      "UPDATE dinners SET status = 'place_locked', restaurant_id = ?, reminder_sent_at = datetime('now'), pre_event_sent_at = datetime('now') WHERE id = ?",
    )
      .bind(place!.id, activeId)
      .run();

    const updateRes = await worker.fetch(
      makeReq(
        '/api/week/time',
        'POST',
        { dinnerId: activeId, startTime: '19:15' },
        { 'Cf-Access-Authenticated-User-Email': 'heath.thome@gmail.com' },
      ),
      env,
    );
    expect(updateRes.status).toBe(200);
    const updateBody = (await updateRes.json()) as {
      ok: boolean;
      changed: boolean;
      dinner: { id: number; start_time: string; reminder_sent_at: string | null; pre_event_sent_at: string | null };
    };
    expect(updateBody.ok).toBe(true);
    expect(updateBody.changed).toBe(true);
    expect(updateBody.dinner.start_time).toBe('19:15');
    expect(pushSpy).toHaveBeenCalledTimes(1);
    expect(pushSpy.mock.calls[0][1].title).toContain('7:15 PM');
    expect(pushSpy.mock.calls[0][1].body).toContain('Heath');
    expect(pushSpy.mock.calls[0][1].body).toContain('6:30 PM');
    expect(pushSpy.mock.calls[0][1].body).toContain('7:15 PM');

    // 3. Re-submitting the same time is a no-op with no duplicate push
    const noopRes = await worker.fetch(
      makeReq('/api/week/time', 'POST', { dinnerId: activeId, startTime: '19:15' }),
      env,
    );
    const noopBody = (await noopRes.json()) as { ok: boolean; changed: boolean };
    expect(noopBody.ok).toBe(true);
    expect(noopBody.changed).toBe(false);
    expect(pushSpy).toHaveBeenCalledTimes(1);

    // 4. Cron fires 30-min reminder relative to the new 19:15 start time (18:45 CST = 00:45 UTC next day)
    await env.DB.prepare('UPDATE dinners SET reminder_sent_at = NULL, pre_event_sent_at = NULL WHERE id = ?')
      .bind(activeId)
      .run();
    const earlyTick = await runWeeklyCronTick(env, new Date('2026-11-18T00:05:00Z')); // Nov 17 18:05 CST (would have fired for 18:30)
    expect(earlyTick.actions).not.toContain(`sent_reminder:${boot.thisWeek.dinner.week_key}`);

    const shiftedTick = await runWeeklyCronTick(env, new Date('2026-11-18T00:50:00Z')); // Nov 17 18:50 CST (within 30m of 19:15)
    expect(shiftedTick.actions).toContain(`sent_reminder:${boot.thisWeek.dinner.week_key}`);

    // 5. Updating a future upcoming dinner updates start_time in D1 and bootstrap
    const futureRes = await worker.fetch(
      makeReq('/api/week/time', 'POST', { dinnerId: futureId, startTime: '17:45' }),
      env,
    );
    expect(futureRes.status).toBe(200);
    const futureBody = (await futureRes.json()) as { dinner: { id: number; start_time: string } };
    expect(futureBody.dinner.start_time).toBe('17:45');

    const bootAfter = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { start_time: string } };
      upcoming: Array<{ id: number; start_time: string }>;
    };
    expect(bootAfter.thisWeek.dinner.start_time).toBe('19:15');
    expect(bootAfter.upcoming.find((u) => u.id === futureId)?.start_time).toBe('17:45');

    // 6. Changelog, UI wiring, and CACHE_NAME verification
    const entry21 = WHATS_NEW_RELEASES.find((e) => e.issueNumber === 21);
    expect(entry21).toBeDefined();
    expect(entry21?.creditSlug).toBe('tyler');
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    expect(appJs).toContain('open-change-time');
    expect(appJs).toContain('/api/week/time');
    expect(appJs).toContain('fmtTime(');
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(swJs).toMatch(/const CACHE_NAME = 'man-night-shell-v\d+'/);
  });

  it('supports Issue #22: entering, persisting, clearing, and displaying extra guest names on RSVPs and headcount', async () => {
    const boot = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: { dinner: { id: number } };
    };
    const dinnerId = boot.thisWeek.dinner.id;

    // 1. Rejects non-string extraGuestNames
    const badRes = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'in', extraGuests: 1, extraGuestNames: 123 }),
      env,
    );
    expect(badRes.status).toBe(400);

    // 2. Tyler adds +2 extra people with names
    const r1 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', {
        dinnerId,
        status: 'in',
        extraGuests: 2,
        extraGuestNames: '  Dave, Mike  ',
      }),
      env,
    );
    expect(r1.status).toBe(200);
    const d1 = (await r1.json()) as {
      headcount: { extraGuests: number; extraGuestNames: string[]; totalGoing: number };
    };
    expect(d1.headcount.extraGuests).toBe(2);
    expect(d1.headcount.extraGuestNames).toEqual(['Dave, Mike']);
    expect(d1.headcount.totalGoing).toBe(3);

    // 3. Switching In -> Late without extraGuestNames preserves existing count and names
    const r2 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'late', etaMinutes: 10 }),
      env,
    );
    const d2 = (await r2.json()) as {
      headcount: { extraGuests: number; extraGuestNames: string[] };
    };
    expect(d2.headcount.extraGuests).toBe(2);
    expect(d2.headcount.extraGuestNames).toEqual(['Dave, Mike']);

    // 4. Bootstrap exposes extra_guest_names on the RSVP row and pre-event push includes names
    const bootAfter = (await (await worker.fetch(makeReq('/api/bootstrap'), env)).json()) as {
      thisWeek: {
        rsvps: Array<{ user_slug: string; extra_guests: number; extra_guest_names: string }>;
        headcount: { extraGuests: number; extraGuestNames: string[]; totalGoing: number; goingMembers: number; lateMembers: number; outMembers: number; activeCrewCount: number; unansweredCount: number };
      };
    };
    const tylerRsvp = bootAfter.thisWeek.rsvps.find((r) => r.user_slug === 'tyler');
    expect(tylerRsvp?.extra_guests).toBe(2);
    expect(tylerRsvp?.extra_guest_names).toBe('Dave, Mike');

    const place = await env.DB.prepare('SELECT * FROM restaurants LIMIT 1').first<RestaurantRow>();
    const pushPayload = buildPreEventHeadcountPayload(
      dinnerId,
      place!,
      bootAfter.thisWeek.headcount,
      'https://maps.google.com',
    );
    expect(pushPayload.body).toContain('1 member + 2 extra (Dave, Mike)');

    // 5. Clearing extraGuests to 0 clears extra_guest_names automatically
    const r3 = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'in', extraGuests: 0 }),
      env,
    );
    const d3 = (await r3.json()) as {
      headcount: { extraGuests: number; extraGuestNames: string[] };
    };
    expect(d3.headcount.extraGuests).toBe(0);
    expect(d3.headcount.extraGuestNames).toEqual([]);

    // 6. Switching to Out clears both extra_guests and extra_guest_names
    await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'in', extraGuests: 1, extraGuestNames: 'Sam' }),
      env,
    );
    const rOut = await worker.fetch(
      makeReq('/api/week/rsvp', 'POST', { dinnerId, status: 'out' }),
      env,
    );
    const dOut = (await rOut.json()) as {
      headcount: { extraGuests: number; extraGuestNames: string[] };
    };
    expect(dOut.headcount.extraGuests).toBe(0);
    expect(dOut.headcount.extraGuestNames).toEqual([]);

    // 7. Changelog, UI wiring, and CACHE_NAME verification
    const entry22 = WHATS_NEW_RELEASES.find((e) => e.issueNumber === 22);
    expect(entry22).toBeDefined();
    expect(entry22?.creditSlug).toBe('tyler');
    const appJs = readFileSync(resolve(rootDir, 'public/app.js'), 'utf8');
    expect(appJs).toContain('rsvp-extra-names');
    expect(appJs).toContain('save-extra-names');
    expect(appJs).toContain('extra_guest_names');
    const swJs = readFileSync(resolve(rootDir, 'public/sw.js'), 'utf8');
    expect(swJs).toMatch(/const CACHE_NAME = 'man-night-shell-v\d+'/);
  });
});
