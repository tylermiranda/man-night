import { resolveAuthUser } from './auth';
import { WHATS_NEW_RELEASES, buildWhatsNewPayload, isValidWhatsNewId } from './changelog';
import { runWeeklyCronTick } from './cron';
import { sendWebPushToSubscribers } from './push';
import type { Env, LuckyPool, RestaurantRow } from './types';
import {
  applyRotationOverride,
  backfillDinnerPlace,
  castNightVote,
  castNoonVote,
  castRsvp,
  closeNoonVote,
  createBeer,
  createIssueReport,
  createPlacePoll,
  createRestaurant,
  deleteBeer,
  deleteMealPhoto,
  drawLuckyPlaces,
  getActiveDinner,
  getBeerPhotoBinary,
  getBootstrapPayload,
  getCentralDateStr,
  getDinnerReviews,
  getIssueReportScreenshot,
  getMealPhotoBinary,
  getPlaceReviews,
  listBeers,
  listMealPhotos,
  lockNight,
  lockPlace,
  openNoonDraw,
  safeRestaurantSelectSql,
  setDinnerMealPrice,
  submitRating,
  updateBeer,
  uploadMealPhoto,
} from './workflow';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new Error('Invalid JSON request body');
  }
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (path === '/api/health' && method === 'GET') {
    const dbCheck = await env.DB.prepare('SELECT COUNT(*) AS dinners FROM dinners').first<{ dinners: number }>();
    return json({ ok: true, service: 'man-night', dinners: Number(dbCheck?.dinners ?? 0) });
  }

  if (path === '/api/logout' && (method === 'GET' || method === 'POST')) {
    const headers = new Headers({
      'Cache-Control': 'no-store',
    });
    headers.append(
      'Set-Cookie',
      'CF_Authorization=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    );
    headers.append(
      'Set-Cookie',
      'CF_AppSession=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax',
    );
    if (method === 'GET') {
      headers.set('Location', `${url.origin}/cdn-cgi/access/logout`);
      return new Response(null, { status: 302, headers });
    }
    headers.set('Content-Type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify({ ok: true, logoutUrl: '/cdn-cgi/access/logout' }), { status: 200, headers });
  }

  const auth = await resolveAuthUser(request, env);
  if (!auth.user) {
    return json(
      {
        error: 'Unauthorized club member',
        email: auth.email,
        via: auth.via,
      },
      403,
    );
  }
  const user = auth.user;

  try {
    if (path === '/api/bootstrap' && method === 'GET') {
      return json(await getBootstrapPayload(env, user));
    }

    if (path === '/api/user/walkthrough' && method === 'POST') {
      await env.DB.prepare("UPDATE users SET walkthrough_seen_at = datetime('now') WHERE slug = ?")
        .bind(user.slug)
        .run();
      return json({ ok: true });
    }

    if (path === '/api/whats-new' && method === 'GET') {
      const users =
        (await env.DB.prepare('SELECT slug, name FROM users').all<{ slug: string; name: string }>()).results ?? [];
      return json(buildWhatsNewPayload(user.whats_new_seen_id ?? null, users));
    }

    if (path === '/api/user/whats-new' && method === 'POST') {
      const rawText = (await request.text()).trim();
      let body: { seenId?: unknown } = {};
      if (rawText.length > 0) {
        try {
          const parsed = JSON.parse(rawText);
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            body = parsed as { seenId?: unknown };
          } else {
            return json({ error: 'Invalid JSON request body' }, 400);
          }
        } catch {
          return json({ error: 'Invalid JSON request body' }, 400);
        }
      }
      let targetId: string | null = null;
      if (body.seenId === undefined || body.seenId === null || body.seenId === '') {
        targetId = WHATS_NEW_RELEASES[0]?.id ?? null;
      } else if (typeof body.seenId === 'string' && isValidWhatsNewId(body.seenId.trim())) {
        targetId = body.seenId.trim();
      } else {
        return json({ error: 'Invalid What’s New release id' }, 400);
      }
      await env.DB.prepare("UPDATE users SET whats_new_seen_id = ?, whats_new_seen_at = datetime('now') WHERE slug = ?")
        .bind(targetId, user.slug)
        .run();
      return json({ ok: true, seenId: targetId });
    }

    if (path === '/api/user/prefs' && method === 'PATCH') {
      const body = await readJson<{
        notify_night_vote?: boolean;
        notify_place?: boolean;
        notify_reminder?: boolean;
      }>(request);
      await env.DB.prepare(
        `UPDATE users
         SET notify_night_vote = COALESCE(?, notify_night_vote),
             notify_place = COALESCE(?, notify_place),
             notify_reminder = COALESCE(?, notify_reminder)
         WHERE slug = ?`,
      )
        .bind(
          body.notify_night_vote === undefined ? null : body.notify_night_vote ? 1 : 0,
          body.notify_place === undefined ? null : body.notify_place ? 1 : 0,
          body.notify_reminder === undefined ? null : body.notify_reminder ? 1 : 0,
          user.slug,
        )
        .run();
      return json({ ok: true });
    }

    if (path === '/api/push/subscribe' && method === 'POST') {
      const body = await readJson<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>(request);
      if (!body.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
        return json({ error: 'Invalid Web Push subscription payload' }, 400);
      }
      await env.DB.prepare(
        `INSERT INTO push_subscriptions (user_slug, endpoint, p256dh, auth, user_agent, last_used_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(endpoint)
         DO UPDATE SET user_slug = excluded.user_slug, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
      )
        .bind(
          user.slug,
          body.endpoint,
          body.keys.p256dh,
          body.keys.auth,
          (request.headers.get('User-Agent') || '').slice(0, 200),
        )
        .run();
      return json({ ok: true });
    }

    if (path === '/api/push/unsubscribe' && method === 'POST') {
      const body = await readJson<{ endpoint?: string }>(request);
      if (body.endpoint) {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_slug = ?')
          .bind(body.endpoint, user.slug)
          .run();
      } else {
        await env.DB.prepare('DELETE FROM push_subscriptions WHERE user_slug = ?').bind(user.slug).run();
      }
      return json({ ok: true });
    }

    if (path === '/api/push/test' && method === 'POST') {
      const res = await sendWebPushToSubscribers(
        env,
        {
          title: 'Man Night push works',
          body: `Heads-up test for ${user.name}. Tapping opens Google Maps on dinner night.`,
          tag: 'man-night-test',
          url: env.APP_URL,
        },
        'all',
        [user.slug],
      );
      return json({ ok: true, ...res });
    }

    if (path === '/api/week/vote-night' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number; choice: 'tuesday' | 'wednesday'; reason?: string }>(request);
      if (body.choice !== 'tuesday' && body.choice !== 'wednesday') {
        return json({ error: 'Choice must be tuesday or wednesday' }, 400);
      }
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const tally = await castNightVote(env.DB, dinner.id, user.slug, body.choice, body.reason);
      return json({ ok: true, ...tally });
    }

    if (path === '/api/week/pick-place' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: number;
        restaurantId: number;
        dayOfWeek?: string;
        keepNightVote?: boolean;
      }>(request);
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const dayChoice =
        body.dayOfWeek === 'Tuesday' || body.dayOfWeek === 'Wednesday' ? body.dayOfWeek : undefined;
      const res = await lockPlace(
        env,
        dinner.id,
        Number(body.restaurantId),
        'picker',
        dayChoice || body.keepNightVote === false ? 'Host picked directly (no vote)' : '',
        dayChoice,
        { keepNightVote: body.keepNightVote },
      );
      return json({ ok: true, ...res });
    }

    if (path === '/api/week/create-poll' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: number;
        restaurantIds: number[];
        dayOfWeek?: string;
        keepNightVote?: boolean;
      }>(request);
      if (!Array.isArray(body.restaurantIds)) {
        return json({ error: 'restaurantIds array is required' }, 400);
      }
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const dayChoice =
        body.dayOfWeek === 'Tuesday' || body.dayOfWeek === 'Wednesday' ? body.dayOfWeek : undefined;
      const res = await createPlacePoll(env, dinner.id, body.restaurantIds.map(Number), {
        keepNightVote: body.keepNightVote,
        dayChoice,
      });
      return json({ ok: true, ...res });
    }

    if (path === '/api/week/lucky' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: number;
        mode?: string;
        count?: unknown;
        pool?: string;
        excludeIds?: unknown;
        commit?: boolean;
        dayOfWeek?: string;
        keepNightVote?: boolean;
      }>(request);

      const mode = body.mode === undefined ? 'pick' : body.mode;
      if (mode !== 'pick' && mode !== 'poll') {
        return json({ error: 'Mode must be pick or poll' }, 400);
      }

      const pool = body.pool === undefined ? 'any' : body.pool;
      if (pool !== 'any' && pool !== 'regulars' && pool !== 'comeback' && pool !== 'top_rated') {
        return json({ error: 'Invalid pool filter' }, 400);
      }

      let count = 1;
      if (mode === 'pick') {
        if (body.count !== undefined && body.count !== 1) {
          return json({ error: 'Pick mode draws 1 place' }, 400);
        }
        count = 1;
      } else {
        const rawCount = body.count === undefined ? 4 : body.count;
        if (typeof rawCount !== 'number' || !Number.isInteger(rawCount) || rawCount < 2 || rawCount > 6) {
          return json({ error: 'Poll count must be between 2 and 6' }, 400);
        }
        count = rawCount;
      }

      let excludeIds: number[] = [];
      if (body.excludeIds !== undefined) {
        if (!Array.isArray(body.excludeIds)) {
          return json({ error: 'excludeIds must be an array' }, 400);
        }
        excludeIds = body.excludeIds.map(Number).filter((n) => Number.isInteger(n) && n > 0);
      }

      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id, dinner_date, status FROM dinners WHERE id = ?')
            .bind(body.dinnerId)
            .first<{ id: number; dinner_date: string; status: string }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      if (dinner.status === 'completed') {
        return json({ error: 'Completed dinner cannot use I’m Feeling Lucky' }, 400);
      }

      const todayStr = getCentralDateStr(new Date(), env.CLUB_TIMEZONE || 'America/Chicago');
      const drawn = await drawLuckyPlaces(env.DB, {
        dinnerId: dinner.id,
        referenceDate: dinner.dinner_date || todayStr,
        todayStr,
        count,
        pool: pool as LuckyPool,
        excludeIds,
      });

      if (!body.commit) {
        return json({
          ok: true,
          mode,
          committed: false,
          place: mode === 'pick' ? (drawn.places[0] ?? null) : null,
          places: drawn.places,
          poolRequested: drawn.poolRequested,
          poolUsed: drawn.poolUsed,
          eligibleCount: drawn.eligibleCount,
        });
      }

      if (drawn.places.length === 0) {
        return json({ error: 'No restaurants available' }, 400);
      }

      const dayChoice =
        body.dayOfWeek === 'Tuesday' || body.dayOfWeek === 'Wednesday' ? body.dayOfWeek : undefined;

      if (mode === 'pick') {
        const res = await lockPlace(
          env,
          dinner.id,
          drawn.places[0].id,
          'picker',
          dayChoice || body.keepNightVote === false ? "Host picked via I'm Feeling Lucky (no vote)" : '',
          dayChoice,
          { keepNightVote: body.keepNightVote },
        );
        return json({
          ok: true,
          mode: 'pick',
          committed: true,
          place: res.restaurant,
          places: [res.restaurant],
          dinner: res.dinner,
          calendar: res.calendar,
          poolRequested: drawn.poolRequested,
          poolUsed: drawn.poolUsed,
          eligibleCount: drawn.eligibleCount,
        });
      }

      if (drawn.places.length < 2) {
        return json({ error: 'Need at least 2 restaurants for a poll' }, 400);
      }
      const res = await createPlacePoll(
        env,
        dinner.id,
        drawn.places.map((p) => p.id),
        { keepNightVote: body.keepNightVote, dayChoice },
      );
      return json({
        ok: true,
        mode: 'poll',
        committed: true,
        places: res.candidates,
        candidates: res.candidates,
        dinner: res.dinner,
        poolRequested: drawn.poolRequested,
        poolUsed: drawn.poolUsed,
        eligibleCount: drawn.eligibleCount,
      });
    }

    if (path === '/api/week/close-poll' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number }>(request);
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const res = await closeNoonVote(env, dinner.id);
      return json({ ok: true, ...res });
    }

    if (path === '/api/week/vote-noon' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number; restaurantId: number }>(request);
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const tallies = await castNoonVote(env.DB, dinner.id, user.slug, Number(body.restaurantId));
      return json({ ok: true, tallies });
    }

    if (path === '/api/week/rsvp' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: number;
        userSlug?: string;
        status: 'in' | 'late' | 'out' | 'clear';
        etaMinutes?: number | null;
        note?: string;
        extraGuests?: unknown;
      }>(request);
      if (!['in', 'late', 'out', 'clear'].includes(body.status)) {
        return json({ error: 'Invalid RSVP status' }, 400);
      }
      let extraGuests: number | undefined;
      if (body.extraGuests !== undefined && body.extraGuests !== null) {
        if (
          typeof body.extraGuests !== 'number' ||
          !Number.isInteger(body.extraGuests) ||
          body.extraGuests < 0 ||
          body.extraGuests > 20
        ) {
          return json({ error: 'extraGuests must be a whole number from 0 to 20' }, 400);
        }
        extraGuests = body.extraGuests;
      }
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const targetSlug = (typeof body.userSlug === 'string' && body.userSlug.trim().toLowerCase()) || user.slug;
      const headcount = await castRsvp(
        env.DB,
        dinner.id,
        targetSlug,
        body.status,
        body.etaMinutes ?? null,
        body.note,
        user.slug,
        extraGuests,
      );
      return json({ ok: true, headcount });
    }

    if (path === '/api/week/rate' && method === 'POST') {
      const body = await readJson<{
        dinnerId: number;
        score: number;
        dish?: string;
        appetizer?: string;
        comment?: string;
        price?: number | string | null;
      }>(request);
      const dinnerId = Number(body.dinnerId);
      const score = Number(body.score);
      if (!Number.isInteger(dinnerId) || dinnerId <= 0) {
        return json({ error: 'Valid dinnerId is required' }, 400);
      }
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        return json({ error: 'Score must be 1 to 5' }, 400);
      }
      const rating = await submitRating(
        env.DB,
        dinnerId,
        user.slug,
        score,
        body.dish ?? '',
        body.comment ?? '',
        body.price ?? null,
        body.appetizer ?? '',
      );
      return json({ ok: true, rating });
    }

    if (path === '/api/week/rotation' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number; action: 'pass' | 'swap'; targetSlug?: string }>(request);
      if (body.action !== 'pass' && body.action !== 'swap') {
        return json({ error: 'Invalid rotation action' }, 400);
      }
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      const updated = await applyRotationOverride(env.DB, dinner.id, body.action, body.targetSlug ?? null, user.slug);
      return json({ ok: true, dinner: updated });
    }

    // Controlled admin/preview triggers for manual workflow advancement if the picker/group triggers early
    if (path === '/api/week/advance' && method === 'POST') {
      const body = await readJson<{ dinnerId?: number; stage: 'lock_night' | 'open_noon' | 'close_noon' }>(request);
      const dinner = body.dinnerId
        ? await env.DB.prepare('SELECT id FROM dinners WHERE id = ?').bind(body.dinnerId).first<{ id: number }>()
        : await getActiveDinner(env.DB);
      if (!dinner) return json({ error: 'No active dinner found' }, 404);
      if (body.stage === 'lock_night') return json({ ok: true, dinner: await lockNight(env, dinner.id) });
      if (body.stage === 'open_noon') return json({ ok: true, ...(await openNoonDraw(env, dinner.id)) });
      if (body.stage === 'close_noon') return json({ ok: true, ...(await closeNoonVote(env, dinner.id)) });
    }

    if (path === '/api/places' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const todayStr = getCentralDateStr(new Date(), env.CLUB_TIMEZONE || 'America/Chicago');
      const rows = (
        await env.DB.prepare(
          `SELECT ${safeRestaurantSelectSql('r')},
                  (SELECT COUNT(*) FROM ratings rt WHERE rt.restaurant_id = r.id) AS rating_count,
                  (SELECT COUNT(*) FROM meal_photos mp WHERE mp.restaurant_id = r.id) AS photo_count,
                  (SELECT ROUND(AVG(rt.price), 2) FROM ratings rt WHERE rt.restaurant_id = r.id AND rt.price IS NOT NULL) AS avg_meal_price
           FROM restaurants r
           ORDER BY visit_count DESC, r.name ASC`,
        )
          .bind(todayStr, todayStr, todayStr, todayStr)
          .all<RestaurantRow>()
      ).results ?? [];
      const filtered = q
        ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.address.toLowerCase().includes(q))
        : rows;

      const limitParam = url.searchParams.get('limit');
      const offsetParam = url.searchParams.get('offset');
      const pageParam = url.searchParams.get('page');
      const hasPagination = limitParam !== null || offsetParam !== null || pageParam !== null;

      if (!hasPagination) {
        return json({ places: filtered, total: filtered.length });
      }

      const rawLimit = Number.parseInt(limitParam || '15', 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 200) : 15;
      const total = filtered.length;
      const totalPages = Math.max(1, Math.ceil(total / limit));

      let currentPage = 1;
      let offset = 0;
      if (pageParam !== null) {
        const rawPage = Number.parseInt(pageParam, 10);
        currentPage = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, totalPages) : 1;
        offset = (currentPage - 1) * limit;
      } else if (offsetParam !== null) {
        const rawOffset = Number.parseInt(offsetParam, 10);
        offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
        currentPage = Math.max(1, Math.min(totalPages, Math.floor(offset / limit) + 1));
      }

      return json({
        places: filtered.slice(offset, offset + limit),
        total,
        limit,
        offset,
        page: currentPage,
        totalPages,
      });
    }

    const placeReviewsMatch = path.match(/^\/api\/places\/(\d+)\/reviews$/);
    if (placeReviewsMatch && method === 'GET') {
      return json(
        await getPlaceReviews(env.DB, Number(placeReviewsMatch[1]), user.slug, env.CLUB_TIMEZONE || 'America/Chicago'),
      );
    }

    const dinnerReviewsMatch = path.match(/^\/api\/dinners\/(\d+)\/reviews$/);
    if (dinnerReviewsMatch && method === 'GET') {
      return json(await getDinnerReviews(env.DB, Number(dinnerReviewsMatch[1])));
    }

    const dinnerPriceMatch = path.match(/^\/api\/dinners\/(\d+)\/price$/);
    if (dinnerPriceMatch && method === 'POST') {
      const dinnerId = Number(dinnerPriceMatch[1]);
      const body = await readJson<{ price?: number | string | null }>(request);
      const res = await setDinnerMealPrice(env.DB, dinnerId, body.price ?? null);
      return json({ ok: true, ...res });
    }

    const photoImageMatch = path.match(/^\/api\/photos\/(\d+)\/image$/);
    if (photoImageMatch && method === 'GET') {
      const photoId = Number(photoImageMatch[1]);
      const etag = `"meal-photo-${photoId}"`;
      if (request.headers.get('If-None-Match') === etag) {
        const exists = await env.DB.prepare('SELECT id FROM meal_photos WHERE id = ?')
          .bind(photoId)
          .first<{ id: number }>();
        if (!exists) return json({ error: 'Photo not found' }, 404);
        return new Response(null, {
          status: 304,
          headers: {
            ETag: etag,
            'Cache-Control': 'private, max-age=604800, immutable',
          },
        });
      }
      const photo = await getMealPhotoBinary(env.DB, photoId);
      if (!photo) return json({ error: 'Photo not found' }, 404);
      return new Response(photo.bytes, {
        status: 200,
        headers: {
          'Content-Type': photo.mimeType,
          'Content-Length': String(photo.bytes.byteLength),
          'Cache-Control': 'private, max-age=604800, immutable',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        },
      });
    }

    if (path === '/api/photos' && method === 'GET') {
      const dinnerIdRaw = url.searchParams.get('dinnerId');
      const placeIdRaw = url.searchParams.get('placeId');
      const limitRaw = url.searchParams.get('limit');
      let dinnerId: number | undefined;
      let placeId: number | undefined;
      let limit: number | undefined;
      if (dinnerIdRaw !== null && dinnerIdRaw !== '') {
        const parsed = Number(dinnerIdRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return json({ error: 'Valid dinnerId is required' }, 400);
        }
        dinnerId = parsed;
      }
      if (placeIdRaw !== null && placeIdRaw !== '') {
        const parsed = Number(placeIdRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return json({ error: 'Valid placeId is required' }, 400);
        }
        placeId = parsed;
      }
      if (limitRaw !== null && limitRaw !== '') {
        const parsed = Number(limitRaw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return json({ error: 'Valid limit is required' }, 400);
        }
        limit = parsed;
      }
      return json({ photos: await listMealPhotos(env.DB, { dinnerId, placeId, limit }) });
    }

    if (path === '/api/photos' && method === 'POST') {
      const body = await readJson<{
        dinnerId?: unknown;
        imageData?: unknown;
        mimeType?: string;
        dish?: string;
        appetizer?: string;
        caption?: string;
        width?: number | null;
        height?: number | null;
      }>(request);
      if (typeof body.imageData !== 'string' || body.imageData.trim().length === 0) {
        return json({ error: 'imageData is required' }, 400);
      }
      let targetDinnerId: number | undefined;
      if (body.dinnerId !== undefined && body.dinnerId !== null && body.dinnerId !== '') {
        const parsedId = Number(body.dinnerId);
        if (!Number.isInteger(parsedId) || parsedId <= 0) {
          return json({ error: 'Valid dinnerId is required' }, 400);
        }
        const found = await env.DB.prepare('SELECT id FROM dinners WHERE id = ?')
          .bind(parsedId)
          .first<{ id: number }>();
        if (!found) return json({ error: 'Dinner not found' }, 404);
        targetDinnerId = found.id;
      } else {
        const active = await getActiveDinner(env.DB);
        if (!active) return json({ error: 'No active dinner found' }, 404);
        targetDinnerId = active.id;
      }
      const photo = await uploadMealPhoto(env.DB, user.slug, {
        dinnerId: targetDinnerId,
        imageData: body.imageData,
        mimeType: body.mimeType,
        dish: body.dish,
        appetizer: body.appetizer,
        caption: body.caption,
        width: body.width ?? null,
        height: body.height ?? null,
      });
      return json({ ok: true, photo }, 201);
    }

    const photoDeleteMatch = path.match(/^\/api\/photos\/(\d+)$/);
    if (photoDeleteMatch && method === 'DELETE') {
      try {
        const res = await deleteMealPhoto(env.DB, Number(photoDeleteMatch[1]), user.slug);
        return json({ ok: true, ...res });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Server error';
        if (message === 'Photo not found') return json({ error: message }, 404);
        if (message.startsWith('Forbidden:')) return json({ error: message }, 403);
        return json({ error: message }, 400);
      }
    }

    if (path === '/api/beers' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim();
      const userSlug = (url.searchParams.get('user') || '').trim().toLowerCase();
      const sort = (url.searchParams.get('sort') || 'recent').trim();
      const limitRaw = url.searchParams.get('limit');
      const limit = limitRaw ? Number(limitRaw) : undefined;
      return json(await listBeers(env.DB, { q, userSlug: userSlug || undefined, sort, limit }));
    }

    if (path === '/api/beers' && method === 'POST') {
      const body = await readJson<{
        name?: string;
        brewery?: string;
        style?: string;
        purchasedWhere?: string;
        rating?: number | string | null;
        notes?: string;
        imageData?: string | null;
        width?: number | null;
        height?: number | null;
      }>(request);
      const beer = await createBeer(env.DB, user.slug, body);
      return json({ ok: true, beer }, 201);
    }

    const beerImageMatch = path.match(/^\/api\/beers\/(\d+)\/image$/);
    if (beerImageMatch && method === 'GET') {
      const beerId = Number(beerImageMatch[1]);
      const etag = `"beer-photo-${beerId}"`;
      if (request.headers.get('If-None-Match') === etag) {
        const exists = await env.DB.prepare('SELECT beer_id FROM beer_photos WHERE beer_id = ?')
          .bind(beerId)
          .first<{ beer_id: number }>();
        if (!exists) return json({ error: 'Photo not found' }, 404);
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': 'private, max-age=604800, immutable' },
        });
      }
      const photo = await getBeerPhotoBinary(env.DB, beerId);
      if (!photo) return json({ error: 'Photo not found' }, 404);
      return new Response(photo.bytes, {
        status: 200,
        headers: {
          'Content-Type': photo.mimeType,
          'Content-Length': String(photo.bytes.byteLength),
          'Cache-Control': 'private, max-age=604800, immutable',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        },
      });
    }

    const beerMatch = path.match(/^\/api\/beers\/(\d+)$/);
    if (beerMatch && method === 'PATCH') {
      const body = await readJson<{
        name?: string;
        brewery?: string;
        style?: string;
        purchasedWhere?: string;
        rating?: number | string | null;
        notes?: string;
        imageData?: string | null;
        width?: number | null;
        height?: number | null;
      }>(request);
      try {
        const beer = await updateBeer(env.DB, Number(beerMatch[1]), user.slug, body);
        return json({ ok: true, beer });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Server error';
        if (message === 'Beer not found') return json({ error: message }, 404);
        if (message.startsWith('Forbidden:')) return json({ error: message }, 403);
        return json({ error: message }, 400);
      }
    }

    if (beerMatch && method === 'DELETE') {
      try {
        const res = await deleteBeer(env.DB, Number(beerMatch[1]), user.slug);
        return json({ ok: true, ...res });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Server error';
        if (message === 'Beer not found') return json({ error: message }, 404);
        if (message.startsWith('Forbidden:')) return json({ error: message }, 403);
        return json({ error: message }, 400);
      }
    }

    if (path === '/api/places' && method === 'POST') {
      const body = await readJson<{ name: string; address?: string; city?: string; lat?: number; lng?: number }>(request);
      const place = await createRestaurant(env.DB, body);
      return json({ ok: true, place }, 201);
    }

    if (path === '/api/history' && method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const host = (url.searchParams.get('host') || '').trim().toLowerCase();
      const placeId = url.searchParams.get('placeId');
      const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit') || 60)));
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0));

      const where: string[] = ["d.status = 'completed'"];
      const binds: unknown[] = [];
      if (host) {
        where.push('d.host_slug = ?');
        binds.push(host);
      }
      if (placeId) {
        where.push('d.restaurant_id = ?');
        binds.push(Number(placeId));
      }
      if (q) {
        where.push('(LOWER(d.host_label) LIKE ? OR LOWER(d.raw_location) LIKE ? OR LOWER(d.raw_summary) LIKE ? OR LOWER(COALESCE(r.name, \'\')) LIKE ?)');
        const pat = `%${q}%`;
        binds.push(pat, pat, pat, pat);
      }

      const sql = `
        SELECT d.id, d.week_key, d.dinner_date, d.day_of_week, d.host_slug, d.host_label,
               d.restaurant_id, d.raw_location, d.raw_summary, d.chosen_via, d.meal_price,
               r.name AS restaurant_name, r.address AS restaurant_address, r.visit_count AS restaurant_visits, r.avg_rating AS restaurant_avg_rating,
               (SELECT COUNT(*) FROM ratings rt WHERE rt.dinner_id = d.id) AS rating_count,
               (SELECT ROUND(AVG(rt.score), 2) FROM ratings rt WHERE rt.dinner_id = d.id) AS dinner_avg_rating,
               COALESCE(d.meal_price, (SELECT ROUND(AVG(rt.price), 2) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL)) AS dinner_avg_price,
               (SELECT COUNT(rt.price) FROM ratings rt WHERE rt.dinner_id = d.id AND rt.price IS NOT NULL) AS price_entry_count,
               (SELECT rt.score FROM ratings rt WHERE rt.dinner_id = d.id AND rt.user_slug = ?) AS my_score,
               (SELECT rt.price FROM ratings rt WHERE rt.dinner_id = d.id AND rt.user_slug = ?) AS my_price,
               (SELECT COUNT(*) FROM meal_photos mp WHERE mp.dinner_id = d.id) AS photo_count
        FROM dinners d
        LEFT JOIN restaurants r ON r.id = d.restaurant_id
        WHERE ${where.join(' AND ')}
        ORDER BY d.dinner_date DESC
        LIMIT ? OFFSET ?
      `;
      const countSql = `
        SELECT COUNT(*) AS total
        FROM dinners d
        LEFT JOIN restaurants r ON r.id = d.restaurant_id
        WHERE ${where.join(' AND ')}
      `;

      const items = (await env.DB.prepare(sql).bind(user.slug, user.slug, ...binds, limit, offset).all()).results ?? [];
      const totalRow = await env.DB.prepare(countSql).bind(...binds).first<{ total: number }>();
      return json({ items, total: Number(totalRow?.total ?? 0), limit, offset });
    }

    const backfillMatch = path.match(/^\/api\/dinners\/(\d+)\/backfill$/);
    if (backfillMatch && method === 'POST') {
      const dinnerId = Number(backfillMatch[1]);
      const body = await readJson<{ restaurantId?: number; newName?: string; newAddress?: string; price?: number | string | null; meal_price?: number | string | null }>(request);
      let restaurantId = body.restaurantId;
      if (!restaurantId && body.newName) {
        const created = await createRestaurant(env.DB, { name: body.newName, address: body.newAddress });
        restaurantId = created.id;
      }
      if (!restaurantId) return json({ error: 'restaurantId or newName required' }, 400);
      const res = await backfillDinnerPlace(
        env.DB,
        dinnerId,
        Number(restaurantId),
        env.CLUB_TIMEZONE || 'America/Chicago',
      );
      if (body.price !== undefined || body.meal_price !== undefined) {
        await setDinnerMealPrice(env.DB, dinnerId, body.price ?? body.meal_price);
      }
      return json({ ok: true, ...res });
    }

    const issueScreenshotMatch = path.match(/^\/api\/issues\/(\d+)\/screenshot$/);
    if (issueScreenshotMatch && method === 'GET') {
      const reportId = Number(issueScreenshotMatch[1]);
      const etag = `"issue-shot-${reportId}"`;
      if (request.headers.get('If-None-Match') === etag) {
        const exists = await env.DB.prepare('SELECT report_id FROM issue_report_screenshots WHERE report_id = ?')
          .bind(reportId)
          .first<{ report_id: number }>();
        if (!exists) return json({ error: 'Screenshot not found' }, 404);
        return new Response(null, {
          status: 304,
          headers: { ETag: etag, 'Cache-Control': 'private, max-age=604800, immutable' },
        });
      }
      const shot = await getIssueReportScreenshot(env.DB, reportId);
      if (!shot) return json({ error: 'Screenshot not found' }, 404);
      return new Response(shot.bytes, {
        status: 200,
        headers: {
          'Content-Type': shot.mimeType,
          'Content-Length': String(shot.bytes.byteLength),
          'Cache-Control': 'private, max-age=604800, immutable',
          ETag: etag,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'",
        },
      });
    }

    if (path === '/api/issues' && method === 'GET') {
      const rows = (
        await env.DB.prepare('SELECT * FROM issue_reports ORDER BY created_at DESC LIMIT 25').all()
      ).results ?? [];
      return json({ issues: rows });
    }

    if (path === '/api/issues' && method === 'POST') {
      const body = await readJson<{
        title: string;
        description: string;
        category?: string;
        pageContext?: string;
        imageData?: string | null;
        width?: number | null;
        height?: number | null;
      }>(request);
      const result = await createIssueReport(env, user, body);
      return json({ ok: true, issue: result }, 201);
    }

    return json({ error: 'Not found' }, 404);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error';
    return json({ error: message }, 400);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runWeeklyCronTick(env, new Date()));
  },
};
