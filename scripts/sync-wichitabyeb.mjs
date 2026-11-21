#!/usr/bin/env node
/**
 * Syncs dinner-eligible Wichita restaurants & closing alerts from Wichita By E.B.
 * (https://www.wichitabyeb.com/wp-json/wp/v2/) into Man Night via /admin/restaurants/sync.
 *
 * Excludes food trucks/mobile vendors, coffee shops/tea/boba bars, bakeries/donuts/dessert-only
 * shops, home-based/retail stores, and unbuilt "Coming Soon" announcements.
 */

import fs from 'node:fs';
import path from 'node:path';

const WBEB_BASE = 'https://www.wichitabyeb.com/wp-json/wp/v2';
const DEFAULT_API_URL = process.env.MAN_NIGHT_URL || 'https://dinner.tylermiranda.com';

// Directory category IDs from wp/v2/restaurants_dir_cat
const DIR_EXCLUDED_ANY_CATS = new Set([
  3311, // Coffee Shop
  3310, // Donuts
  3317, // Shave Ice
  3379, // Boba Shop/Juice Bar
  3629, // Tea
  3384, // Kombucha
]);

const DIR_NON_DINNER_ONLY_CATS = new Set([
  3341, // Bakery
  3316, // Dessert
  3309, // Breakfast
  3311, // Coffee Shop
  3310, // Donuts
  3317, // Shave Ice
  3379, // Boba Shop/Juice Bar
  3629, // Tea
  3384, // Kombucha
  3383, // Drinks
]);

// WordPress post categories & tags
const POST_CAT_FIRST_LOOK = 12;
const POST_CAT_REVIEW = 8;
const POST_CAT_NEWS = 3;
const POST_CAT_EXCLUDED_ANY = new Set([
  44, // Food Trucks
  43, // Dessert
  4, // Experiences
  5, // Things To Do
  21, // Escape Room
  5744, // Board Games
  18, // Product Review
  2, // Recipes
  27, // Q&A Series
  5079, // The Eddytorial
]);
const POST_CAT_BREAKFAST = 11;
const POST_DINNER_CATS = new Set([
  15, 14, 31, 54, 64, 29, 39, 13, 47, 24, 35, 20, 69, 38, 10, 83, 34, 82,
]);

const POST_TAG_COMING_SOON = 3650;
const POST_TAG_CLOSINGS = 3649;
const POST_TAG_EXCLUDED = new Set([
  3650, // Coming Soon
  3649, // Closings
  3666, // Best Things
  3635, // Guides
  3661, // Family Fun Series
  238, // Coffee
  204, // Donuts
  239, // Ice Cream
  211, // Shaved Ice
  293, // Bakery
  3288, // Home-Based
  301, // Events
  366, // Most Liked
  5081, // Podcast
]);

const METRO_CITIES = new Set([
  'wichita',
  'derby',
  'andover',
  'maize',
  'goddard',
  'haysville',
  'bel aire',
  'park city',
  'valley center',
  'kechi',
  'augusta',
  'rose hill',
  'mulvane',
  'benton',
  'colwich',
  'andale',
  'clearwater',
  'cheney',
  'sedgwick',
]);

const EXCLUDED_NAME_OR_BODY_RE =
  /\b(food\s+truck|food\s+trailer|mobile\s+(?:kitchen|food|vendor|trailer)|coffee\s*(?:shop|house|bar|co\.?|company|roaster|roasters|roastery)?|espresso|coffeehouse|roaster(?:s|y)?|cold\s+brew|boba|bubble\s+tea|milk\s+tea|matcha|smoothie|juice\s+bar|donut|doughnut|bakery|patisserie|cupcake|ice\s+cream|gelato|frozen\s+yogurt|froyo|shave\s+ice|shaved\s+ice|snow\s+cone|snowball|candy|chocolat(?:e|ier)|popcorn|cookies?|crumbl|dutch\s+bros|scooter'?s\s+coffee|starbucks|7\s+brew|biggby|reverie\s+coffee|mokas|auntie\s+anne'?s|cinnabon)\b/i;

