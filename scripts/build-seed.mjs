import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..');

const placesRaw = JSON.parse(readFileSync(resolve(rootDir, 'data/seed/places.json'), 'utf8'));
const geoEnriched = JSON.parse(readFileSync(resolve(rootDir, 'data/seed/geo_enriched.json'), 'utf8'));
const icsText = readFileSync(resolve(rootDir, 'data/seed/man_night.ics'), 'utf8');

function sqlStr(val) {
  if (val === null || val === undefined) return 'NULL';
  return "'" + String(val).replace(/'/g, "''") + "'";
}

function sqlNum(val) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return 'NULL';
  return String(Number(val));
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'place';
}

function cleanPlaceName(item) {
  let name = item.name.trim();
  if (item.key === 'https www google com maps place la chona con huevos') {
    return 'La Chona con Huevos';
  }
  if (item.key === 'dinner') {
    return 'Pour Haus Restaurant & Tavern';
  }
  if (item.key === 'old chicago old town anchorman') {
    return 'Old Chicago (Old Town)';
  }
  if (item.key === 'bjs no homo') {
    return "BJ's Restaurant & Brewhouse";
  }
  name = name.replace(/^Dinner\s*(?:@|at)\s+/i, '');
  name = name.replace(/\s+\d{3,5}\s+[NSEW]\.?\s+.*$/i, '').trim();
  return name || item.name.trim();
}

function cleanAddress(item) {
  if (item.key === 'https www google com maps place la chona con huevos') {
    return 'La Chona con Huevos, 3415 E Harry St, Wichita, KS 67218';
  }
  return (item.addr || '').replace(/\s+/g, ' ').trim();
}

function extractCity(addr) {
  const m = addr.match(/,\s*(Wichita|Derby|Andover|Haysville|Mulvane|Bel Aire|Maize|Goddard|Valley Center|Park City|Fort Collins|Las Vegas)\b/i);
  return m ? m[1] : 'Wichita';
}

// Drop non-venue placeholders so we keep 226 distinct real places
const SKIP_KEYS = new Set(['hello dan', 'jacobs']);
const filteredPlaces = placesRaw.filter((p) => !SKIP_KEYS.has(p.key));

const usedSlugs = new Set();
const restaurants = filteredPlaces.map((p, idx) => {
  let slug = slugify(p.key);
  if (usedSlugs.has(slug)) slug = `${slug}-${idx + 1}`;
  usedSlugs.add(slug);
  const name = cleanPlaceName(p);
  const addr = cleanAddress(p);
  const coords = geoEnriched[p.key] || null;
  return {
    id: idx + 1,
    key: p.key,
    slug,
    name,
    address: addr,
    city: extractCity(addr || name),
    lat: coords ? Number(coords[0]) : null,
    lng: coords ? Number(coords[1]) : null,
    seedVisits: Number(p.visits) || 0,
    seedLast: p.last || null,
  };
});

// Helper lookup table sorted longest key/name first for ICS text matching
const matchCandidates = restaurants
  .flatMap((r) => {
    const tokens = new Set([
      r.key.toLowerCase(),
      r.name.toLowerCase(),
      slugify(r.name).replace(/-/g, ' '),
    ]);
    return [...tokens]
      .filter((t) => t.length >= 3)
      .map((t) => ({ token: t, restaurant: r }));
  })
  .sort((a, b) => b.token.length - a.token.length);