const GENERIC_SINGLE_TOKENS = new Set([
  'pizza',
  'tacos',
  'taco',
  'cafe',
  'grill',
  'bar',
  'bbq',
  'bakery',
  'kitchen',
  'diner',
  'chinese',
  'mexican',
  'thai',
  'burger',
  'burgers',
  'coffee',
  'sushi',
  'ramen',
  'pho',
  'chicken',
  'wings',
  'steakhouse',
  'restaurant',
  'bistro',
  'pub',
]);

const GENERIC_MATCH_SUFFIXES =
  /\b(restaurant|bar\s*&\s*grill|bar\s+and\s+grill|grill|cafe|kitchen|bistro|eatery|diner|cantina|pizzeria|steakhouse|pub)\b/g;

function parseArgs(argv) {
  const opts = {
    mode: 'weekly',
    since: '',
    apply: false,
    dryRun: true,
    out: '',
    payload: '',
    geocode: false,
    apiUrl: DEFAULT_API_URL,
  };
  for (const arg of argv) {
    if (arg === '--apply') {
      opts.apply = true;
      opts.dryRun = false;
    } else if (arg === '--dry-run') {
      opts.dryRun = true;
      opts.apply = false;
    } else if (arg === '--geocode') {
      opts.geocode = true;
    } else if (arg.startsWith('--mode=')) {
      opts.mode = arg.slice('--mode='.length);
    } else if (arg.startsWith('--since=')) {
      opts.since = arg.slice('--since='.length);
    } else if (arg.startsWith('--out=')) {
      opts.out = arg.slice('--out='.length);
    } else if (arg.startsWith('--payload=')) {
      opts.payload = arg.slice('--payload='.length);
    } else if (arg.startsWith('--api-url=')) {
      opts.apiUrl = arg.slice('--api-url='.length).replace(/\/+$/, '');
    }
  }
  return opts;
}

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&ndash;/gi, '–')
    .replace(/&mdash;/gi, '—')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"');
}

function stripHtml(htmlStr) {
  return decodeHtmlEntities(
    String(htmlStr || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h1|h2|h3|h4|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizeMatchName(name) {
  const base = decodeHtmlEntities(String(name || ''))
    .replace(/['’`]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '');
  const stripped = base.replace(GENERIC_MATCH_SUFFIXES, '').replace(/\s+/g, ' ').trim();
  return stripped.length >= 4 ? stripped : base;
}

function normalizeStrictName(name) {
  return decodeHtmlEntities(String(name || ''))
    .replace(/['’`]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^the\s+/, '');
}

function extractStreetNumber(address) {
  const m = String(address || '').match(/\b(\d{2,5})\s+[a-z0-9]/i);
  return m ? m[1] : null;
}

async function fetchJson(url, headers = {}) {
  const resp = await fetch(url, {
    headers: {
      'User-Agent': 'ManNightDinnerClub/1.0 (https://dinner.tylermiranda.com)',
      ...headers,
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`HTTP ${resp.status} for ${url}: ${body.slice(0, 200)}`);
  }
  const data = await resp.json();
  return { data, headers: resp.headers };
}

async function fetchWpAllPages(endpoint, extraParams = {}) {
  const out = [];
  let page = 1;
  let totalPages = 1;
  do {
    const params = new URLSearchParams({
      per_page: '100',
      page: String(page),
      ...extraParams,
    });
    const url = `${WBEB_BASE}/${endpoint}?${params.toString()}`;
    const { data, headers } = await fetchJson(url);
    if (!Array.isArray(data) || data.length === 0) break;
    out.push(...data);
    const hdrTotal = Number(headers.get('x-wp-totalpages') || '1');
    if (Number.isFinite(hdrTotal) && hdrTotal > 0) totalPages = hdrTotal;
    if (data.length < 100) break;
    page += 1;
  } while (page <= totalPages);
  return out;
}

async function fetchTaxMap(endpoint) {
  const terms = await fetchWpAllPages(endpoint);
  return new Map(terms.map((t) => [Number(t.id), decodeHtmlEntities(t.name)]));
}

function buildAdminHeaders() {
  const id = process.env.CF_ACCESS_CLIENT_ID?.trim();
  const secret = process.env.CF_ACCESS_CLIENT_SECRET?.trim();
  if (!id || !secret) return {};
  return {
    'CF-Access-Client-Id': id,
    'CF-Access-Client-Secret': secret,
  };
}

async function fetchAdminSyncStatus(apiUrl) {
  const hdrs = buildAdminHeaders();
  if (!hdrs['CF-Access-Client-Id']) {
    throw new Error('CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set to talk to Man Night admin API');
  }
  const { data } = await fetchJson(`${apiUrl}/admin/sync-status`, hdrs);
  return data;
}

function isNonDinnerDirectoryItem(item, catMap, cityName) {
  const name = decodeHtmlEntities(item?.title?.rendered || '').trim();
  if (!name || name.length < 2) return true;

  const cats = (item.restaurants_dir_cat || []).map(Number);
  if (cats.some((c) => DIR_EXCLUDED_ANY_CATS.has(c))) return true;
  if (cats.length > 0 && cats.every((c) => DIR_NON_DINNER_ONLY_CATS.has(c))) return true;

  const df = item.drts_fields && typeof item.drts_fields === 'object' && !Array.isArray(item.drts_fields)
    ? item.drts_fields
    : {};
  const rtypes = Array.isArray(df.field_restaurant_type) ? df.field_restaurant_type : [];
  if (
    rtypes.some((rt) =>
      /food truck|mobile vendor|home-based|store\/retail/i.test(String(rt)),
    )
  ) {
    return true;
  }

  if (EXCLUDED_NAME_OR_BODY_RE.test(name)) return true;

  const catNames = cats.map((id) => catMap.get(id) || '').join(' ');
  if (/coffee|donut|shave ice|boba|tea/i.test(catNames)) return true;

  if (cityName && !METRO_CITIES.has(cityName.toLowerCase())) return true;
  return false;
}

function extractAddressAndCityFromDir(item, locMap) {
  const df = item.drts_fields && typeof item.drts_fields === 'object' && !Array.isArray(item.drts_fields)
    ? item.drts_fields
    : {};
  const la = Array.isArray(df.location_address) && df.location_address[0] ? df.location_address[0] : {};
  const locTermId = (item.restaurants_loc_loc || [])[0];
  const locCity = locTermId ? locMap.get(Number(locTermId)) || '' : '';
  const city = String(la.city || locCity || 'Wichita').trim() || 'Wichita';
  const street = String(la.street || '').trim();
  const street2 = String(la.street2 || '').trim();
  const zip = String(la.zip || '').trim();
  let address = '';
  if (street) {
    address = `${street}${street2 ? ` ${street2}` : ''}, ${city}, KS${zip ? ` ${zip}` : ''}`;
  } else if (la.display_address) {
    address = String(la.display_address).trim();
  }
  const lat = Number.isFinite(Number(la.lat)) && Number(la.lat) !== 0 ? Number(la.lat) : null;
  const lng = Number.isFinite(Number(la.lng)) && Number(la.lng) !== 0 ? Number(la.lng) : null;
  const yearOpened = Array.isArray(df.field_year_opened) && df.field_year_opened[0]
    ? Number(df.field_year_opened[0])
    : null;
  return { address, city, lat, lng, yearOpened };
}

function extractAddressFromPostText(text) {
  // Look for standard Wichita-area street address lines in post body
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const fullAddrRe =
    /\b(\d{2,5}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:St\.?|Street|Ave\.?|Avenue|Rd\.?|Road|Blvd\.?|Boulevard|Dr\.?|Drive|Ln\.?|Lane|Ct\.?|Court|Way|Pkwy\.?|Parkway|Pl\.?|Place|Cir\.?|Circle|Hwy|Highway)(?:\s+(?:Ste\.?|Suite|#)\s*[A-Za-z0-9-]+)?(?:\s*,\s*(?:Wichita|Derby|Andover|Maize|Goddard|Haysville|Bel Aire|Park City|Valley Center|Kechi|Augusta|Rose Hill|Mulvane)(?:,\s*KS(?:\s+\d{5})?)?)?)\b/i;

  for (const line of lines.slice(0, 35)) {
    const m = line.match(fullAddrRe);
    if (m) {
      let addr = m[1].replace(/\s+/g, ' ').trim();
      let city = 'Wichita';
      for (const c of METRO_CITIES) {
        if (new RegExp(`\\b${c}\\b`, 'i').test(line)) {
          city = c.replace(/\b\w/g, (ch) => ch.toUpperCase());
          break;
        }
      }
      if (!/,\s*KS/i.test(addr)) {
        if (!new RegExp(`\\b${city}\\b`, 'i').test(addr)) {
          addr = `${addr}, ${city}, KS`;
        } else {
          addr = `${addr}, KS`;
        }
      }
      return { address: addr, city };
    }
  }
  return { address: '', city: 'Wichita' };
}

function parseOpeningNameFromPostTitle(title) {
  let clean = decodeHtmlEntities(title).trim();
  const patterns = [
    /^(?:a\s+)?first\s+look\s+(?:at|inside)\s+/i,
    /^sneak\s+peek\s+(?:at|inside)\s+/i,
    /^what\s+to\s+expect\s+(?:at|inside)\s+/i,
    /^revisiting\s+/i,
    /^grabbing\s+[^f]*?\s+from\s+/i,
  ];
  for (const re of patterns) {
    clean = clean.replace(re, '');
  }
  clean = clean
    .replace(/\s+(?:inside|in)\s+the\s+former\s+.*$/i, '')
    .replace(/\s+(?:officially|now)\s+opens?.*$/i, '')
    .replace(/\s+in\s+(?:downtown\s+wichita|east\s+wichita|west\s+wichita|northwest\s+wichita|wichita|derby|andover|maize|goddard)(?:,\s*ks)?$/i, '')
    .replace(/[:;].*$/, '')
    .trim();
  return clean;
}

function isOpeningPostCandidate(post, postCatMap) {
  const title = decodeHtmlEntities(post?.title?.rendered || '').trim();
  const cats = (post.categories || []).map(Number);
  const tags = (post.tags || []).map(Number);

  if (tags.some((t) => POST_TAG_EXCLUDED.has(t))) return false;
  if (cats.some((c) => POST_CAT_EXCLUDED_ANY.has(c))) return false;
  if (cats.includes(POST_CAT_BREAKFAST) && !cats.some((c) => POST_DINNER_CATS.has(c))) return false;

  const isFirstLook = cats.includes(POST_CAT_FIRST_LOOK);
  const isOpeningNews = /\b(now open|officially opens?|grand opening|soft opening|first look|sneak peek)\b/i.test(title);
  if (!isFirstLook && !isOpeningNews) return false;
  if (/\b(best things|weekend|list of|top \d+|most liked|deal|deals|thanksgiving|pumpkin|career fair|expansion|to open in 20\d\d|will expand|coming soon|revisiting)\b/i.test(title)) {
    return false;
  }

  const bodyText = stripHtml(post?.content?.rendered || '');
  const headText = `${title}\n${bodyText.slice(0, 700)}`;
  if (EXCLUDED_NAME_OR_BODY_RE.test(headText)) return false;

  // Check if post explicitly says it's still not open yet
  if (/\b(scheduled to open|set to open|opening later|coming to|under construction)\b/i.test(bodyText.slice(0, 400))) {
    if (!/\b(now open|open for business|opened on|soft opening)\b/i.test(bodyText.slice(0, 600))) {
      return false;
    }
  }

  const name = parseOpeningNameFromPostTitle(title);
  if (!name || name.length < 3 || EXCLUDED_NAME_OR_BODY_RE.test(name)) return false;
  const cuisineList = cats
    .filter((c) => c !== POST_CAT_FIRST_LOOK && c !== POST_CAT_REVIEW && c !== POST_CAT_NEWS && c !== 6)
    .map((c) => postCatMap.get(c))
    .filter(Boolean);
  return { name, cuisine: cuisineList.join(', ') };
}

function isNonRestaurantClosingPost(title, bodyText) {
  return /\b(weather related|wind related|snow|ice storm|memorial day|thanksgiving|christmas|holiday|sedgwick county zoo|stingray cove|museum|school closings)\b/i.test(
    `${title} ${bodyText.slice(0, 250)}`,
  );
}

function isClosingRoundup(title) {
  return /\b(list of|closings from|marks the end|bite size news|roundup|recent closings)\b/i.test(title);
}

function extractClosingItemsFromPost(post) {
  const title = decodeHtmlEntities(post?.title?.rendered || '').trim();
  const html = String(post?.content?.rendered || '');
  const bodyText = stripHtml(html);
  const postDate = String(post.date || '').slice(0, 10);
  const postUrl = post.link;
  const wpPostId = Number(post.id);

  if (isNonRestaurantClosingPost(title, bodyText)) return [];

  if (isClosingRoundup(title)) {
    const items = [];
    // Extract strong/heading blocks paired with following text until next strong/heading
    const segRe = /<(?:strong|h2|h3)[^>]*>([\s\S]*?)<\/(?:strong|h2|h3)>([\s\S]*?)(?=<(?:strong|h2|h3)[^>]*>|$)/gi;
    let m;
    while ((m = segRe.exec(html)) !== null) {
      const heading = stripHtml(m[1]).replace(/\s*[–—-]\s*$/, '').trim();
      const snippet = stripHtml(m[2]).slice(0, 450);
      if (!heading || heading.length < 3 || heading.length > 80) continue;
      if (/^(stay connected|want to work|support wichita|contact us|read more|subscribe)/i.test(heading)) continue;
      items.push({
        wpPostId,
        postTitle: `${heading} (${title})`,
        postUrl,
        postDate,
        candidateName: heading.split(/\s+[–—-]\s+/)[0].trim(),
        snippet: `${heading} ${snippet}`,
        isRoundupItem: true,
      });
    }
    if (items.length > 0) return items;
  }

  return [
    {
      wpPostId,
      postTitle: title,
      postUrl,
      postDate,
      candidateName: title,
      snippet: `${title}\n${bodyText.slice(0, 800)}`,
      isRoundupItem: false,
    },
  ];
}

function doesRestaurantMatchClosingItem(rest, item) {
  const rawName = String(rest.name || '').trim();
  if (!rawName) return null;
  const strictName = normalizeStrictName(rawName);
  const normName = normalizeMatchName(rawName);
  const haystackStrict = normalizeStrictName(item.isRoundupItem ? item.candidateName : item.postTitle);
  const bodyStrict = normalizeStrictName(item.snippet);

  // Guard against ultra-short or malformed DB names like "Pizza /"
  if (rawName.includes('/') || strictName.length < 4) {
    if (strictName.length >= 4 && haystackStrict === strictName) {
      return 'exact';
    }
    return null;
  }
  if (GENERIC_SINGLE_TOKENS.has(normName) || normName.length < 4) {
    if (strictName.length >= 5 && new RegExp(`\\b${strictName}\\b`).test(haystackStrict)) {
      return 'exact';
    }
    return null;
  }

  // Prefer title / roundup-heading match first
  if (
    new RegExp(`\\b${strictName}\\b`).test(haystackStrict) ||
    (normName.length >= 5 && new RegExp(`\\b${normName}\\b`).test(haystackStrict))
  ) {
    return 'title';
  }

  // For single-post news, require strict full name in title (not arbitrary body mentions like "previously Lola's")
  if (!item.isRoundupItem) return null;
  if (strictName.length >= 6 && new RegExp(`\\b${strictName}\\b`).test(bodyStrict.slice(0, 200))) {
    return 'roundup_body';
  }
  return null;
}

function classifyClosingConfidence(rest, item) {
  const txt = `${item.postTitle} ${item.snippet}`.toLowerCase();
  const postDate = item.postDate;

  // If Man Night ate at this place well AFTER the closing article, it reopened — skip
  if (rest.visit_count > 0 && rest.last_visited && rest.last_visited > postDate) {
    const diffDays = (Date.parse(rest.last_visited) - Date.parse(postDate)) / 86400000;
    if (diffDays > 60) {
      return { action: 'skip', reason: `Visited on ${rest.last_visited}, after ${postDate} article` };
    }
    return { action: 'flag', confidence: 'reopened_check', reason: `Visited ${rest.last_visited} near closing article (${postDate})` };
  }

  // Temporary closure, rebrand, relocation, ownership change, or menu change -> flag for review
  if (
    /\b(temporar|rebrand|relocat|moving to|new location|new ownership|could soon|uncertain future|drops bbq|changes menu|in hopes of finding)\b/i.test(
      txt,
    )
  ) {
    return { action: 'flag', confidence: 'temporary_or_change', reason: 'Temporary closure, relocation, or rebrand mentioned' };
  }

  // Multi-location / branch-specific closing -> auto-close ONLY if street number matches DB address, or post states it's the final/last location
  const isFinalAll = /\b(final|last store|last location|all .* closed)\b/i.test(txt);
  const isBranchSpecific = /\b(one of|remaining|west side|east side|bradley fair|south wichita|north|oldest|original location|second|towne east)\b/i.test(
    txt,
  );
  if (isBranchSpecific && !isFinalAll) {
    const restStreet = extractStreetNumber(rest.address);
    if (restStreet && new RegExp(`\\b${restStreet}\\b`).test(txt)) {
      return { action: 'close', reason: `Matching location (${restStreet}) reported closed by Wichita By E.B.` };
    }
    return { action: 'flag', confidence: 'single_branch', reason: 'Branch-specific closure; verify address matches club entry' };
  }

  // Permanent closing phrasing
  if (
    item.isRoundupItem ||
    /\b(permanently closed|has closed|to close|closes|closed permanently|close its doors|close for good|left the wichita market|appears to have closed|no longer with us)\b/i.test(
      txt,
    )
  ) {
    return { action: 'close', reason: item.postTitle };
  }

  return { action: 'flag', confidence: 'ambiguous', reason: 'Mentioned in Closings tag; verify permanent status' };
}

async function geocodeAddressNominatim(address) {
  if (!address) return null;
  const params = new URLSearchParams({ q: address, format: 'json', limit: '1' });
  const { data } = await fetchJson(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
  if (Array.isArray(data) && data[0]) {
    const lat = Number(data[0].lat);
    const lng = Number(data[0].lon);
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  return null;
}

async function postSyncBatch(apiUrl, payload) {
  const hdrs = {
    'Content-Type': 'application/json',
    ...buildAdminHeaders(),
  };
  const resp = await fetch(`${apiUrl}/admin/restaurants/sync`, {
    method: 'POST',
    headers: hdrs,
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Sync POST failed (${resp.status}): ${text}`);
  }
  return JSON.parse(text);
}

async function applyPayloadInBatches(apiUrl, payload) {
  const upserts = Array.isArray(payload.upserts) ? payload.upserts : [];
  const closings = Array.isArray(payload.closings) ? payload.closings : [];
  const flags = Array.isArray(payload.flags) ? payload.flags : [];
  const chunkSize = 150;

  if (upserts.length <= chunkSize) {
    return postSyncBatch(apiUrl, payload);
  }

  const totals = {
    ok: true,
    addedCount: 0,
    updatedCount: 0,
    closedCount: 0,
    flaggedCount: 0,
    batches: 0,
    finalResult: null,
  };

  for (let i = 0; i < upserts.length; i += chunkSize) {
    const isLast = i + chunkSize >= upserts.length;
    const chunkPayload = {
      mode: payload.mode || 'backfill',
      cursorPostDate: payload.cursorPostDate || null,
      recordRun: isLast,
      upserts: upserts.slice(i, i + chunkSize),
      closings: isLast ? closings : [],
      flags: isLast ? flags : [],
    };
    const res = await postSyncBatch(apiUrl, chunkPayload);
    totals.batches += 1;
    totals.addedCount += Number(res.addedCount || 0);
    totals.updatedCount += Number(res.updatedCount || 0);
    totals.closedCount += Number(res.closedCount || 0);
    totals.flaggedCount += Number(res.flaggedCount || 0);
    totals.finalResult = res;
  }
  return totals;
}

async function buildSyncPayload(opts) {
  let existingRestaurants = [];
  let latestCursor = opts.since || '';

  try {
    const status = await fetchAdminSyncStatus(opts.apiUrl);
    existingRestaurants = status.restaurants || [];
    if (!latestCursor && opts.mode === 'weekly' && status.latestRun?.cursor_post_date) {
      latestCursor = status.latestRun.cursor_post_date;
    }
  } catch (err) {
    if (opts.apply) throw err;
    console.warn(`Warning: could not fetch /admin/sync-status (${err.message}); continuing standalone dry-run.`);
  }

  if (!latestCursor) {
    latestCursor = opts.mode === 'backfill' ? '2025-01-01T00:00:00' : new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 19);
  }

  const [dirCatMap, locMap, postCatMap] = await Promise.all([
    fetchTaxMap('restaurants_dir_cat'),
    fetchTaxMap('restaurants_loc_loc'),
    fetchTaxMap('categories'),
  ]);

  // 1. Fetch closing posts
  const closingParams = { tags: String(POST_TAG_CLOSINGS) };
  if (opts.mode === 'weekly' && latestCursor) {
    closingParams.after = latestCursor;
  }
  const closingPosts = await fetchWpAllPages('posts', closingParams);
  const closingItems = closingPosts.flatMap(extractClosingItemsFromPost);

  // If backfill mode, also pull all closing posts to filter closed directory items
  const allClosingItems = opts.mode === 'backfill'
    ? closingItems
    : (await fetchWpAllPages('posts', { tags: String(POST_TAG_CLOSINGS) })).flatMap(extractClosingItemsFromPost);

  // 2. Build upserts
  const upserts = [];
  const skippedStats = { dirExcluded: 0, dirClosed: 0, postExcluded: 0 };

  if (opts.mode === 'backfill') {
    // CRITICAL: omit _fields on restaurants_dir_ltg so drts_fields is populated
    const dirItems = await fetchWpAllPages('restaurants_dir_ltg');
    for (const item of dirItems) {
      const { address, city, lat, lng, yearOpened } = extractAddressAndCityFromDir(item, locMap);
      if (isNonDinnerDirectoryItem(item, dirCatMap, city)) {
        skippedStats.dirExcluded += 1;
        continue;
      }
      const name = decodeHtmlEntities(item.title?.rendered || '').trim();
      const cats = (item.restaurants_dir_cat || []).map((id) => dirCatMap.get(Number(id))).filter(Boolean);
      const fakeRest = { name, address, visit_count: 0, last_visited: null };
      const closingMatch = allClosingItems.find((ci) => {
        if (!doesRestaurantMatchClosingItem(fakeRest, ci)) return false;
        const cls = classifyClosingConfidence(fakeRest, ci);
        return cls.action === 'close';
      });
      if (closingMatch) {
        skippedStats.dirClosed += 1;
        continue;
      }
      const discoveredAt = yearOpened && yearOpened >= 1900 ? `${yearOpened}-01-01` : String(item.date || '').slice(0, 10);
      upserts.push({
        name,
        address,
        city,
        lat,
        lng,
        cuisine: cats.join(', '),
        source: 'wichitabyeb_dir',
        sourceExternalId: `wbeb-dir-${item.id}`,
        sourceUrl: item.link,
        discoveredAt,
      });
    }
  }

  // 3. Fetch recent / 2025+ opening posts (First Look + News/Reviews)
  const postAfter = latestCursor.includes('T') ? latestCursor : `${latestCursor.slice(0, 10)}T00:00:00`;
  const [firstLookPosts, newsPosts] = await Promise.all([
    fetchWpAllPages('posts', { categories: String(POST_CAT_FIRST_LOOK), after: postAfter }),
    fetchWpAllPages('posts', { categories: `${POST_CAT_NEWS},${POST_CAT_REVIEW}`, after: postAfter }),
  ]);

  const seenPostIds = new Set();
  const allCandidatePosts = [...firstLookPosts, ...newsPosts].filter((p) => {
    if (seenPostIds.has(p.id)) return false;
    seenPostIds.add(p.id);
    return true;
  });

  let maxPostDate = latestCursor;
  for (const p of [...allCandidatePosts, ...closingPosts]) {
    if (p.date && p.date > maxPostDate) maxPostDate = p.date;
  }

  const openingPosts = [];
  for (const post of allCandidatePosts) {
    const parsed = isOpeningPostCandidate(post, postCatMap);
    if (!parsed) {
      skippedStats.postExcluded += 1;
      continue;
    }
    const bodyText = stripHtml(post?.content?.rendered || '');
    const { address, city } = extractAddressFromPostText(bodyText);
    let coords = null;
    if (opts.geocode && address) {
      await new Promise((r) => setTimeout(r, 1100));
      coords = await geocodeAddressNominatim(address).catch(() => null);
    }
    openingPosts.push({ post, bodyText });
    upserts.push({
      name: parsed.name,
      address,
      city,
      lat: coords?.lat ?? null,
      lng: coords?.lng ?? null,
      cuisine: parsed.cuisine,
      source: 'wichitabyeb_post',
      sourceExternalId: `wbeb-post-${post.id}`,
      sourceUrl: post.link,
      discoveredAt: String(post.date || '').slice(0, 10),
    });
  }

  // 4. Match closings against existing Man Night DB restaurants
  const closings = [];
  const flags = [];
  const seenClosings = new Set();
  const seenFlags = new Set();

  for (const rest of existingRestaurants) {
    if (Number(rest.is_closed) === 1 || Number(rest.status_locked) === 1) continue;
    for (const item of closingItems) {
      const matchKind = doesRestaurantMatchClosingItem(rest, item);
      if (!matchKind) continue;
      const decision = classifyClosingConfidence(rest, item);
      if (decision.action === 'close') {
        if (!seenClosings.has(rest.id)) {
          seenClosings.add(rest.id);
          closings.push({
            restaurantId: rest.id,
            slug: rest.slug,
            name: rest.name,
            closedAt: item.postDate,
            reason: decision.reason,
            sourceUrl: item.postUrl,
          });
        }
      } else if (decision.action === 'flag') {
        const key = `${rest.id}:${item.wpPostId}`;
        if (!seenFlags.has(key) && !seenClosings.has(rest.id)) {
          seenFlags.add(key);
          flags.push({
            restaurantId: rest.id,
            slug: rest.slug,
            wpPostId: item.wpPostId,
            postTitle: item.postTitle,
            postUrl: item.postUrl,
            postDate: item.postDate,
            confidence: decision.confidence,
            reason: decision.reason,
          });
        }
      }
    }
  }

  // Check "former X space" mentions in First Look posts for unreported closings
  for (const { post, bodyText } of openingPosts) {
    const formerMatch = bodyText.match(/\bformer\s+([A-Z][A-Za-z0-9'& .-]{3,40}?)\s+(?:space|location|building|spot|restaurant)\b/);
    if (!formerMatch) continue;
    const formerName = formerMatch[1].trim();
    for (const rest of existingRestaurants) {
      if (Number(rest.is_closed) === 1 || Number(rest.status_locked) === 1) continue;
      const syntheticItem = {
        wpPostId: Number(post.id),
        postTitle: `Replaced in "${decodeHtmlEntities(post.title?.rendered || '')}"`,
        postUrl: post.link,
        postDate: String(post.date || '').slice(0, 10),
        candidateName: formerName,
        snippet: bodyText.slice(0, 400),
        isRoundupItem: true,
      };
      if (doesRestaurantMatchClosingItem(rest, syntheticItem)) {
        const key = `${rest.id}:${post.id}`;
        if (!seenClosings.has(rest.id) && !seenFlags.has(key)) {
          seenFlags.add(key);
          flags.push({
            restaurantId: rest.id,
            slug: rest.slug,
            wpPostId: Number(post.id),
            postTitle: syntheticItem.postTitle,
            postUrl: post.link,
            postDate: syntheticItem.postDate,
            confidence: 'replaced_space',
            reason: `Mentioned as "former ${formerName} space" in new First Look post`,
          });
        }
      }
    }
  }

  return {
    payload: {
      mode: opts.mode,
      cursorPostDate: maxPostDate,
      upserts,
      closings,
      flags,
    },
    meta: {
      existingCount: existingRestaurants.length,
      closingPostsScanned: closingPosts.length,
      openingPostsScanned: allCandidatePosts.length,
      skippedStats,
    },
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let payload;
  let meta = null;

  if (opts.payload) {
    payload = JSON.parse(fs.readFileSync(path.resolve(opts.payload), 'utf8'));
  } else {
    const built = await buildSyncPayload(opts);
    payload = built.payload;
    meta = built.meta;
  }

  if (opts.out) {
    fs.writeFileSync(path.resolve(opts.out), JSON.stringify(payload, null, 2));
  }

  const summary = {
    mode: payload.mode,
    cursorPostDate: payload.cursorPostDate,
    upsertsCount: (payload.upserts || []).length,
    closingsCount: (payload.closings || []).length,
    flagsCount: (payload.flags || []).length,
    meta,
  };

  if (opts.dryRun || !opts.apply) {
    console.log(JSON.stringify({ dryRun: true, summary, sampleUpserts: (payload.upserts || []).slice(0, 10), closings: payload.closings, flags: payload.flags }, null, 2));
    return;
  }

  const result = await applyPayloadInBatches(opts.apiUrl, payload);
  console.log(JSON.stringify({ dryRun: false, summary, result }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