// Specific ICS text normalization aliases -> existing restaurant keys
const ALIAS_KEYS = [
  ['deano', 'deanos'],
  ['poplar', 'poplar'],
  ['polar', 'poplar'],
  ['poblano', 'poblanos'],
  ['firehouse', 'firehouse subs'],
  ['fire house', 'fire house subs'],
  ['mediterranean', 'mediterranean'],
  ['bj', 'bjs brewhouse'],
  ['tacos tj 664', 'tacos tj'],
  ['taco tj', 'tacos tj'],
  ['el mexico', 'el mexico'],
  ['el méxico', 'el mexico'],
  ['bricktown', 'bricktown brewery'],
  ['mango tree', 'mango tree'],
  ['jumbo', 'jumbos beef brew'],
  ['o\'malley', 'omalleys irish pub'],
  ['omalley', 'omalleys irish pub'],
  ['tor brewing', 'tor brewing'],
  ['wichita brewing', 'wichita brewing pizzeria'],
  ['wbc', 'wichita brewing pizzeria'],
  ['bubba', 'bubbas'],
  ['cheddar', 'cheddars scratch kitchen'],
  ['river city', 'river city brewing'],
  ['green mill', 'green mill'],
  ['el gordo', 'el gordo'],
  ['empire taco', 'empire tacos'],
  ['pourhouse', 'pourhouse'],
  ['pour house', 'pourhouse'],
  ['oak & pie', 'oak pie'],
  ['oak and pie', 'oak pie'],
  ['monarch', 'monarch'],
  ['hog wild', 'hog wild'],
  ['ziggy', 'ziggys pizza'],
  ['casey', 'caseys'],
  ['carlos o\'kelly', 'carlos okellys'],
  ['carlos okelly', 'carlos okellys'],
  ['los coco', 'los cocos'],
  ['fuzzy', 'fuzzys taco shop'],
  ['kansas star', 'kansas star casino'],
  ['rusty nail', 'rusty nail'],
  ['norton', 'nortons brewing'],
  ['old town burrito', 'old town burritos'],
  ['naan stop', 'naan stop'],
  ['harry\'s uptown', 'harrys uptown'],
  ['harrys uptown', 'harrys uptown'],
  ['point nine', 'point nine'],
  ['depot pizza', 'depot pizza taps'],
  ['tommy\'s apizza', 'tommys apizza'],
  ['tommys apizza', 'tommys apizza'],
  ['tanker bbq', 'tanker bbq'],
  ['mortdecai', 'mortdecais tavern eatery'],
  ['bronx pizza', 'bronx pizza pints'],
  ['johnny\'s tavern', 'johnnys tavern wichita'],
  ['o\'larney', 'olarneys pub rooftop'],
  ['puerto vallarta', 'puerto vallarta mexican wichita ks'],
  ['amy’s pizza', 'w d munson primary school'],
  ['amy\'s pizza', 'w d munson primary school'],
  ['la chona', 'https www google com maps place la chona con huevos'],
  ['nelson', 'nelsons kitchen'],
];

const byKey = new Map(restaurants.map((r) => [r.key, r]));

function matchRestaurant(location, summary) {
  const locClean = (location || '').toLowerCase().trim();
  const sumPlacePart = (summary || '').replace(/^man\s*night\s*@\s*[^.:\-\n]+/i, '').toLowerCase();
  const norm = (s) => s.replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const targets = [locClean, norm(locClean), sumPlacePart, norm(sumPlacePart)].filter(Boolean);

  for (const target of targets) {
    for (const [needle, key] of ALIAS_KEYS) {
      if (target.includes(needle) && byKey.has(key)) return byKey.get(key);
    }
    for (const cand of matchCandidates) {
      if (target.includes(cand.token)) return cand.restaurant;
    }
  }
  return null;
}

// Parse ICS VEVENTs
const unfolded = icsText.replace(/\r\n /g, '').replace(/\n /g, '');
const rawBlocks = [...unfolded.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((m) => m[1]);

function unesc(s) {
  return (s || '')
    .replace(/\\,/g, ',')
    .replace(/\\n/g, ' ')
    .replace(/\\;/g, ';')
    .replace(/\s+/g, ' ')
    .trim();
}

function getField(block, field) {
  const m = block.match(new RegExp(`^${field}(?:;[^:]*)?:(.*)$`, 'm'));
  return m ? unesc(m[1]) : '';
}

function isoWeekKey(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((dt.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${dt.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function dayName(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return names[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

const HOST_PAT = /\b(Chuck|Jacob|Eric|Heath|Tyler|Don|Dan)s?\b/i;
function extractHost(summary, location) {
  const s = `${summary} ${location}`;
  const m = s.match(HOST_PAT);
  if (!m) return { slug: null, label: 'Group' };
  const cap = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return { slug: cap.toLowerCase(), label: cap };
}

const parsedEvents = rawBlocks
  .map((block) => {
    const dt = getField(block, 'DTSTART');
    if (!dt || dt.length < 8) return null;
    const dinnerDate = `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
    const tPart = dt.match(/T(\d{2})(\d{2})/);
    const startTime = tPart ? `${tPart[1]}:${tPart[2]}` : '18:30';
    const summary = getField(block, 'SUMMARY');
    const location = getField(block, 'LOCATION');
    const uid = getField(block, 'UID');
    if (/cancel|no man night|skipped/i.test(summary)) return null;
    const host = extractHost(summary, location);
    const restaurant = matchRestaurant(location, summary);
    return {
      dinnerDate,
      weekKey: isoWeekKey(dinnerDate),
      startTime,
      dayOfWeek: dayName(dinnerDate),
      hostSlug: host.slug,
      hostLabel: host.label,
      restaurant,
      rawLocation: location,
      rawSummary: summary,
      icsUid: uid,
    };
  })
  .filter(Boolean);

// Deduplicate historical dinners <= 2026-11-10 into 1 record per ISO week (exact 614 historical dinners)
const histByWeek = new Map();
for (const ev of parsedEvents) {
  if (ev.dinnerDate > '2026-11-10') continue;
  const arr = histByWeek.get(ev.weekKey) || [];
  arr.push(ev);
  histByWeek.set(ev.weekKey, arr);
}

const historicalDinners = [...histByWeek.entries()]
  .map(([weekKey, evs]) => {
    const chosen = evs.sort((a, b) => {
      const scoreA = (a.restaurant ? 4 : 0) + (a.rawLocation ? 2 : 0) + (a.hostSlug ? 1 : 0);
      const scoreB = (b.restaurant ? 4 : 0) + (b.rawLocation ? 2 : 0) + (b.hostSlug ? 1 : 0);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return b.dinnerDate.localeCompare(a.dinnerDate);
    })[0];
    let restaurant = chosen.restaurant;
    let rawLocation = chosen.rawLocation;
    let chosenVia = 'seed';
    if (weekKey === '2026-W46' && !restaurant) {
      restaurant = byKey.get('el mexico') || restaurants.find((r) => r.id === 7) || null;
      if (restaurant && !rawLocation) {
        rawLocation = restaurant.address || 'El Mexico Cafe, 2544 S Seneca St, Wichita, KS 67217, USA';
      }
      chosenVia = 'backfill';
    }
    return {
      weekKey,
      dinnerDate: chosen.dinnerDate,
      startTime: chosen.startTime,
      dayOfWeek: chosen.dayOfWeek,
      hostSlug: chosen.hostSlug,
      hostLabel: chosen.hostLabel,
      restaurantId: restaurant ? restaurant.id : null,
      rawLocation,
      rawSummary: chosen.rawSummary,
      icsUid: chosen.icsUid,
      status: 'completed',
      chosenVia,
      isHistorical: 1,
    };
  })
  .sort((a, b) => a.dinnerDate.localeCompare(b.dinnerDate));

// Upcoming weeks from Nov 17 onward (first live poll is Eric's week)
const deanos = byKey.get('deanos') || restaurants.find((r) => /deano/i.test(r.name)) || null;
const upcomingDinners = [
  {
    weekKey: '2026-W47',
    dinnerDate: '2026-11-17',
    startTime: '18:30',
    dayOfWeek: 'Tuesday',
    hostSlug: 'eric',
    hostLabel: 'Eric',
    restaurantId: null,
    rawLocation: '',
    rawSummary: "Man Night @ Eric's",
    icsUid: null,
    status: 'night_poll',
    chosenVia: 'pending',
    nightPollOpenedAt: '2026-11-15T16:00:00Z',
    isHistorical: 0,
  },
  {
    weekKey: '2026-W48',
    dinnerDate: '2026-11-24',
    startTime: '18:30',
    dayOfWeek: 'Tuesday',
    hostSlug: 'tyler',
    hostLabel: 'Tyler',
    restaurantId: null,
    rawLocation: '',
    rawSummary: "Man Night @ Tyler's",
    icsUid: null,
    status: 'scheduled',
    chosenVia: 'pending',
    isHistorical: 0,
  },
  {
    weekKey: '2026-W49',
    dinnerDate: '2026-12-01',
    startTime: '18:30',
    dayOfWeek: 'Tuesday',
    hostSlug: 'heath',
    hostLabel: 'Heath',
    restaurantId: deanos ? deanos.id : null,
    rawLocation: deanos ? deanos.address : "Deano's Grill and Tapworks EAST, 9747 E 21st St N Ste 101, Wichita, KS 67206, USA",
    rawSummary: "Man Night @ Heath's.",
    icsUid: null,
    status: 'scheduled',
    chosenVia: deanos ? 'picker' : 'pending',
    isHistorical: 0,
  },
  {
    weekKey: '2026-W50',
    dinnerDate: '2026-12-08',
    startTime: '18:30',
    dayOfWeek: 'Tuesday',
    hostSlug: 'chuck',
    hostLabel: 'Chuck',
    restaurantId: null,
    rawLocation: '',
    rawSummary: "Man Night @ Chuck's",
    icsUid: null,
    status: 'scheduled',
    chosenVia: 'pending',
    isHistorical: 0,
  },
  {
    weekKey: '2026-W51',
    dinnerDate: '2026-12-15',
    startTime: '18:30',
    dayOfWeek: 'Tuesday',
    hostSlug: 'jacob',
    hostLabel: 'Jacob',
    restaurantId: null,
    rawLocation: '',
    rawSummary: "Man Night @ Jacob's",
    icsUid: null,
    status: 'scheduled',
    chosenVia: 'pending',
    isHistorical: 0,
  },
];

// Recompute exact visit_count & last_visited combining linked dinners & seeded baseline
const linkedCounts = new Map();
const linkedLast = new Map();
for (const d of historicalDinners) {
  if (!d.restaurantId) continue;
  linkedCounts.set(d.restaurantId, (linkedCounts.get(d.restaurantId) || 0) + 1);
  const prev = linkedLast.get(d.restaurantId) || '';
  if (d.dinnerDate > prev) linkedLast.set(d.restaurantId, d.dinnerDate);
}

for (const r of restaurants) {
  const c = linkedCounts.get(r.id) || 0;
  r.visitCount = Math.max(c, r.seedVisits);
  const l = linkedLast.get(r.id) || '';
  r.lastVisited = l > (r.seedLast || '') ? l : r.seedLast;
}

const users = [
  ['chuck', 'Chuck', 'bigheadwillie@gmail.com', 'avc', 'C', 1, 1],
  ['jacob', 'Jacob', 'werth6of7@gmail.com', 'avj', 'J', 1, 2],
  ['eric', 'Eric', 'storme2@gmail.com', 'ave', 'E', 1, 3],
  ['tyler', 'Tyler', 'tyler.miranda@gmail.com', 'avt', 'T', 1, 4],
  ['heath', 'Heath', 'heath.thome@gmail.com', 'avh', 'H', 1, 5],
  ['dan', 'Dan', 'dcbourque@gmail.com', 'avd', 'Da', 0, null],
  ['don', 'Don', 'don@history.local', 'avn', 'Do', 0, null],
];

const lines = ['-- Generated by scripts/build-seed.mjs', ''];

for (const [slug, name, email, avClass, initials, isRot, rotOrder] of users) {
  lines.push(
    `INSERT OR IGNORE INTO users (slug, name, email, avatar_class, initials, is_rotation, rotation_order) VALUES (${sqlStr(slug)}, ${sqlStr(name)}, ${sqlStr(email)}, ${sqlStr(avClass)}, ${sqlStr(initials)}, ${isRot}, ${sqlNum(rotOrder)});`,
  );
}
lines.push('');

for (const r of restaurants) {
  lines.push(
    `INSERT OR REPLACE INTO restaurants (id, slug, name, address, city, lat, lng, visit_count, last_visited) VALUES (${r.id}, ${sqlStr(r.slug)}, ${sqlStr(r.name)}, ${sqlStr(r.address)}, ${sqlStr(r.city)}, ${sqlNum(r.lat)}, ${sqlNum(r.lng)}, ${r.visitCount}, ${sqlStr(r.lastVisited)});`,
  );
}
lines.push('');

for (const d of [...historicalDinners, ...upcomingDinners]) {
  lines.push(
    `INSERT OR REPLACE INTO dinners (week_key, dinner_date, start_time, day_of_week, host_slug, host_label, restaurant_id, raw_location, raw_summary, ics_uid, status, chosen_via, night_poll_opened_at, is_historical) VALUES (${sqlStr(d.weekKey)}, ${sqlStr(d.dinnerDate)}, ${sqlStr(d.startTime)}, ${sqlStr(d.dayOfWeek)}, ${sqlStr(d.hostSlug)}, ${sqlStr(d.hostLabel)}, ${sqlNum(d.restaurantId)}, ${sqlStr(d.rawLocation)}, ${sqlStr(d.rawSummary)}, ${sqlStr(d.icsUid)}, ${sqlStr(d.status)}, ${sqlStr(d.chosenVia)}, ${sqlStr(d.nightPollOpenedAt ?? null)}, ${d.isHistorical});`,
  );
}

const outPath = resolve(rootDir, 'migrations/0002_seed_history.sql');
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

const matchedPlacesCount = historicalDinners.filter((d) => d.restaurantId !== null).length;
const geocodedCount = restaurants.filter((r) => r.lat !== null && r.lng !== null).length;
console.log(JSON.stringify({
  historicalDinners: historicalDinners.length,
  historicalWithPlace: matchedPlacesCount,
  distinctPlaces: restaurants.length,
  geocodedPlaces: geocodedCount,
  upcomingDinners: upcomingDinners.length,
  outputFile: 'migrations/0002_seed_history.sql',
}, null, 2));
