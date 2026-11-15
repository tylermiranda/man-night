const state = {
  tab: 'week',
  bootstrap: null,
  places: [],
  history: [],
  historyTotal: 0,
  historyQuery: '',
  historyHost: '',
  historyPlaceId: null,
  placesQuery: '',
  placesSort: 'visits',
  placesFilter: 'all',
  selectedPlaceId: null,
  placeReviews: {},
  walkStep: 0,
  ratingScore: 5,
  modalRatingScore: 5,
  pickerDay: 'Tuesday',
  pickerKeepNightVote: true,
  pickerAllowKeepNightVote: false,
  pollCandidateIds: [],
  pollSearchQuery: '',
  theme: localStorage.getItem('mn_theme') || 'light',
  deferredInstallPrompt: null,
  installBannerDismissed: localStorage.getItem('mn_install_dismissed') === '1',
  mapInstances: [],
};

function resolveEffectiveTheme(pref) {
  if (pref === 'dark') return 'dark';
  if (pref === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  return 'light';
}

function applyTheme(pref) {
  const valid = pref === 'dark' || pref === 'system' ? pref : 'light';
  state.theme = valid;
  localStorage.setItem('mn_theme', valid);
  document.documentElement.dataset.theme = resolveEffectiveTheme(valid);
}

applyTheme(state.theme);

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (state.theme === 'system') applyTheme('system');
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstallPrompt = e;
  render();
});

window.addEventListener('appinstalled', () => {
  state.deferredInstallPrompt = null;
  toast('Man Night app installed!');
  render();
});

const OSM_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      maxzoom: 19,
    },
  },
  layers: [{ id: 'osm-tiles', type: 'raster', source: 'osm', minzoom: 0, maxzoom: 19 }],
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function fmtShortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function monthLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function shiftIsoDate(isoDate, deltaDays) {
  if (!isoDate) return '';
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return dt.toISOString().slice(0, 10);
}

function parsePollIds(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  } catch {
    return [];
  }
}

function avatarHtml(slug, name, size = '') {
  const users = state.bootstrap?.users || [];
  const u = users.find((x) => x.slug === slug);
  const cls = u?.avatar_class || 'avn';
  const init = u?.initials || (name || '?').slice(0, 1).toUpperCase();
  return `<span class="av ${cls} ${size}">${esc(init)}</span>`;
}

function starsText(score) {
  const s = Math.max(0, Math.min(5, Number(score) || 0));
  return `${'★'.repeat(s)}${'☆'.repeat(5 - s)}`;
}

function renderReviewItem(r, showDate = false) {
  const name = r.user_name || r.user_slug;
  const hasDetails = Boolean(r.dish || r.comment);
  return `
    <div class="review-item">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:6px;">
          ${avatarHtml(r.user_slug, name, 'sm')}
          <strong style="font-size:13px;">${esc(name)}</strong>
          ${showDate && r.dinner_date ? `<span class="tabular" style="font-size:11px;color:var(--muted);">· ${fmtShortDate(r.dinner_date)}</span>` : ''}
        </div>
        <span class="review-stars" aria-label="${r.score} out of 5 stars">${starsText(r.score)}</span>
      </div>
      ${r.dish ? `<div class="review-dish">🍽️ ${esc(r.dish)}</div>` : ''}
      ${r.comment ? `<div style="margin-top:4px;color:var(--ink);">${esc(r.comment)}</div>` : ''}
      ${!hasDetails ? `<div style="margin-top:3px;font-size:12px;color:var(--muted);">Rated ${r.score}/5</div>` : ''}
    </div>
  `;
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function api(path, options = {}) {
  const resp = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(data.error || `Request failed (${resp.status})`);
  }
  return data;
}

function clearMaps() {
  for (const m of state.mapInstances) {
    try { m.remove(); } catch {}
  }
  state.mapInstances = [];
}

function urlBase64ToUint8Array(base64String) {
  const pad = '='.repeat((4 - (base64String.length % 4)) % 4);
  const b64 = (base64String + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function isIosSafari() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/i.test(ua);
}

function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches || Boolean(navigator.standalone);
}

async function enableWebPush() {
  const vapidKey = state.bootstrap?.vapidPublicKey;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('This browser does not support Web Push notifications.');
  }
  if (isIosSafari() && !isStandalonePwa()) {
    throw new Error('On iPhone, add Man Night to your Home Screen first, then open it from the icon.');
  }
  if (!vapidKey) {
    throw new Error('Push VAPID key is not configured yet.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error('Notification permission was denied.');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
  }
  const json = sub.toJSON();
  await api('/api/push/subscribe', {
    method: 'POST',
    body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
  });
  toast('Push notifications enabled!');
  await refreshBootstrap();
}

async function refreshBootstrap() {
  state.bootstrap = await api('/api/bootstrap');
  const { user, stats } = state.bootstrap;
  const myLast = (state.bootstrap.lastDinnerRatings || []).find((r) => r.user_slug === user.slug);
  state.ratingScore = myLast ? Number(myLast.score) : 5;
  document.getElementById('hdr-count').textContent = stats?.total_dinners ?? 614;
  document.getElementById('user-avatar').className = `av ${user.avatar_class}`;
  document.getElementById('user-avatar').textContent = user.initials;
  document.getElementById('user-name').textContent = user.name;
  const menuName = document.getElementById('user-menu-name');
  const menuEmail = document.getElementById('user-menu-email');
  if (menuName) menuName.textContent = user.name;
  if (menuEmail) menuEmail.textContent = user.email;
  render();
}

async function loadPlacesIfNeeded() {
  if (state.places.length === 0) {
    const res = await api('/api/places');
    state.places = res.places || [];
  }
}

async function loadHistory(append = false) {
  const offset = append ? state.history.length : 0;
  const qs = new URLSearchParams({
    limit: '60',
    offset: String(offset),
  });
  if (state.historyQuery) qs.set('q', state.historyQuery);
  if (state.historyHost) qs.set('host', state.historyHost);
  if (state.historyPlaceId) qs.set('placeId', String(state.historyPlaceId));
  const res = await api(`/api/history?${qs.toString()}`);
  state.history = append ? [...state.history, ...(res.items || [])] : (res.items || []);
  state.historyTotal = res.total || 0;
  if (state.tab === 'history') render();
}

function setTab(tab) {
  state.tab = tab;
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  });
  if (tab === 'places') {
    loadPlacesIfNeeded().then(render);
  } else if (tab === 'history') {
    loadHistory(false);
  } else {
    render();
  }
}

function openModal(html) {
  const backdrop = document.getElementById('modal-backdrop');
  const panel = document.getElementById('modal-panel');
  panel.innerHTML = html;
  backdrop.classList.remove('hidden');
}

function closeModal() {
  document.getElementById('modal-backdrop').classList.add('hidden');
  document.getElementById('modal-panel').innerHTML = '';
}

function renderPlacePollOptions(tw) {
  const totalNoon = tw.noonVotes.length;
  const myNoon = tw.noonVotes.find((v) => v.user_slug === state.bootstrap?.user?.slug)?.restaurant_id;
  return (tw.noonCandidates || [])
    .map((p) => {
      const voters = tw.noonVotes.filter((v) => v.restaurant_id === p.id);
      const pct = totalNoon ? Math.round((voters.length / totalNoon) * 100) : 0;
      const sel = myNoon === p.id;
      const ratingTxt = p.avg_rating != null ? `★ ${Number(p.avg_rating).toFixed(1)} · ` : '';
      return `
        <button class="vote-option ${sel ? 'selected' : ''}" data-action="vote-noon" data-place-id="${p.id}">
          <div class="vote-fill" style="width:${pct}%"></div>
          <div class="vote-inner">
            <div>
              <div class="vote-main">${esc(p.name)}</div>
              <div class="vote-meta">${ratingTxt}${p.visit_count} past visits · ${p.last_visited ? `Last ${fmtShortDate(p.last_visited)}` : 'In the books'}${p.address ? ` · ${esc(p.address)}` : ''}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${voters.map((v) => avatarHtml(v.user_slug, v.user_slug, 'sm')).join('')}
              <span class="vote-count">${voters.length}</span>
            </div>
          </div>
        </button>
      `;
    })
    .join('');
}

function renderWeekView() {
  const b = state.bootstrap;
  const tw = b.thisWeek;
  if (!tw) {
    return `<div class="card"><h2>No active week scheduled</h2><p class="hero-sub">Check History or Crew rotation.</p></div>`;
  }

  const d = tw.dinner;
  const me = b.user;
  const isHost = d.host_slug === me.slug;
  const tueCount = tw.nightVotes.filter((v) => v.choice === 'tuesday').length;
  const wedCount = tw.nightVotes.filter((v) => v.choice === 'wednesday').length;
  const totalNight = tueCount + wedCount;
  const myNight = tw.nightVotes.find((v) => v.user_slug === me.slug)?.choice;
  const myRsvp = tw.rsvps.find((v) => v.user_slug === me.slug)?.status;

  const nightOpen = !d.night_locked_at && (d.status === 'scheduled' || d.status === 'night_poll');
  const hasPlacePoll = !d.restaurant_id && (tw.noonCandidates || []).length >= 2;
  const hasPickedPlace = Boolean(d.restaurant_id && tw.place);
  const tueDate = d.day_of_week === 'Wednesday' ? shiftIsoDate(d.dinner_date, -1) : d.dinner_date;
  const wedDate = d.day_of_week === 'Tuesday' ? shiftIsoDate(d.dinner_date, 1) : d.dinner_date;

  let statusPill = `<span class="badge badge-red">Night vote open</span>`;
  if (nightOpen) {
    if (d.status === 'scheduled') {
      if (hasPickedPlace) statusPill = `<span class="badge badge-ok">Place set · Night vote open</span>`;
      else if (hasPlacePoll) statusPill = `<span class="badge badge-red">Early vote + Place poll</span>`;
      else statusPill = `<span class="badge badge-muted">Early vote · Opens Sun 10 AM</span>`;
    } else if (hasPickedPlace) {
      statusPill = `<span class="badge badge-ok">Place set · Night vote open</span>`;
    } else if (hasPlacePoll) {
      statusPill = `<span class="badge badge-red">Night + Place polls open</span>`;
    }
  } else {
    if (d.status === 'awaiting_pick') statusPill = `<span class="badge badge-muted">Waiting on ${esc(d.host_label)}</span>`;
    if (d.status === 'noon_vote') {
      statusPill =
        d.chosen_via === 'host_poll'
          ? `<span class="badge badge-red">Host place poll</span>`
          : `<span class="badge badge-red">Noon rule · Closes 4:00 PM</span>`;
    }
    if (d.status === 'place_locked') statusPill = `<span class="badge badge-ok">✓ Confirmed</span>`;
  }

  let bodyHtml = '';
  let locationCardHtml = '';

  if (nightOpen) {
    const tuePct = totalNight ? Math.round((tueCount / totalNight) * 100) : 0;
    const wedPct = totalNight ? Math.round((wedCount / totalNight) * 100) : 0;
    const tueVoters = tw.nightVotes.filter((v) => v.choice === 'tuesday').map((v) => avatarHtml(v.user_slug, v.user_slug, 'sm')).join('');
    const wedVoters = tw.nightVotes.filter((v) => v.choice === 'wednesday').map((v) => avatarHtml(v.user_slug, v.user_slug, 'sm')).join('');

    bodyHtml = `
      <h1 class="hero-title">Tuesday or Wednesday?</h1>
      <p class="hero-sub">${
        d.status === 'scheduled'
          ? 'Early voting open · Official poll Sunday 10:00 AM · Locks Monday 12:00 PM · Tuesday wins ties'
          : 'Locks Monday at 12:00 PM · Tuesday wins ties · 6:30 PM'
      }</p>
      <div class="vote-list">
        <button class="vote-option ${myNight === 'tuesday' ? 'selected' : ''}" data-action="vote-night" data-choice="tuesday">
          <div class="vote-fill" style="width:${tuePct}%"></div>
          <div class="vote-inner">
            <div>
              <div class="vote-main">Tuesday · ${fmtShortDate(tueDate)}</div>
              <div class="vote-meta">Preferred default (76% of weeks since 2025)</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${tueVoters}
              <span class="vote-count">${tueCount}</span>
            </div>
          </div>
        </button>
        <button class="vote-option ${myNight === 'wednesday' ? 'selected' : ''}" data-action="vote-night" data-choice="wednesday">
          <div class="vote-fill" style="width:${wedPct}%"></div>
          <div class="vote-inner">
            <div>
              <div class="vote-main">Wednesday · ${fmtShortDate(wedDate)}</div>
              <div class="vote-meta">Traditional Man Night backup</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${wedVoters}
              <span class="vote-count">${wedCount}</span>
            </div>
          </div>
        </button>
      </div>
    `;

    if (hasPickedPlace) {
      const p = tw.place;
      locationCardHtml = `
        <section class="card">
          <div class="card-kicker">
            <span>Location · ${esc(d.host_label)}’s pick</span>
            <span class="badge badge-ok">Spot set</span>
          </div>
          <h2 class="hero-title" style="font-size:24px;">${esc(p.name)}</h2>
          <p class="hero-sub">${p.avg_rating != null ? `<span class="badge badge-star tabular" style="margin-right:6px;">★ ${Number(p.avg_rating).toFixed(1)}</span>` : ''}${p.visit_count ? `${p.visit_count} prior visits · ` : ''}Picked ${d.chosen_via === 'host_poll' ? `via ${esc(d.host_label)}’s poll` : `in advance by ${esc(d.host_label)}`} · Tue/Wed vote open</p>
          <div style="font-size:13px;color:var(--muted);">${esc(p.address || p.city)}</div>
          <div id="tonight-map" class="minimap"></div>
          <div class="btn-row">
            <a class="btn btn-primary" href="${esc(tw.directions_url)}" target="_blank" rel="noopener">Directions in Google Maps</a>
            <button class="btn btn-outline" data-action="open-picker" data-dinner-id="${d.id}" data-day="${esc(d.day_of_week)}" data-host="${esc(d.host_label)}" data-date="${esc(d.dinner_date)}" data-night-open="1">Change place</button>
            <button class="btn btn-secondary" data-action="open-poll-builder" data-dinner-id="${d.id}">Switch to poll</button>
          </div>
        </section>
      `;
    } else if (hasPlacePoll) {
      locationCardHtml = `
        <section class="card">
          <div class="card-kicker">
            <span>Location poll · ${esc(d.host_label)}’s shortlist</span>
            <span class="badge badge-red">${tw.noonCandidates.length} spots · Vote open</span>
          </div>
          <h2 class="hero-title" style="font-size:24px;">Where should we eat?</h2>
          <p class="hero-sub">Vote on the restaurant right alongside Tuesday/Wednesday. Host can lock the winner anytime.</p>
          <div class="vote-list">${renderPlacePollOptions(tw)}</div>
          <div class="btn-row" style="margin-top:12px;">
            <button class="btn btn-primary btn-sm" data-action="close-place-poll" data-dinner-id="${d.id}">Lock winning place</button>
            <button class="btn btn-outline btn-sm" data-action="open-poll-builder" data-dinner-id="${d.id}">Edit poll</button>
            <button class="btn btn-secondary btn-sm" data-action="open-picker" data-dinner-id="${d.id}" data-day="${esc(d.day_of_week)}" data-host="${esc(d.host_label)}" data-date="${esc(d.dinner_date)}" data-night-open="1">Pick 1 spot instead</button>
          </div>
        </section>
      `;
    } else {
      locationCardHtml = `
        <section class="card">
          <div class="card-kicker">
            <span>Location · ${esc(d.host_label)}’s turn</span>
            <span class="badge badge-muted">Open for host pick or poll</span>
          </div>
          <div class="host-strip">
            ${avatarHtml(d.host_slug, d.host_label, 'lg')}
            <div class="host-strip-text">
              <strong>${esc(d.host_label)} can set the spot or start a poll now</strong>
              <span>Picking or polling now keeps the Tuesday/Wednesday night vote open for everyone.</span>
            </div>
          </div>
          <div class="btn-row">
            <button class="btn btn-primary" data-action="open-picker" data-dinner-id="${d.id}" data-day="${esc(d.day_of_week)}" data-host="${esc(d.host_label)}" data-date="${esc(d.dinner_date)}" data-night-open="1">${isHost ? 'Pick a place' : `Pick for ${esc(d.host_label)}`}</button>
            <button class="btn btn-outline" data-action="open-poll-builder" data-dinner-id="${d.id}">Create place poll</button>
            <button class="btn btn-secondary" data-action="open-pass-swap">Pass / Swap turn</button>
          </div>
        </section>
      `;
    }
  } else if (d.status === 'awaiting_pick') {
    bodyHtml = `
      <h1 class="hero-title">Waiting on ${esc(d.host_label)}</h1>
      <p class="hero-sub">${esc(d.day_of_week)} · ${fmtDate(d.dinner_date)} · 6:30 PM. If nothing is picked by 12:00 PM on ${esc(d.day_of_week)}, the app draws 4 random places (skipping last 8 weeks).</p>
      <div class="host-strip">
        ${avatarHtml(d.host_slug, d.host_label, 'lg')}
        <div class="host-strip-text">
          <strong>${esc(d.host_label)} is on the clock</strong>
          <span>${tw.rsvps.filter((r) => r.status === 'in').length || '0'} crew RSVP’d in so far</span>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary" data-action="open-picker" data-dinner-id="${d.id}" data-day="${esc(d.day_of_week)}" data-host="${esc(d.host_label)}" data-date="${esc(d.dinner_date)}">${isHost ? 'Pick the restaurant' : `Choose place for ${esc(d.host_label)}`}</button>
        <button class="btn btn-outline" data-action="open-poll-builder" data-dinner-id="${d.id}">Create place poll</button>
        <button class="btn btn-secondary" data-action="open-pass-swap">Pass / Swap turn</button>
      </div>
    `;
  } else if (d.status === 'noon_vote') {
    const isHostPoll = d.chosen_via === 'host_poll';
    bodyHtml = `
      <h1 class="hero-title">${isHostPoll ? `${esc(d.host_label)}’s place poll — vote for one` : `${esc(d.host_label)} didn’t pick. Vote for one.`}</h1>
      <p class="hero-sub">${
        isHostPoll
          ? `For ${esc(d.day_of_week)} · ${fmtDate(d.dinner_date)} · 6:30 PM. Host can lock the winner anytime.`
          : '4 random spots from history (none visited in last 8 weeks). Closes 4:00 PM; ties break at random.'
      }</p>
      <div class="vote-list">${renderPlacePollOptions(tw)}</div>
      <div class="btn-row" style="margin-top:12px;">
        <button class="btn btn-primary btn-sm" data-action="close-place-poll" data-dinner-id="${d.id}">Lock winning place</button>
        <button class="btn btn-outline btn-sm" data-action="open-poll-builder" data-dinner-id="${d.id}">Edit poll</button>
        <button class="btn btn-secondary btn-sm" data-action="open-picker" data-dinner-id="${d.id}" data-day="${esc(d.day_of_week)}" data-host="${esc(d.host_label)}" data-date="${esc(d.dinner_date)}">Pick 1 place directly</button>
      </div>
    `;
  } else if (d.status === 'place_locked' && tw.place) {
    const p = tw.place;
    const sourceLabel =
      d.chosen_via === 'noon_draw'
        ? 'Noon draw'
        : d.chosen_via === 'host_poll'
          ? `${esc(d.host_label)}’s poll`
          : esc(d.host_label);
    bodyHtml = `
      <h1 class="hero-title">${esc(p.name)}</h1>
      <p class="hero-sub">${esc(d.day_of_week)} · ${fmtDate(d.dinner_date)} · 6:30 PM · Picked via ${sourceLabel}${p.visit_count ? ` · ${p.visit_count} prior visits` : ''}${p.avg_rating != null ? ` · ★ ${Number(p.avg_rating).toFixed(1)}` : ''}</p>
      <div style="font-size:13px;color:var(--muted);">${esc(p.address || p.city)}</div>
      <div id="tonight-map" class="minimap"></div>
      <div class="btn-row">
        <a class="btn btn-primary" href="${esc(tw.directions_url)}" target="_blank" rel="noopener">Directions in Google Maps</a>
        <button class="btn btn-outline" data-action="open-picker" data-dinner-id="${d.id}" data-day="${esc(d.day_of_week)}" data-host="${esc(d.host_label)}" data-date="${esc(d.dinner_date)}">Change place</button>
        <button class="btn btn-secondary" data-action="open-poll-builder" data-dinner-id="${d.id}">Switch to poll</button>
      </div>
    `;
  }

  // RSVP block
  const rsvpChips = tw.rsvps
    .map((r) => {
      const cls = r.status === 'in' ? 'ok' : r.status === 'late' ? 'late' : 'out';
      const label = r.status === 'in' ? 'In' : r.status === 'late' ? `Late ${r.eta_minutes || 15}m` : 'Out';
      return `<span class="chip ${cls}">${avatarHtml(r.user_slug, r.user_slug, 'sm')} ${esc(r.user_slug)} · ${label}</span>`;
    })
    .join('');

  const rsvpCard = `
    <div class="card">
      <div class="card-kicker"><span>Attendance</span><span class="tabular">${fmtShortDate(d.dinner_date)}</span></div>
      <div class="btn-row">
        <button class="btn btn-sm ${myRsvp === 'in' ? 'btn-primary' : 'btn-outline'}" data-action="rsvp" data-status="in">I’m in</button>
        <button class="btn btn-sm ${myRsvp === 'late' ? 'btn-primary' : 'btn-outline'}" data-action="rsvp" data-status="late">Running 15m late</button>
        <button class="btn btn-sm ${myRsvp === 'out' ? 'btn-primary' : 'btn-outline'}" data-action="rsvp" data-status="out">Can’t make it</button>
      </div>
      ${rsvpChips ? `<div class="rsvp-grid">${rsvpChips}</div>` : `<p class="hero-sub" style="margin:10px 0 0;font-size:13px;">No RSVPs yet for ${fmtShortDate(d.dinner_date)}.</p>`}
    </div>
  `;

  // Last completed dinner rating prompt + memory refresher
  const lastCompleted = b.recentDinners?.[0];
  const lastRatings = b.lastDinnerRatings || [];
  const myLastRating = lastRatings.find((r) => r.user_slug === me.slug);
  const lastPlaceTitle = lastCompleted
    ? lastCompleted.restaurant_name || lastCompleted.raw_location?.split(',')[0] || 'Place not set'
    : '';
  const lastPlaceAddr = lastCompleted ? lastCompleted.restaurant_address || lastCompleted.raw_location || '' : '';
  const lastAvg = lastCompleted?.dinner_avg_rating ?? lastCompleted?.restaurant_avg_rating;
  const lastRatingCount = lastCompleted?.rating_count || lastRatings.length || 0;
  const priorSpotsHtml = (b.recentDinners || [])
    .slice(1, 4)
    .map((r) => {
      const placeTxt = r.restaurant_name || r.raw_location?.split(',')[0] || 'Unlinked';
      const spotAvg = r.dinner_avg_rating ?? r.restaurant_avg_rating;
      const ratingBadge = spotAvg != null
        ? `<span class="badge badge-star tabular" style="padding:1px 6px;font-size:10px;margin-right:4px;">★ ${Number(spotAvg).toFixed(1)}</span>`
        : '';
      const placeEl = r.restaurant_id
        ? `<button class="link-btn" style="font-size:12px;" data-action="focus-place" data-place-id="${r.restaurant_id}">${esc(placeTxt)}</button>`
        : `<span style="color:var(--muted);">${esc(placeTxt)}</span>`;
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px;padding:4px 0;">
          <span class="tabular" style="color:var(--muted);">${fmtShortDate(r.dinner_date)} · ${esc(r.host_label)}</span>
          <span style="text-align:right;font-weight:600;">${ratingBadge}${placeEl}</span>
        </div>
      `;
    })
    .join('');

  const lastReviewsHtml = lastRatings.length
    ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);">
         <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin-bottom:6px;">Crew reviews (${lastRatings.length})</div>
         <div class="review-list">${lastRatings.map((r) => renderReviewItem(r, false)).join('')}</div>
       </div>`
    : '';

  const rateCard = lastCompleted
    ? `
      <div class="card">
        <div class="card-kicker">
          <span>Last dinner</span>
          <div style="display:flex;align-items:center;gap:6px;">
            ${lastAvg != null ? `<span class="badge badge-star tabular">★ ${Number(lastAvg).toFixed(1)}${lastRatingCount ? ` (${lastRatingCount})` : ''}</span>` : ''}
            ${
              lastCompleted.restaurant_id
                ? `<button class="badge badge-ok" style="border:0;cursor:pointer;" data-action="focus-place" data-place-id="${lastCompleted.restaurant_id}">View place →</button>`
                : `<button class="badge badge-red" style="border:0;cursor:pointer;" data-action="open-backfill" data-dinner-id="${lastCompleted.id}" data-date="${esc(lastCompleted.dinner_date)}">Set place →</button>`
            }
          </div>
        </div>
        <div style="font-weight:750;font-size:17px;margin-bottom:4px;">${esc(lastPlaceTitle)}</div>
        <div style="font-size:13px;color:var(--muted);margin-bottom:${lastPlaceAddr ? '3px' : '12px'};">
          ${esc(lastCompleted.day_of_week || 'Tuesday')}, ${fmtShortDate(lastCompleted.dinner_date)} · Hosted by ${esc(lastCompleted.host_label)}${lastCompleted.restaurant_visits ? ` · ${lastCompleted.restaurant_visits} visits` : ''}
        </div>
        ${lastPlaceAddr ? `<div style="font-size:12px;color:var(--muted);margin-bottom:12px;">${esc(lastPlaceAddr)}</div>` : ''}
        <div id="last-dinner-stars" class="star-row" style="margin-bottom:8px;">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star-btn ${state.ratingScore >= n ? 'on' : ''}" data-action="set-star" data-score="${n}">★</button>`).join('')}
        </div>
        ${myLastRating ? `<div style="font-size:12px;color:var(--ok);font-weight:600;margin-bottom:8px;">✓ Your review (${myLastRating.score}/5) is saved</div>` : ''}
        <div class="stack" style="gap:8px;">
          <input id="rate-dish-input" class="input" style="min-height:36px;" placeholder="Standout dish (optional)" value="${esc(myLastRating?.dish || '')}" />
          <textarea id="rate-comment-input" class="textarea" style="min-height:60px;" placeholder="Review note — food, vibe, would go back? (optional)">${esc(myLastRating?.comment || '')}</textarea>
          <div style="display:flex;justify-content:flex-end;">
            <button class="btn btn-sm btn-primary" data-action="submit-rate" data-dinner-id="${lastCompleted.id}">${myLastRating ? 'Update review' : 'Post review'}</button>
          </div>
        </div>
        ${lastReviewsHtml}
        ${
          priorSpotsHtml
            ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line);">
                 <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin-bottom:4px;">Recent spots</div>
                 ${priorSpotsHtml}
               </div>`
            : ''
        }
      </div>
    `
    : '';

  const upcomingRows = (b.upcoming || [])
    .slice(0, 4)
    .map((u) => {
      const isNightOpen = !u.night_locked_at;
      const pollIds = parsePollIds(u.noon_draw_ids);
      const nightFlag = isNightOpen ? '1' : '';
      let rightHtml = '';
      if (u.restaurant_name) {
        const badge = isNightOpen
          ? `<span class="badge badge-ok" title="Spot set — Tue/Wed vote stays open">📍 ${esc(u.restaurant_name)} · Tue/Wed vote</span>`
          : `<span class="badge badge-ok" title="Locked in advance — no vote needed">✓ ${esc(u.restaurant_name)}</span>`;
        rightHtml = `
          ${badge}
          <button class="link-btn" style="font-size:12px;" data-action="open-picker" data-dinner-id="${u.id}" data-day="${esc(u.day_of_week)}" data-host="${esc(u.host_label)}" data-date="${esc(u.dinner_date)}" data-night-open="${nightFlag}">Change</button>
          <button class="link-btn" style="font-size:12px;" data-action="open-poll-builder" data-dinner-id="${u.id}">Poll</button>
        `;
      } else if (pollIds.length >= 2) {
        rightHtml = `
          <span class="badge badge-red">🗳 Poll (${pollIds.length} spots)</span>
          <button class="link-btn" style="font-size:12px;" data-action="open-poll-builder" data-dinner-id="${u.id}">Edit poll</button>
          <button class="link-btn" style="font-size:12px;" data-action="open-picker" data-dinner-id="${u.id}" data-day="${esc(u.day_of_week)}" data-host="${esc(u.host_label)}" data-date="${esc(u.dinner_date)}" data-night-open="${nightFlag}">Pick</button>
        `;
      } else {
        rightHtml = `
          <button class="btn btn-outline btn-sm" style="min-height:28px;padding:3px 10px;font-size:12px;" data-action="open-picker" data-dinner-id="${u.id}" data-day="${esc(u.day_of_week)}" data-host="${esc(u.host_label)}" data-date="${esc(u.dinner_date)}" data-night-open="${nightFlag}">Pick in advance</button>
          <button class="btn btn-secondary btn-sm" style="min-height:28px;padding:3px 10px;font-size:12px;" data-action="open-poll-builder" data-dinner-id="${u.id}">Poll</button>
        `;
      }
      return `
        <div class="row-item" style="gap:10px;">
          <div style="display:flex;align-items:center;gap:10px;">
            ${avatarHtml(u.host_slug, u.host_label)}
            <div>
              <div style="font-weight:650;font-size:14px;">${esc(u.host_label)}</div>
              <div style="font-size:12px;color:var(--muted);">${esc(u.day_of_week)} · ${fmtShortDate(u.dinner_date)}</div>
            </div>
          </div>
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;">
            ${rightHtml}
          </div>
        </div>
      `;
    })
    .join('');

  const installBannerHtml =
    !isStandalonePwa() && !state.installBannerDismissed
      ? `<div class="install-banner">
           <div style="font-size:13px;line-height:1.4;">
             <strong>Get push alerts &amp; 1-tap access on your phone</strong>
             <div style="color:var(--muted);font-size:12px;">Install Man Night to your Home Screen (iPhone Safari &amp; Android Chrome)</div>
           </div>
           <div style="display:flex;align-items:center;gap:8px;">
             ${state.deferredInstallPrompt ? `<button class="btn btn-primary btn-sm" data-action="trigger-native-install">Install App</button>` : ''}
             <button class="btn ${state.deferredInstallPrompt ? 'btn-outline' : 'btn-primary'} btn-sm" data-action="open-install-guide">${state.deferredInstallPrompt ? 'Steps' : 'iPhone / Android guide'}</button>
             <button class="icon-pill" style="height:28px;padding:0 9px;" data-action="dismiss-install-banner" title="Dismiss" aria-label="Dismiss">✕</button>
           </div>
         </div>`
      : '';

  return `
    ${installBannerHtml}
    <div class="week-grid">
      <div class="stack">
        <section class="card">
          <div class="card-kicker">
            <span>This week · ${esc(d.day_of_week)} ${fmtShortDate(d.dinner_date)}</span>
            ${statusPill}
          </div>
          ${bodyHtml}
        </section>
        ${locationCardHtml}
        ${rsvpCard}
      </div>
      <aside class="stack">
        <section class="card">
          <div class="card-kicker">
            <span>Up next in rotation</span>
            <button class="link-btn" data-action="goto-tab" data-target="crew">Rotation →</button>
          </div>
          <div class="list-clean">${upcomingRows}</div>
        </section>
        ${rateCard}
      </aside>
    </div>
  `;
}

function renderHistoryView() {
  const b = state.bootstrap;
  const hosts = ['', 'chuck', 'jacob', 'eric', 'tyler', 'heath', 'don', 'dan'];
  const hostPills = hosts
    .map((h) => {
      const label = h ? h.charAt(0).toUpperCase() + h.slice(1) : 'All';
      return `<button class="filter-pill ${state.historyHost === h ? 'active' : ''}" data-action="filter-host" data-host="${h}">${label}</button>`;
    })
    .join('');

  const grouped = new Map();
  for (const item of state.history) {
    const ml = monthLabel(item.dinner_date);
    if (!grouped.has(ml)) grouped.set(ml, []);
    grouped.get(ml).push(item);
  }

  let listHtml = '';
  for (const [month, items] of grouped.entries()) {
    listHtml += `<div class="month-heading">${esc(month)}</div><div class="card" style="padding:0 16px;">`;
    for (const d of items) {
      const ratingPill = d.rating_count > 0 && d.dinner_avg_rating != null
        ? `<button class="badge badge-star tabular" style="border:0;cursor:pointer;margin-left:6px;" data-action="open-review-modal" data-dinner-id="${d.id}">★ ${Number(d.dinner_avg_rating).toFixed(1)} (${d.rating_count})</button>`
        : '';
      const placeCell = d.restaurant_id
        ? `<button class="link-btn" style="color:var(--ink);font-size:14px;text-align:left;" data-action="focus-place" data-place-id="${d.restaurant_id}">${esc(d.restaurant_name)}</button>
           ${d.restaurant_visits ? `<span style="font-size:12px;color:var(--muted);margin-left:6px;">(${d.restaurant_visits}×)</span>` : ''}
           ${ratingPill}`
        : `<button class="link-btn" data-action="open-backfill" data-dinner-id="${d.id}" data-date="${esc(d.dinner_date)}">+ Add the place</button>
           ${ratingPill}`;
      listHtml += `
        <div class="history-row">
          <div class="tabular" style="font-size:13px;color:var(--muted);">${fmtDate(d.dinner_date)}</div>
          <div class="h-day" style="font-size:13px;color:var(--muted);">${esc(d.day_of_week.slice(0, 3))}</div>
          <div>${placeCell}</div>
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">
            ${avatarHtml(d.host_slug, d.host_label, 'sm')}
            <span style="font-size:13px;font-weight:600;">${esc(d.host_label)}</span>
            <button class="btn btn-outline btn-sm" style="min-height:26px;padding:2px 8px;font-size:11px;" data-action="open-review-modal" data-dinner-id="${d.id}">${d.my_score != null ? `★ ${d.my_score} · Edit` : 'Rate'}</button>
          </div>
        </div>
      `;
    }
    listHtml += `</div>`;
  }

  if (!listHtml) {
    listHtml = `<div class="card muted-bg">No dinners matched your filter.</div>`;
  }

  const remaining = state.historyTotal - state.history.length;

  return `
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
      <div>
        <h1 class="hero-title" style="margin-bottom:2px;">History</h1>
        <p class="hero-sub" style="margin:0;">${state.historyTotal} dinners on the books · click any missing night to add the place</p>
      </div>
      ${state.historyPlaceId ? `<button class="btn btn-sm btn-outline" data-action="clear-place-filter">Clear place filter ✕</button>` : ''}
    </div>
    <div class="toolbar">
      <input id="history-search" class="input" style="min-width:240px;flex:1;" placeholder="Search place, host, address…" value="${esc(state.historyQuery)}" />
      <div class="filter-pills">${hostPills}</div>
    </div>
    ${listHtml}
    ${remaining > 0 ? `<div style="text-align:center;margin-top:18px;"><button class="btn btn-secondary" data-action="load-more-history">Show more (${remaining} left)</button></div>` : ''}
  `;
}

function getFilteredPlaces() {
  const q = state.placesQuery.trim().toLowerCase();
  const cutoffTwoYearsAgo = new Date(Date.now() - 365 * 2 * 86400000).toISOString().slice(0, 10);
  let list = [...state.places];

  if (state.placesFilter === 'ten_plus') {
    list = list.filter((p) => (p.visit_count || 0) >= 10);
  } else if (state.placesFilter === 'regulars') {
    list = list.filter((p) => (p.visit_count || 0) >= 5);
  } else if (state.placesFilter === 'comeback') {
    list = list.filter((p) => (p.visit_count || 0) >= 3 && p.last_visited && p.last_visited <= cutoffTwoYearsAgo);
  } else if (state.placesFilter === 'one_hit') {
    list = list.filter((p) => (p.visit_count || 0) === 1);
  } else if (state.placesFilter === 'reviewed') {
    list = list.filter((p) => (p.rating_count || 0) > 0 || p.avg_rating != null);
  }

  if (q) {
    list = list.filter((p) => p.name.toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q));
  }
  if (state.placesSort === 'rating') {
    list.sort(
      (a, b) =>
        ((b.avg_rating ?? -1) - (a.avg_rating ?? -1)) ||
        ((b.rating_count ?? 0) - (a.rating_count ?? 0)) ||
        (b.visit_count - a.visit_count) ||
        a.name.localeCompare(b.name),
    );
  } else if (state.placesSort === 'recent') {
    list.sort((a, b) => (b.last_visited || '').localeCompare(a.last_visited || ''));
  } else if (state.placesSort === 'alpha') {
    list.sort((a, b) => a.name.localeCompare(b.name));
  } else {
    list.sort((a, b) => (b.visit_count - a.visit_count) || a.name.localeCompare(b.name));
  }
  return list;
}

function renderSelectedPlaceCard(selected) {
  if (!selected) return '';
  const cached = state.placeReviews[selected.id];
  const place = cached?.place || selected;
  const ratingCount = place.rating_count ?? (cached?.reviews?.length ?? 0);
  const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(place.address || place.name)}`;
  const ratingBadgeHtml =
    place.avg_rating != null
      ? `<span class="badge badge-star tabular">★ ${Number(place.avg_rating).toFixed(1)} · ${ratingCount} ${ratingCount === 1 ? 'review' : 'reviews'}</span>`
      : `<span class="badge badge-muted">No reviews yet</span>`;
  const visits = cached?.visits || [];
  const targetVisit = visits.find((v) => v.my_score != null) || visits[0] || null;
  const rateBtnHtml = targetVisit
    ? `<button id="selected-place-rate-btn" class="btn btn-sm btn-outline" data-action="open-review-modal" data-dinner-id="${targetVisit.id}">${targetVisit.my_score != null ? 'Edit review' : '+ Write review'}</button>`
    : '';
  const reviewsBody = cached
    ? cached.reviews?.length
      ? `<div class="review-list">${cached.reviews.map((r) => renderReviewItem(r, true)).join('')}</div>`
      : `<div style="font-size:13px;color:var(--muted);">No crew reviews yet for this spot.</div>`
    : `<div style="font-size:13px;color:var(--muted);">Loading reviews…</div>`;

  return `
    <section class="card">
      <div class="card-kicker">
        <span>Selected spot</span>
        <span id="selected-place-rating-badge">${ratingBadgeHtml}</span>
      </div>
      <div style="font-weight:750;font-size:18px;line-height:1.2;">${esc(place.name)}</div>
      <div style="font-size:13px;color:var(--muted);margin-top:3px;">
        ${place.visit_count} ${place.visit_count === 1 ? 'visit' : 'visits'}${place.last_visited ? ` · Last ${fmtDate(place.last_visited)}` : ''}
      </div>
      <div style="font-size:12px;color:var(--muted);margin-top:2px;margin-bottom:10px;">${esc(place.address || place.city)}</div>
      <div class="btn-row" style="margin-bottom:12px;">
        <a class="btn btn-sm btn-primary" href="${esc(gmaps)}" target="_blank" rel="noopener">Directions ↗</a>
        <button class="btn btn-sm btn-outline" data-action="filter-place-history" data-place-id="${place.id}">Visit history →</button>
        <span id="selected-place-rate-wrap">${rateBtnHtml}</span>
      </div>
      <div id="selected-place-reviews">${reviewsBody}</div>
    </section>
  `;
}

async function loadPlaceReviews(placeId) {
  if (!placeId || state.placeReviews[placeId]) return;
  try {
    const data = await api(`/api/places/${placeId}/reviews`);
    state.placeReviews[placeId] = data;
    const idx = state.places.findIndex((p) => p.id === placeId);
    if (idx >= 0 && data.place) {
      state.places[idx] = { ...state.places[idx], ...data.place };
    }
    if (state.tab === 'places' && state.selectedPlaceId === placeId) {
      const reviewsEl = document.getElementById('selected-place-reviews');
      const badgeEl = document.getElementById('selected-place-rating-badge');
      const rateWrapEl = document.getElementById('selected-place-rate-wrap');
      if (reviewsEl) {
        reviewsEl.innerHTML = data.reviews?.length
          ? `<div class="review-list">${data.reviews.map((r) => renderReviewItem(r, true)).join('')}</div>`
          : `<div style="font-size:13px;color:var(--muted);">No crew reviews yet for this spot.</div>`;
      }
      if (badgeEl && data.place) {
        const cnt = data.place.rating_count ?? data.reviews?.length ?? 0;
        badgeEl.innerHTML =
          data.place.avg_rating != null
            ? `<span class="badge badge-star tabular">★ ${Number(data.place.avg_rating).toFixed(1)} · ${cnt} ${cnt === 1 ? 'review' : 'reviews'}</span>`
            : `<span class="badge badge-muted">No reviews yet</span>`;
      }
      if (rateWrapEl) {
        const visits = data.visits || [];
        const targetVisit = visits.find((v) => v.my_score != null) || visits[0] || null;
        rateWrapEl.innerHTML = targetVisit
          ? `<button id="selected-place-rate-btn" class="btn btn-sm btn-outline" data-action="open-review-modal" data-dinner-id="${targetVisit.id}">${targetVisit.my_score != null ? 'Edit review' : '+ Write review'}</button>`
          : '';
      }
    }
  } catch {
    if (state.tab === 'places' && state.selectedPlaceId === placeId) {
      const reviewsEl = document.getElementById('selected-place-reviews');
      if (reviewsEl) reviewsEl.innerHTML = '<div style="font-size:13px;color:var(--muted);">Could not load reviews.</div>';
    }
  }
}

function renderPlacesView() {
  const all = state.places || [];
  const totalVisits = all.reduce((sum, p) => sum + (p.visit_count || 0), 0);
  const tenPlus = [...all].filter((p) => (p.visit_count || 0) >= 10).sort((a, b) => b.visit_count - a.visit_count);
  const regulars = all.filter((p) => (p.visit_count || 0) >= 5);
  const oneHits = all.filter((p) => (p.visit_count || 0) === 1);
  const reviewedPlaces = all.filter((p) => (p.rating_count || 0) > 0 || p.avg_rating != null);
  const byVisits = [...all].sort((a, b) => (b.visit_count - a.visit_count) || a.name.localeCompare(b.name));
  const byRecent = [...all].filter((p) => p.last_visited).sort((a, b) => b.last_visited.localeCompare(a.last_visited));
  const comebackPool = [...all]
    .filter((p) => (p.visit_count || 0) >= 5 && p.last_visited)
    .sort((a, b) => a.last_visited.localeCompare(b.last_visited));
  const topDerby = [...all]
    .filter((p) => (p.city || '').toLowerCase().includes('derby') || (p.address || '').toLowerCase().includes('derby'))
    .sort((a, b) => b.visit_count - a.visit_count)[0];

  const trophies = [
    byVisits[0] && {
      icon: '🏆',
      title: 'All-Time Crown',
      place: byVisits[0],
      meta: `${byVisits[0].visit_count} visits · #1 spot`,
    },
    byVisits[1] && {
      icon: '🥈',
      title: 'Silver Regular',
      place: byVisits[1],
      meta: `${byVisits[1].visit_count} visits · #2 spot`,
    },
    byVisits[2] && {
      icon: '🥉',
      title: 'Bronze Classic',
      place: byVisits[2],
      meta: `${byVisits[2].visit_count} visits · #3 spot`,
    },
    comebackPool[0] && {
      icon: '🕰️',
      title: 'Dusty Boot (Comeback Due)',
      place: comebackPool[0],
      meta: `${comebackPool[0].visit_count}× regular · Last ${fmtShortDate(comebackPool[0].last_visited)}`,
    },
    byRecent[0] && {
      icon: '🔥',
      title: 'Most Recent Stop',
      place: byRecent[0],
      meta: `${fmtDate(byRecent[0].last_visited)} · ${byRecent[0].visit_count}× total`,
    },
    topDerby && {
      icon: '⭐',
      title: 'Derby Champion',
      place: topDerby,
      meta: `${topDerby.visit_count} visits in Derby`,
    },
  ].filter(Boolean);

  const trophyHtml = trophies.length
    ? `
      <section class="trophy-section">
        <div class="card-kicker" style="margin-bottom:10px;">
          <span>Club Trophies &amp; Hall of Fame</span>
          <span>Click any trophy to focus on map</span>
        </div>
        <div class="trophy-grid">
          ${trophies
            .map(
              (t) => `
            <button class="trophy-card" data-action="focus-trophy" data-place-id="${t.place.id}">
              <span class="trophy-icon">${t.icon}</span>
              <span style="min-width:0;">
                <span class="trophy-kicker">${esc(t.title)}</span>
                <span class="trophy-winner" style="display:block;">${esc(t.place.name)}</span>
                <span class="trophy-meta" style="display:block;">${esc(t.meta)}</span>
              </span>
            </button>
          `,
            )
            .join('')}
        </div>
        ${
          tenPlus.length
            ? `<div class="hof-chips">
                 <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);">10+ Visits Club (${tenPlus.length}):</span>
                 ${tenPlus
                   .map(
                     (p) =>
                       `<button class="filter-pill" data-action="focus-trophy" data-place-id="${p.id}">${esc(p.name)} <strong>${p.visit_count}×</strong></button>`,
                   )
                   .join('')}
               </div>`
            : ''
        }
      </section>
    `
    : '';

  const list = getFilteredPlaces();
  const selected = list.find((p) => p.id === state.selectedPlaceId) || list[0] || null;
  if (selected && !list.some((p) => p.id === state.selectedPlaceId)) {
    state.selectedPlaceId = selected.id;
  }

  const filterDefs = [
    { id: 'all', label: `All (${all.length})` },
    { id: 'reviewed', label: `⭐ Reviewed (${reviewedPlaces.length})` },
    { id: 'ten_plus', label: `🏆 10+ Club (${tenPlus.length})` },
    { id: 'regulars', label: `🔥 Regulars 5+ (${regulars.length})` },
    { id: 'comeback', label: '🕰️ Comeback Due' },
    { id: 'one_hit', label: `⚡ One-Hit (${oneHits.length})` },
  ];

  const filterHtml = filterDefs
    .map(
      (f) =>
        `<button class="filter-pill ${state.placesFilter === f.id ? 'active' : ''}" data-action="filter-places" data-filter="${f.id}">${f.label}</button>`,
    )
    .join('');

  const listHtml = list
    .map(
      (p) => `
      <button class="place-card-row ${selected?.id === p.id ? 'selected' : ''}" data-action="select-place" data-place-id="${p.id}">
        <div style="min-width:0;">
          <div class="place-name">${esc(p.name)}${p.visit_count >= 10 ? ' 🏆' : p.visit_count >= 5 ? ' 🔥' : ''}</div>
          <div class="place-addr">${esc(p.address || p.city)}${p.last_visited ? ` · Last ${fmtShortDate(p.last_visited)}` : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0;">
          ${p.avg_rating != null ? `<span class="badge badge-star tabular">★ ${Number(p.avg_rating).toFixed(1)}</span>` : ''}
          <span class="badge badge-muted tabular">${p.visit_count}×</span>
        </div>
      </button>
    `,
    )
    .join('');

  return `
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:14px;">
      <div>
        <h1 class="hero-title" style="margin-bottom:2px;">Places</h1>
        <p class="hero-sub" style="margin:0;">${all.length} spots across Wichita &amp; Derby · OpenStreetMap · dot size reflects visit count</p>
      </div>
      <button class="btn btn-sm btn-primary" data-action="open-new-place">+ Add new place</button>
    </div>
    <div class="places-stats-bar">
      <div class="places-stat-tile">
        <div class="places-stat-val">${all.length}</div>
        <div class="places-stat-lbl">Distinct restaurants</div>
      </div>
      <div class="places-stat-tile">
        <div class="places-stat-val">${totalVisits}</div>
        <div class="places-stat-lbl">Logged venue visits</div>
      </div>
      <div class="places-stat-tile">
        <div class="places-stat-val">${tenPlus.length}</div>
        <div class="places-stat-lbl">10+ Visits Hall of Fame</div>
      </div>
      <div class="places-stat-tile">
        <div class="places-stat-val">${oneHits.length}</div>
        <div class="places-stat-lbl">One-hit wonders (1×)</div>
      </div>
    </div>
    ${trophyHtml}
    <div class="toolbar">
      <input id="places-search" class="input" style="min-width:220px;flex:1;" placeholder="Filter restaurants…" value="${esc(state.placesQuery)}" />
      <select id="places-sort" class="select">
        <option value="visits" ${state.placesSort === 'visits' ? 'selected' : ''}>Most visited</option>
        <option value="rating" ${state.placesSort === 'rating' ? 'selected' : ''}>Top rated</option>
        <option value="recent" ${state.placesSort === 'recent' ? 'selected' : ''}>Most recent</option>
        <option value="alpha" ${state.placesSort === 'alpha' ? 'selected' : ''}>A – Z</option>
      </select>
    </div>
    <div class="filter-pills" style="margin-bottom:12px;">${filterHtml}</div>
    <div class="places-layout">
      <div class="places-list-wrap">${listHtml || '<div class="card muted-bg">No matching places.</div>'}</div>
      <div class="places-right-col">
        ${renderSelectedPlaceCard(selected)}
        <div id="places-map" class="places-map-wrap"></div>
      </div>
    </div>
  `;
}

function renderCrewView() {
  const b = state.bootstrap;
  const me = b.user;
  const maxHost = Math.max(...(b.hostStats || []).map((h) => h.hosted_count), 1);

  const rotHtml = (b.users || [])
    .filter((u) => u.is_rotation)
    .map(
      (u, i) => `
      <div class="row-item">
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="tabular" style="width:18px;font-weight:700;color:var(--muted);">${i + 1}</span>
          ${avatarHtml(u.slug, u.name)}
          <span style="font-weight:650;">${esc(u.name)}</span>
          ${b.thisWeek?.dinner?.host_slug === u.slug ? '<span class="badge badge-red">This week</span>' : ''}
        </div>
        <span style="font-size:12px;color:var(--muted);">Active queue</span>
      </div>
    `,
    )
    .join('');

  const leaderHtml = (b.hostStats || [])
    .map((h) => {
      const pct = Math.round((h.hosted_count / maxHost) * 100);
      return `
        <div style="display:flex;align-items:center;gap:10px;padding:7px 0;">
          ${avatarHtml(h.host_slug, h.host_label, 'sm')}
          <span style="width:68px;font-weight:600;font-size:13px;">${esc(h.host_label)}</span>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
          <span class="tabular" style="width:36px;text-align:right;font-weight:700;font-size:13px;">${h.hosted_count}</span>
        </div>
      `;
    })
    .join('');

  const tueRate = b.stats?.recent_weeks
    ? Math.round((b.stats.recent_tuesdays / b.stats.recent_weeks) * 100)
    : 76;

  return `
    <div class="week-grid">
      <div class="stack">
        <section class="card">
          <div class="card-kicker"><span>Rotation order</span><button class="link-btn" data-action="open-pass-swap">Pass / Swap →</button></div>
          <div class="list-clean">${rotHtml}</div>
        </section>
        <section class="card">
          <div class="card-kicker"><span>Hosted all-time</span><span>Since 2011 records</span></div>
          ${leaderHtml}
          <div style="font-size:12px;color:var(--muted);margin-top:10px;">Tuesday nights since 2025: <strong class="tabular">${tueRate}%</strong></div>
        </section>
      </div>
      <div class="stack">
        <section class="card">
          <div class="card-kicker"><span>Notifications &amp; Phone App</span><span class="badge ${me.push_enabled ? 'badge-ok' : 'badge-muted'}">${me.push_enabled ? 'Push active' : 'Not enabled'}</span></div>
          <p class="hero-sub" style="margin-bottom:12px;font-size:13px;">Signed in as <strong>${esc(me.email)}</strong>. Reminders open Google Maps directions when tapped.</p>
          <div class="btn-row" style="margin-bottom:14px;">
            <button class="btn btn-primary btn-sm" data-action="enable-push">${me.push_enabled ? 'Re-sync push' : 'Enable push notifications'}</button>
            <button class="btn btn-outline btn-sm" data-action="test-push">Send test alert</button>
            <button class="btn btn-outline btn-sm" data-action="open-install-guide">Install app (iOS / Android)</button>
            <button class="btn btn-outline btn-sm" data-action="open-settings">Settings</button>
          </div>
          <label style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:14px;">
            <span>Sunday night vote open</span>
            <input type="checkbox" data-pref="notify_night_vote" ${me.notify_night_vote ? 'checked' : ''} />
          </label>
          <label style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:14px;">
            <span>Place locked / Noon rule alert</span>
            <input type="checkbox" data-pref="notify_place" ${me.notify_place ? 'checked' : ''} />
          </label>
          <label style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:14px;">
            <span>30-min dinner reminder</span>
            <input type="checkbox" data-pref="notify_reminder" ${me.notify_reminder ? 'checked' : ''} />
          </label>
        </section>
        <section class="card muted-bg">
          <div class="card-kicker"><span>Help &amp; Feedback</span></div>
          <p class="hero-sub" style="margin-bottom:12px;font-size:13px;">Found a broken bug, wrong address, or missing restaurant? Report it here—opens a GitHub issue for OpenBot to fix automatically.</p>
          <div class="btn-row">
            <button class="btn btn-outline btn-sm" data-action="open-walkthrough">How it works</button>
            <button class="btn btn-primary btn-sm" data-action="open-report">Report an issue</button>
          </div>
        </section>
      </div>
    </div>
  `;
}

function initTonightMap() {
  const el = document.getElementById('tonight-map');
  const place = state.bootstrap?.thisWeek?.place;
  if (!el || !place || typeof maplibregl === 'undefined') return;

  const lat = place.lat ?? 37.6872;
  const lng = place.lng ?? -97.3301;
  const map = new maplibregl.Map({
    container: el,
    style: OSM_STYLE,
    center: [lng, lat],
    zoom: place.lat ? 14 : 11,
    attributionControl: false,
  });
  if (place.lat && place.lng) {
    const pin = document.createElement('div');
    pin.className = 'place-pin';
    pin.style.width = '18px';
    pin.style.height = '18px';
    new maplibregl.Marker({ element: pin }).setLngLat([lng, lat]).addTo(map);
  }
  state.mapInstances.push(map);
}

function initPlacesMap() {
  const el = document.getElementById('places-map');
  if (!el || typeof maplibregl === 'undefined') return;

  const filtered = getFilteredPlaces();
  const geocoded = filtered.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  const selected =
    filtered.find((p) => p.id === state.selectedPlaceId && Number.isFinite(p.lat)) ||
    state.places.find((p) => p.id === state.selectedPlaceId && Number.isFinite(p.lat));
  const center = selected ? [selected.lng, selected.lat] : [-97.295, 37.687];
  const map = new maplibregl.Map({
    container: el,
    style: OSM_STYLE,
    center,
    zoom: selected ? 13 : 11,
  });

  for (const p of geocoded) {
    const sz = Math.min(24, Math.max(10, 9 + Math.round(Math.sqrt(p.visit_count) * 2.5)));
    const pin = document.createElement('div');
    pin.className = 'place-pin';
    pin.style.width = `${sz}px`;
    pin.style.height = `${sz}px`;
    if (p.id === state.selectedPlaceId) {
      pin.style.transform = 'scale(1.25)';
      pin.style.zIndex = '5';
    }
    const gmaps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.address || p.name)}`;
    const popupHtml = `
      <div style="font-family:var(--sys);font-size:13px;max-width:220px;">
        <strong style="display:block;margin-bottom:3px;">${esc(p.name)}</strong>
        <div style="color:#71717a;font-size:12px;margin-bottom:6px;">${p.avg_rating != null ? `★ ${Number(p.avg_rating).toFixed(1)} · ` : ''}${p.visit_count} visits · ${esc(p.address || p.city)}</div>
        <a href="${esc(gmaps)}" target="_blank" rel="noopener" style="color:#e5484d;font-weight:600;">Directions ↗</a>
      </div>
    `;
    const marker = new maplibregl.Marker({ element: pin })
      .setLngLat([p.lng, p.lat])
      .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(popupHtml))
      .addTo(map);
    if (p.id === state.selectedPlaceId) {
      marker.togglePopup();
    }
  }
  state.mapInstances.push(map);
}

function render() {
  clearMaps();
  const main = document.getElementById('main-content');
  if (!state.bootstrap) return;
  if (state.tab === 'week') {
    main.innerHTML = renderWeekView();
    requestAnimationFrame(initTonightMap);
  } else if (state.tab === 'history') {
    main.innerHTML = renderHistoryView();
  } else if (state.tab === 'places') {
    main.innerHTML = renderPlacesView();
    requestAnimationFrame(initPlacesMap);
    if (state.selectedPlaceId) loadPlaceReviews(state.selectedPlaceId);
  } else if (state.tab === 'crew') {
    main.innerHTML = renderCrewView();
  }
}

function showWalkthrough(step = 0) {
  state.walkStep = step;
  const b = state.bootstrap;
  const steps = [
    {
      title: 'Welcome to Man Night',
      body: `<p class="hero-sub">Established 2007. We now have <strong>${b.stats?.total_dinners ?? 614} dinners</strong> and <strong>${b.stats?.total_places ?? 226} Wichita &amp; Derby restaurants</strong> on the books—no more scrolling old calendar threads.</p>`,
    },
    {
      title: 'How a week works',
      body: `<div style="font-size:14px;line-height:1.6;color:var(--muted);margin-bottom:16px;">
        <div><strong style="color:var(--ink);">Pick or Poll Anytime</strong> · Hosts can pick a restaurant or start a place poll ahead of time—the Tuesday/Wednesday vote stays open alongside it (or skip voting).</div>
        <div><strong style="color:var(--ink);">Sun 10:00 AM</strong> · Night vote opens (Tue vs Wed; Tuesday wins ties at Mon noon).</div>
        <div><strong style="color:var(--ink);">Noon Rule</strong> · Unpicked by 12:00 PM on dinner day? App draws <strong>4 random places</strong> (skipping last 8 weeks) until 4:00 PM.</div>
        <div><strong style="color:var(--ink);">30 min before dinner</strong> · Tap your reminder alert to launch Google Maps directions.</div>
      </div>`,
    },
    {
      title: 'The rotation',
      body: `<p class="hero-sub">Turns rotate through <strong>Chuck → Jacob → Eric → Tyler → Heath</strong>. Busy this week? Pass or swap your week anytime in <strong>Crew</strong> without messing up the order.</p>`,
    },
    {
      title: 'Install app & turn on alerts',
      body: `
        <p class="hero-sub" style="margin-bottom:10px;">Add Man Night to your phone Home Screen so it launches full-screen and delivers push alerts.</p>
        <div class="install-guide-grid">
          <div class="install-platform-card">
            <div class="install-platform-title"> iPhone / iPad (Safari)</div>
            <ol class="install-step-list">
              <li>Open in <strong>Safari</strong> (push alerts require Safari on iOS).</li>
              <li>Tap <strong>Share</strong> (square with ↑) at the bottom bar.</li>
              <li>Tap <strong>Add to Home Screen</strong> → <strong>Add</strong>.</li>
              <li>Launch <strong>Man Night</strong> from Home Screen, then tap Enable Push.</li>
            </ol>
          </div>
          <div class="install-platform-card">
            <div class="install-platform-title">🤖 Android (Chrome)</div>
            <ol class="install-step-list">
              <li>Open in <strong>Chrome</strong>.</li>
              <li>Tap <strong>⋮ Menu</strong> (top right) → <strong>Install app</strong> or <strong>Add to Home screen</strong>.</li>
              <li>Confirm <strong>Install</strong>, open from Home screen, and allow alerts.</li>
            </ol>
          </div>
        </div>
        <div class="btn-row" style="margin-top:10px;">
          ${state.deferredInstallPrompt ? `<button class="btn btn-primary btn-sm" data-action="trigger-native-install">Install App Now</button>` : ''}
          ${!(isIosSafari() && !isStandalonePwa()) ? `<button class="btn btn-primary btn-sm" data-action="walk-enable-push">Enable notifications</button>` : ''}
        </div>
      `,
    },
  ];
  const cur = steps[step];
  const dots = steps.map((_, i) => `<span class="walk-dot ${i === step ? 'on' : ''}"></span>`).join('');
  openModal(`
    <div class="walk-dots">${dots}</div>
    <h2 class="hero-title" style="font-size:22px;">${esc(cur.title)}</h2>
    ${cur.body}
    <div class="btn-row" style="justify-content:space-between;margin-top:16px;">
      <button class="btn btn-secondary btn-sm" data-action="walk-close">Skip</button>
      <div class="btn-row">
        ${step > 0 ? `<button class="btn btn-outline btn-sm" data-action="walk-prev">Back</button>` : ''}
        ${step < steps.length - 1
          ? `<button class="btn btn-primary btn-sm" data-action="walk-next">Next</button>`
          : `<button class="btn btn-primary btn-sm" data-action="walk-close">Done</button>`}
      </div>
    </div>
  `);
}

function openInstallGuideModal() {
  const standalone = isStandalonePwa();
  openModal(`
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
      <h2 class="hero-title" style="font-size:20px;margin:0;">Install Man Night App</h2>
      <span class="badge ${standalone ? 'badge-ok' : 'badge-muted'}">${standalone ? '✓ Installed' : 'Browser mode'}</span>
    </div>
    <p class="hero-sub" style="margin-bottom:12px;">Install Man Night to your Home Screen like a native app and get push notifications for votes, picks, and dinner reminders.</p>
    ${
      state.deferredInstallPrompt
        ? `<div class="host-shortcut-box" style="display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
             <span><strong>Android / Chrome ready:</strong> 1-tap install is available right now.</span>
             <button class="btn btn-primary btn-sm" data-action="trigger-native-install">Install App Now</button>
           </div>`
        : ''
    }
    <div class="install-guide-grid">
      <div class="install-platform-card">
        <div class="install-platform-title"> iPhone &amp; iPad (Safari)</div>
        <ol class="install-step-list">
          <li>Open <code>dinner.tylermiranda.com</code> in <strong>Safari</strong> (iOS requires Safari—not Chrome or in-app browsers—to install web apps &amp; push alerts).</li>
          <li>Tap the <strong>Share</strong> icon (box with an upward arrow ↑) in Safari’s bottom toolbar.</li>
          <li>Scroll down and tap <strong>Add to Home Screen</strong>.</li>
          <li>Tap <strong>Add</strong> in the top-right corner.</li>
          <li>Open the new <strong>Man Night</strong> icon from your Home Screen, sign in once if prompted, then go to <strong>Crew → Enable push notifications</strong>.</li>
        </ol>
      </div>
      <div class="install-platform-card">
        <div class="install-platform-title">🤖 Android (Chrome)</div>
        <ol class="install-step-list">
          <li>Open <code>dinner.tylermiranda.com</code> in <strong>Google Chrome</strong>.</li>
          <li>If prompted at the top/bottom, tap <strong>Install</strong> (or tap the <strong>Install App Now</strong> button above).</li>
          <li>Otherwise tap Chrome’s <strong>⋮ menu</strong> (top-right corner).</li>
          <li>Tap <strong>Install app</strong> (or <strong>Add to Home screen</strong>) → confirm <strong>Install</strong>.</li>
          <li>Launch <strong>Man Night</strong> from your Home screen and allow notifications when prompted.</li>
        </ol>
      </div>
    </div>
    <div class="btn-row" style="justify-content:flex-end;margin-top:12px;">
      <button class="btn btn-secondary btn-sm" data-action="close-modal">Close</button>
    </div>
  `);
}

async function openPlacePickerModal(mode, dinnerId = null, dinnerDate = null, opts = {}) {
  await loadPlacesIfNeeded();
  const hostLabel = opts.hostLabel ? `${opts.hostLabel}’s dinner` : 'this week’s dinner';
  const title =
    mode === 'backfill'
      ? `Add place for ${fmtDate(dinnerDate)}`
      : `Pick place for ${hostLabel}${dinnerDate ? ` (${fmtShortDate(dinnerDate)})` : ''}`;

  state.pickerDay = opts.dayOfWeek === 'Wednesday' ? 'Wednesday' : 'Tuesday';
  let daySelectorHtml = '';
  if (mode === 'pick') {
    if (opts.nightOpen) {
      state.pickerAllowKeepNightVote = true;
      state.pickerKeepNightVote = true;
      daySelectorHtml = `
        <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:6px;">Tue/Wed night vote</div>
        <div class="day-toggle-group" id="picker-vote-mode-group">
          <button type="button" class="day-toggle-btn active" data-action="set-picker-vote-mode" data-keep="1">Keep Tue/Wed vote open</button>
          <button type="button" class="day-toggle-btn" data-action="set-picker-vote-mode" data-keep="0">Skip vote &amp; lock night now</button>
        </div>
        <div id="picker-day-wrap" style="display:none;">
          <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:6px;">Which night?</div>
          <div class="day-toggle-group" id="picker-day-group">
            <button type="button" class="day-toggle-btn ${state.pickerDay === 'Tuesday' ? 'active' : ''}" data-action="set-picker-day" data-day="Tuesday">Tuesday (Default)</button>
            <button type="button" class="day-toggle-btn ${state.pickerDay === 'Wednesday' ? 'active' : ''}" data-action="set-picker-day" data-day="Wednesday">Wednesday</button>
          </div>
        </div>
      `;
    } else {
      state.pickerAllowKeepNightVote = false;
      state.pickerKeepNightVote = false;
      daySelectorHtml = `
        <div class="host-shortcut-box">
          <strong>Confirming spot for ${esc(state.pickerDay)}, ${fmtShortDate(dinnerDate)} · 6:30 PM.</strong>
        </div>
        <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:6px;">Which night?</div>
        <div class="day-toggle-group" id="picker-day-group">
          <button type="button" class="day-toggle-btn ${state.pickerDay === 'Tuesday' ? 'active' : ''}" data-action="set-picker-day" data-day="Tuesday">Tuesday (Default)</button>
          <button type="button" class="day-toggle-btn ${state.pickerDay === 'Wednesday' ? 'active' : ''}" data-action="set-picker-day" data-day="Wednesday">Wednesday</button>
        </div>
      `;
    }
  } else {
    state.pickerAllowKeepNightVote = false;
    state.pickerKeepNightVote = false;
  }

  openModal(`
    <h2 class="hero-title" style="font-size:20px;margin-bottom:10px;">${esc(title)}</h2>
    ${daySelectorHtml}
    <input id="picker-q" class="input" style="width:100%;margin-bottom:10px;" placeholder="Search ${state.places.length} spots…" />
    <div id="picker-results" style="max-height:280px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:14px;"></div>
    <div style="border-top:1px solid var(--line);padding-top:12px;">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:6px;">Not in the list yet?</div>
      <div style="display:flex;gap:8px;">
        <input id="picker-new-name" class="input" style="flex:1;min-height:36px;" placeholder="New restaurant name" />
        <button class="btn btn-sm btn-primary" data-action="picker-create-and-use" data-mode="${mode}" data-dinner-id="${dinnerId || ''}">Add &amp; pick</button>
      </div>
    </div>
    <div style="margin-top:12px;text-align:right;">
      <button class="btn btn-secondary btn-sm" data-action="close-modal">Cancel</button>
    </div>
  `);
  renderPickerOptions(mode, dinnerId, '');
}

function renderPickerOptions(mode, dinnerId, q) {
  const container = document.getElementById('picker-results');
  if (!container) return;
  const term = q.trim().toLowerCase();
  const filtered = (term
    ? state.places.filter((p) => p.name.toLowerCase().includes(term) || p.address.toLowerCase().includes(term))
    : state.places
  ).slice(0, 40);

  container.innerHTML = filtered
    .map(
      (p) => `
      <button class="place-card-row" data-action="confirm-place-choice" data-mode="${mode}" data-dinner-id="${dinnerId || ''}" data-place-id="${p.id}">
        <div>
          <div class="place-name">${esc(p.name)}</div>
          <div class="place-addr">${esc(p.address || p.city)}</div>
        </div>
        <span class="badge badge-muted tabular">${p.visit_count}×</span>
      </button>
    `,
    )
    .join('');
}

function renderPollBuilderBody() {
  const tray = document.getElementById('poll-selected-tray');
  const results = document.getElementById('poll-results');
  const launchBtn = document.getElementById('poll-launch-btn');
  if (!tray || !results) return;

  const selectedSet = new Set(state.pollCandidateIds);
  const selectedPlaces = state.pollCandidateIds
    .map((id) => state.places.find((p) => p.id === id))
    .filter(Boolean);

  tray.innerHTML = selectedPlaces.length
    ? selectedPlaces
        .map(
          (p) => `
          <span class="poll-chip">
            ${esc(p.name)}
            <button type="button" data-action="remove-poll-chip" data-place-id="${p.id}" aria-label="Remove ${esc(p.name)}">✕</button>
          </span>
        `,
        )
        .join('')
    : '<span style="font-size:12px;color:var(--muted);">Select 2–6 places below (or tap Suggest 4 random).</span>';

  const term = state.pollSearchQuery.trim().toLowerCase();
  const matching = term
    ? state.places.filter((p) => p.name.toLowerCase().includes(term) || (p.address || '').toLowerCase().includes(term))
    : [...selectedPlaces, ...state.places.filter((p) => !selectedSet.has(p.id))];
  const visible = matching.slice(0, 40);

  results.innerHTML = visible
    .map((p) => {
      const isSel = selectedSet.has(p.id);
      const badge = isSel
        ? '<span class="badge badge-ok">✓ In poll</span>'
        : `<span class="badge badge-muted tabular">${p.visit_count}×${p.avg_rating != null ? ` · ★ ${Number(p.avg_rating).toFixed(1)}` : ''}</span>`;
      return `
        <button type="button" class="place-card-row ${isSel ? 'selected' : ''}" data-action="toggle-poll-place" data-place-id="${p.id}">
          <div>
            <div class="place-name">${esc(p.name)}</div>
            <div class="place-addr">${esc(p.address || p.city)}</div>
          </div>
          ${badge}
        </button>
      `;
    })
    .join('');

  if (launchBtn) {
    const count = state.pollCandidateIds.length;
    launchBtn.textContent = `Launch poll (${count})`;
    launchBtn.disabled = count < 2;
  }
}

async function openPollBuilderModal(dinnerId) {
  await loadPlacesIfNeeded();
  const activeDinner = state.bootstrap?.thisWeek?.dinner;
  const target =
    activeDinner?.id === dinnerId
      ? activeDinner
      : (state.bootstrap?.upcoming || []).find((u) => u.id === dinnerId) || activeDinner;
  if (!target) return;

  const nightOpen = !target.night_locked_at && (target.status === 'scheduled' || target.status === 'night_poll');
  const dayOfWeek = target.day_of_week === 'Wednesday' ? 'Wednesday' : 'Tuesday';
  const existingIds = parsePollIds(target.noon_draw_ids);
  state.pollCandidateIds = existingIds.slice(0, 6);
  state.pollSearchQuery = '';
  const isEditing = state.pollCandidateIds.length >= 2;

  openModal(`
    <h2 class="hero-title" style="font-size:20px;margin-bottom:6px;">${isEditing ? 'Edit place poll' : 'Create place poll'} for ${esc(target.host_label)}’s dinner (${fmtShortDate(target.dinner_date)})</h2>
    <p class="hero-sub" style="margin-bottom:10px;font-size:13px;">${
      nightOpen
        ? 'The Tuesday/Wednesday night vote stays open — members can vote on both day and place.'
        : `Vote opens immediately for ${esc(dayOfWeek)} · ${fmtShortDate(target.dinner_date)}.`
    }</p>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">
      <span style="font-size:12px;font-weight:700;color:var(--muted);">Poll options (2–6 places)</span>
      <button type="button" class="btn btn-outline btn-sm" style="min-height:28px;padding:3px 10px;font-size:12px;" data-action="poll-fill-random">🎲 Suggest 4 random</button>
    </div>
    <div id="poll-selected-tray" class="poll-tray"></div>
    <input id="poll-q" class="input" style="width:100%;margin-bottom:10px;" placeholder="Search ${state.places.length} spots to toggle in poll…" />
    <div id="poll-results" style="max-height:240px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;margin-bottom:12px;"></div>
    <div style="border-top:1px solid var(--line);padding-top:10px;margin-bottom:12px;">
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:6px;">Add a new spot to poll?</div>
      <div style="display:flex;gap:8px;">
        <input id="poll-new-name" class="input" style="flex:1;min-height:36px;" placeholder="New restaurant name" />
        <button type="button" class="btn btn-sm btn-outline" data-action="poll-create-and-add">Add to poll</button>
      </div>
    </div>
    <div class="btn-row" style="justify-content:flex-end;">
      <button type="button" class="btn btn-secondary btn-sm" data-action="close-modal">Cancel</button>
      <button type="button" id="poll-launch-btn" class="btn btn-primary btn-sm" data-action="submit-place-poll" data-dinner-id="${target.id}" data-night-open="${nightOpen ? '1' : '0'}" data-day="${esc(dayOfWeek)}">Launch poll (${state.pollCandidateIds.length})</button>
    </div>
  `);
  renderPollBuilderBody();
}

async function refreshRecentIssuesList() {
  const el = document.getElementById('recent-issues-list');
  if (!el) return;
  try {
    const data = await api('/api/issues');
    const items = (data.issues || []).slice(0, 6);
    if (!items.length) {
      el.innerHTML = '<div style="font-size:12px;color:var(--muted);">No reports submitted yet.</div>';
      return;
    }
    el.innerHTML = items
      .map((it) => {
        const badgeCls = it.webhook_status?.includes('github') ? 'badge-ok' : 'badge-muted';
        const linkHtml = it.github_issue_url
          ? `<a href="${esc(it.github_issue_url)}" target="_blank" rel="noopener" style="font-weight:700;font-size:12px;">#${it.github_issue_number} ↗</a>`
          : `<span class="badge badge-muted">#${it.id}</span>`;
        return `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12px;">
            <div style="min-width:0;">
              <div style="font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(it.title)}</div>
              <div style="color:var(--muted);">${esc(it.category)} · <span class="badge ${badgeCls}" style="padding:1px 6px;font-size:10px;">${esc(it.webhook_status)}</span></div>
            </div>
            <div style="flex-shrink:0;">${linkHtml}</div>
          </div>
        `;
      })
      .join('');
  } catch {
    el.innerHTML = '<div style="font-size:12px;color:var(--muted);">Could not load recent reports.</div>';
  }
}

function openReportIssueModal() {
  const ctx = `Tab: ${state.tab}; Week: ${state.bootstrap?.thisWeek?.dinner?.week_key || 'none'} (${state.bootstrap?.thisWeek?.dinner?.status || 'none'})`;
  openModal(`
    <h2 class="hero-title" style="font-size:20px;margin-bottom:6px;">Report an issue</h2>
    <p class="hero-sub" style="margin-bottom:14px;">Opens a GitHub issue on <code>tylermiranda/man-night</code> and queues OpenBot to fix &amp; redeploy automatically.</p>
    <div class="stack" style="gap:10px;">
      <input id="issue-title" class="input" placeholder="Short summary (e.g. Wrong address for Poplar)" />
      <select id="issue-category" class="select">
        <option value="bug">App bug or layout glitch</option>
        <option value="data">Wrong venue / history data</option>
        <option value="feature">Feature suggestion</option>
        <option value="access">Notifications / Calendar issue</option>
      </select>
      <textarea id="issue-desc" class="textarea" placeholder="What happened or what should change?"></textarea>
      <div style="font-size:12px;color:var(--muted);">Context attached: <code>${esc(ctx)}</code></div>
      <div id="issue-feedback"></div>
      <div class="btn-row" style="justify-content:flex-end;">
        <button class="btn btn-secondary btn-sm" data-action="close-modal">Close</button>
        <button id="issue-submit-btn" class="btn btn-primary btn-sm" data-action="submit-issue" data-ctx="${esc(ctx)}">Submit issue</button>
      </div>
      <div style="margin-top:8px;padding-top:10px;border-top:1px solid var(--line);">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin-bottom:4px;">Recent reports</div>
        <div id="recent-issues-list"><div style="font-size:12px;color:var(--muted);">Loading recent reports…</div></div>
      </div>
    </div>
  `);
  refreshRecentIssuesList();
}

function openPassSwapModal() {
  const d = state.bootstrap?.thisWeek?.dinner;
  const crew = (state.bootstrap?.users || []).filter((u) => u.is_rotation && u.slug !== d?.host_slug);
  openModal(`
    <h2 class="hero-title" style="font-size:20px;margin-bottom:6px;">Pass or swap turn</h2>
    <p class="hero-sub" style="margin-bottom:14px;">Current host for ${fmtShortDate(d?.dinner_date)} is <strong>${esc(d?.host_label)}</strong>.</p>
    <div class="stack" style="gap:10px;">
      <button class="btn btn-outline" data-action="exec-rotation" data-rot="pass">Pass to next person in order</button>
      <div style="font-size:12px;font-weight:700;color:var(--muted);margin-top:6px;">Or swap turns with:</div>
      <div class="btn-row">
        ${crew.map((u) => `<button class="btn btn-sm btn-secondary" data-action="exec-rotation" data-rot="swap" data-target="${esc(u.slug)}">Swap w/ ${esc(u.name)}</button>`).join('')}
      </div>
      <div style="text-align:right;margin-top:8px;">
        <button class="btn btn-secondary btn-sm" data-action="close-modal">Cancel</button>
      </div>
    </div>
  `);
}

function openNewPlaceModal() {
  openModal(`
    <h2 class="hero-title" style="font-size:20px;margin-bottom:10px;">Add new restaurant</h2>
    <div class="stack" style="gap:10px;">
      <input id="np-name" class="input" placeholder="Restaurant name" />
      <input id="np-addr" class="input" placeholder="Street address, Wichita, KS" />
      <input id="np-city" class="input" placeholder="City (default Wichita)" value="Wichita" />
      <div class="btn-row" style="justify-content:flex-end;">
        <button class="btn btn-secondary btn-sm" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary btn-sm" data-action="create-place">Save place</button>
      </div>
    </div>
  `);
}

async function openReviewModal(dinnerId) {
  openModal(`<div style="padding:12px 0;font-size:14px;color:var(--muted);">Loading dinner reviews…</div>`);
  try {
    const data = await api(`/api/dinners/${dinnerId}/reviews`);
    const d = data.dinner;
    const reviews = data.reviews || [];
    const me = state.bootstrap?.user;
    const myReview = reviews.find((r) => r.user_slug === me?.slug);
    state.modalRatingScore = myReview ? Number(myReview.score) : 5;
    const title = d.restaurant_name || d.raw_location?.split(',')[0] || 'Dinner review';
    const reviewsHtml = reviews.length
      ? `<div style="margin-bottom:12px;">
           <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted);margin-bottom:6px;">Crew reviews (${reviews.length})</div>
           <div class="review-list">${reviews.map((r) => renderReviewItem(r, false)).join('')}</div>
         </div>`
      : `<p class="hero-sub" style="margin-bottom:12px;font-size:13px;">No crew reviews for this night yet — be the first.</p>`;

    openModal(`
      <h2 class="hero-title" style="font-size:20px;margin-bottom:4px;">${esc(title)}</h2>
      <p class="hero-sub" style="margin-bottom:12px;">${esc(d.day_of_week || 'Tuesday')}, ${fmtDate(d.dinner_date)} · Hosted by ${esc(d.host_label)}</p>
      ${reviewsHtml}
      <div style="border-top:1px solid var(--line);padding-top:12px;">
        <div style="font-size:12px;font-weight:700;color:var(--muted);margin-bottom:6px;">${myReview ? 'Your review' : 'Add your review'}</div>
        <div id="modal-review-stars" class="star-row" style="margin-bottom:10px;">
          ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="star-btn ${state.modalRatingScore >= n ? 'on' : ''}" data-action="set-modal-star" data-score="${n}">★</button>`).join('')}
        </div>
        <div class="stack" style="gap:8px;">
          <input id="modal-rate-dish" class="input" placeholder="Standout dish (optional)" value="${esc(myReview?.dish || '')}" />
          <textarea id="modal-rate-comment" class="textarea" style="min-height:72px;" placeholder="Review note — food, vibe, would go back? (optional)">${esc(myReview?.comment || '')}</textarea>
        </div>
        <div class="btn-row" style="justify-content:flex-end;margin-top:12px;">
          <button class="btn btn-secondary btn-sm" data-action="close-modal">Cancel</button>
          <button class="btn btn-primary btn-sm" data-action="submit-modal-rate" data-dinner-id="${dinnerId}">${myReview ? 'Update review' : 'Save review'}</button>
        </div>
      </div>
    `);
  } catch (err) {
    closeModal();
    toast(err.message || 'Could not load reviews');
  }
}

function closeUserMenu() {
  const menu = document.getElementById('user-menu');
  const pill = document.getElementById('user-pill');
  if (menu) menu.classList.add('hidden');
  if (pill) pill.setAttribute('aria-expanded', 'false');
}

function toggleUserMenu() {
  const menu = document.getElementById('user-menu');
  const pill = document.getElementById('user-pill');
  if (!menu) return;
  const open = menu.classList.toggle('hidden') === false;
  if (pill) pill.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function openSettingsModal(feedbackHtml = '') {
  const me = state.bootstrap?.user || {};
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  openModal(`
    <h2 class="hero-title" style="font-size:20px;margin-bottom:4px;">Settings</h2>
    <p class="hero-sub" style="margin-bottom:14px;">Signed in as <strong>${esc(me.name || '')}</strong> (${esc(me.email || '')})</p>

    <div class="settings-block">
      <div class="settings-block-title">
        <span>Appearance · Light / Dark Mode</span>
        <span class="badge badge-muted">${esc(resolveEffectiveTheme(state.theme))}</span>
      </div>
      <div class="theme-switch-group">
        <button type="button" class="theme-switch-btn ${state.theme === 'light' ? 'active' : ''}" data-action="set-theme" data-theme="light">☀️ Light</button>
        <button type="button" class="theme-switch-btn ${state.theme === 'dark' ? 'active' : ''}" data-action="set-theme" data-theme="dark">🌙 Dark</button>
        <button type="button" class="theme-switch-btn ${state.theme === 'system' ? 'active' : ''}" data-action="set-theme" data-theme="system">💻 Auto</button>
      </div>
    </div>

    <div class="settings-block">
      <div class="settings-block-title">
        <span>Test &amp; Push Notifications</span>
        <span class="badge ${me.push_enabled ? 'badge-ok' : 'badge-muted'}">${me.push_enabled ? 'Push active' : 'Not enabled'}</span>
      </div>
      <p style="font-size:12px;color:var(--muted);margin:0 0 10px;">
        Permission: <strong>${esc(perm)}</strong>. Test sending an alert to your subscribed devices (and preview locally if allowed).
      </p>
      <div class="btn-row" style="margin-bottom:10px;">
        <button class="btn btn-primary btn-sm" data-action="test-push">Send test notification</button>
        <button class="btn btn-outline btn-sm" data-action="enable-push">${me.push_enabled ? 'Re-sync push' : 'Enable push'}</button>
      </div>
      <div id="settings-push-feedback">${feedbackHtml}</div>
      <label style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:13px;">
        <span>Sunday night vote open</span>
        <input type="checkbox" data-pref="notify_night_vote" ${me.notify_night_vote ? 'checked' : ''} />
      </label>
      <label style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:13px;">
        <span>Place locked / Noon rule alert</span>
        <input type="checkbox" data-pref="notify_place" ${me.notify_place ? 'checked' : ''} />
      </label>
      <label style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-top:1px solid var(--line);font-size:13px;">
        <span>30-min dinner reminder</span>
        <input type="checkbox" data-pref="notify_reminder" ${me.notify_reminder ? 'checked' : ''} />
      </label>
    </div>

    <div class="btn-row" style="justify-content:space-between;margin-top:12px;">
      <div class="btn-row">
        <button class="btn btn-outline btn-sm" data-action="open-install-guide">Install App Guide</button>
        <button class="btn btn-outline btn-sm" data-action="open-walkthrough">How it works</button>
      </div>
      <button class="btn btn-secondary btn-sm" data-action="close-modal">Done</button>
    </div>
  `);
}

async function runTestNotification() {
  const res = await api('/api/push/test', { method: 'POST', body: '{}' });
  let localShown = false;
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.ready : null;
      if (reg?.showNotification) {
        await reg.showNotification('Man Night test notification', {
          body: 'Notifications are working! Dinner reminders open Google Maps directions.',
          icon: '/icons/icon-192.png',
          badge: '/icons/icon-192.png',
          tag: 'man-night-test-local',
        });
        localShown = true;
      }
    } catch {
      // Ignore if local SW preview is blocked in current context
    }
  }

  let msg = '';
  if (res.sent > 0) {
    msg = `Sent Web Push test alert to ${res.sent} subscribed device(s).`;
    toast('Test notification sent!');
  } else if (localShown) {
    msg = 'Preview notification displayed locally! Tap "Enable push" to register for background Web Push alerts.';
    toast('Local test notification displayed!');
  } else {
    msg = 'No active push subscription yet. Tap "Enable push" first (on iPhone, install via Safari Add to Home Screen first).';
    toast('No active subscription yet.');
  }

  const fb = document.getElementById('settings-push-feedback');
  if (fb) {
    fb.innerHTML = `<div class="badge ${res.sent > 0 || localShown ? 'badge-ok' : 'badge-muted'}" style="padding:8px 10px;border-radius:10px;width:100%;margin-bottom:8px;white-space:normal;line-height:1.35;">${esc(msg)}</div>`;
  }
}

// Event delegation
document.addEventListener('click', async (e) => {
  if (!e.target.closest('#user-menu-wrap')) {
    closeUserMenu();
  }

  if (e.target.closest('#user-pill')) {
    toggleUserMenu();
    return;
  }

  const tabBtn = e.target.closest('[data-tab]');
  if (tabBtn) {
    setTab(tabBtn.dataset.tab);
    return;
  }

  if (e.target.id === 'modal-backdrop') {
    closeModal();
    return;
  }

  if (e.target.id === 'btn-install-top') {
    openInstallGuideModal();
    return;
  }
  if (e.target.id === 'btn-help') {
    showWalkthrough(0);
    return;
  }
  if (e.target.id === 'btn-report-top') {
    openReportIssueModal();
    return;
  }

  const actEl = e.target.closest('[data-action]');
  if (!actEl) return;
  const action = actEl.dataset.action;

  try {
    if (action === 'close-modal') {
      closeModal();
    } else if (action === 'open-settings') {
      closeUserMenu();
      openSettingsModal();
    } else if (action === 'set-theme') {
      applyTheme(actEl.dataset.theme);
      toast(`Theme set to ${actEl.dataset.theme}`);
      if (document.getElementById('settings-push-feedback')) {
        openSettingsModal(document.getElementById('settings-push-feedback').innerHTML);
      } else {
        render();
      }
    } else if (action === 'open-install-guide') {
      openInstallGuideModal();
    } else if (action === 'dismiss-install-banner') {
      state.installBannerDismissed = true;
      localStorage.setItem('mn_install_dismissed', '1');
      render();
    } else if (action === 'trigger-native-install') {
      if (!state.deferredInstallPrompt) {
        openInstallGuideModal();
        return;
      }
      state.deferredInstallPrompt.prompt();
      const choice = await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      if (choice?.outcome === 'accepted') {
        toast('Man Night added to Home Screen!');
        closeModal();
      }
      render();
    } else if (action === 'goto-tab') {
      setTab(actEl.dataset.target);
    } else if (action === 'vote-night') {
      await api('/api/week/vote-night', {
        method: 'POST',
        body: JSON.stringify({ dinnerId: state.bootstrap.thisWeek.dinner.id, choice: actEl.dataset.choice }),
      });
      toast(`Voted for ${actEl.dataset.choice}`);
      await refreshBootstrap();
    } else if (action === 'vote-noon') {
      await api('/api/week/vote-noon', {
        method: 'POST',
        body: JSON.stringify({
          dinnerId: state.bootstrap.thisWeek.dinner.id,
          restaurantId: Number(actEl.dataset.placeId),
        }),
      });
      toast('Noon vote saved');
      await refreshBootstrap();
    } else if (action === 'rsvp') {
      await api('/api/week/rsvp', {
        method: 'POST',
        body: JSON.stringify({
          dinnerId: state.bootstrap.thisWeek.dinner.id,
          status: actEl.dataset.status,
          etaMinutes: actEl.dataset.status === 'late' ? 15 : null,
        }),
      });
      toast('RSVP updated');
      await refreshBootstrap();
    } else if (action === 'set-star') {
      state.ratingScore = Number(actEl.dataset.score);
      document.querySelectorAll('#last-dinner-stars .star-btn').forEach((btn) => {
        btn.classList.toggle('on', Number(btn.dataset.score) <= state.ratingScore);
      });
    } else if (action === 'submit-rate') {
      const dish = document.getElementById('rate-dish-input')?.value || '';
      const comment = document.getElementById('rate-comment-input')?.value || '';
      await api('/api/week/rate', {
        method: 'POST',
        body: JSON.stringify({ dinnerId: Number(actEl.dataset.dinnerId), score: state.ratingScore, dish, comment }),
      });
      state.places = [];
      state.placeReviews = {};
      toast('Review saved!');
      await refreshBootstrap();
    } else if (action === 'open-review-modal') {
      await openReviewModal(Number(actEl.dataset.dinnerId));
    } else if (action === 'set-modal-star') {
      state.modalRatingScore = Number(actEl.dataset.score);
      document.querySelectorAll('#modal-review-stars .star-btn').forEach((btn) => {
        btn.classList.toggle('on', Number(btn.dataset.score) <= state.modalRatingScore);
      });
    } else if (action === 'submit-modal-rate') {
      const dinnerId = Number(actEl.dataset.dinnerId);
      const dish = document.getElementById('modal-rate-dish')?.value || '';
      const comment = document.getElementById('modal-rate-comment')?.value || '';
      await api('/api/week/rate', {
        method: 'POST',
        body: JSON.stringify({ dinnerId, score: state.modalRatingScore, dish, comment }),
      });
      state.places = [];
      state.placeReviews = {};
      closeModal();
      toast('Review saved!');
      await refreshBootstrap();
      if (state.tab === 'places') {
        await loadPlacesIfNeeded();
        render();
      } else if (state.tab === 'history') {
        await loadHistory(false);
      }
    } else if (action === 'set-picker-vote-mode') {
      state.pickerKeepNightVote = actEl.dataset.keep === '1';
      document.querySelectorAll('#picker-vote-mode-group .day-toggle-btn').forEach((btn) => {
        btn.classList.toggle('active', (btn.dataset.keep === '1') === state.pickerKeepNightVote);
      });
      const dayWrap = document.getElementById('picker-day-wrap');
      if (dayWrap) dayWrap.style.display = state.pickerKeepNightVote ? 'none' : 'block';
    } else if (action === 'set-picker-day') {
      state.pickerDay = actEl.dataset.day === 'Wednesday' ? 'Wednesday' : 'Tuesday';
      document.querySelectorAll('#picker-day-group .day-toggle-btn').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.day === state.pickerDay);
      });
    } else if (action === 'open-picker') {
      const d = state.bootstrap.thisWeek.dinner;
      const dinnerId = Number(actEl.dataset.dinnerId || d.id);
      const dinnerDate = actEl.dataset.date || d.dinner_date;
      const dayOfWeek = actEl.dataset.day || d.day_of_week;
      const hostLabel = actEl.dataset.host || d.host_label;
      const nightOpen = actEl.dataset.nightOpen === '1';
      await openPlacePickerModal('pick', dinnerId, dinnerDate, { dayOfWeek, hostLabel, nightOpen });
    } else if (action === 'open-poll-builder') {
      const dinnerId = Number(actEl.dataset.dinnerId || state.bootstrap?.thisWeek?.dinner?.id);
      await openPollBuilderModal(dinnerId);
    } else if (action === 'toggle-poll-place') {
      const placeId = Number(actEl.dataset.placeId);
      const idx = state.pollCandidateIds.indexOf(placeId);
      if (idx >= 0) {
        state.pollCandidateIds = state.pollCandidateIds.filter((id) => id !== placeId);
      } else {
        if (state.pollCandidateIds.length >= 6) return toast('Poll supports up to 6 places');
        state.pollCandidateIds = [...state.pollCandidateIds, placeId];
      }
      renderPollBuilderBody();
    } else if (action === 'remove-poll-chip') {
      const placeId = Number(actEl.dataset.placeId);
      state.pollCandidateIds = state.pollCandidateIds.filter((id) => id !== placeId);
      renderPollBuilderBody();
    } else if (action === 'poll-fill-random') {
      const cutoff = new Date(Date.now() - 56 * 86400000).toISOString().slice(0, 10);
      const pool = state.places.filter((p) => !p.last_visited || p.last_visited < cutoff);
      const source = [...(pool.length >= 4 ? pool : state.places)];
      for (let i = source.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [source[i], source[j]] = [source[j], source[i]];
      }
      state.pollCandidateIds = source.slice(0, 4).map((p) => p.id);
      renderPollBuilderBody();
    } else if (action === 'poll-create-and-add') {
      const nameEl = document.getElementById('poll-new-name');
      const name = nameEl?.value?.trim();
      if (!name) return toast('Enter a restaurant name');
      const created = await api('/api/places', { method: 'POST', body: JSON.stringify({ name }) });
      state.places = [created.place, ...state.places];
      if (!state.pollCandidateIds.includes(created.place.id)) {
        if (state.pollCandidateIds.length >= 6) return toast('Poll supports up to 6 places');
        state.pollCandidateIds = [...state.pollCandidateIds, created.place.id];
      }
      if (nameEl) nameEl.value = '';
      renderPollBuilderBody();
      toast(`Added ${created.place.name}`);
    } else if (action === 'submit-place-poll') {
      if (state.pollCandidateIds.length < 2) return toast('Select at least 2 places');
      const dinnerId = Number(actEl.dataset.dinnerId);
      const keepNightVote = actEl.dataset.nightOpen === '1';
      await api('/api/week/create-poll', {
        method: 'POST',
        body: JSON.stringify({
          dinnerId,
          restaurantIds: state.pollCandidateIds,
          keepNightVote,
          dayOfWeek: keepNightVote ? undefined : actEl.dataset.day,
        }),
      });
      closeModal();
      toast('Place poll live!');
      await refreshBootstrap();
    } else if (action === 'close-place-poll') {
      const dinnerId = Number(actEl.dataset.dinnerId || state.bootstrap?.thisWeek?.dinner?.id);
      await api('/api/week/close-poll', {
        method: 'POST',
        body: JSON.stringify({ dinnerId }),
      });
      toast('Winning place set!');
      await refreshBootstrap();
    } else if (action === 'open-backfill') {
      await openPlacePickerModal('backfill', Number(actEl.dataset.dinnerId), actEl.dataset.date);
    } else if (action === 'confirm-place-choice') {
      const mode = actEl.dataset.mode;
      const dinnerId = Number(actEl.dataset.dinnerId);
      const placeId = Number(actEl.dataset.placeId);
      if (mode === 'backfill') {
        await api(`/api/dinners/${dinnerId}/backfill`, { method: 'POST', body: JSON.stringify({ restaurantId: placeId }) });
        closeModal();
        toast('History place updated!');
        await refreshBootstrap();
        if (state.tab === 'history') await loadHistory(false);
      } else {
        const body = state.pickerKeepNightVote
          ? { dinnerId, restaurantId: placeId, keepNightVote: true }
          : { dinnerId, restaurantId: placeId, dayOfWeek: state.pickerDay, keepNightVote: false };
        await api('/api/week/pick-place', { method: 'POST', body: JSON.stringify(body) });
        closeModal();
        toast(state.pickerKeepNightVote ? 'Spot set! Tue/Wed night vote stays open.' : `Locked in (${state.pickerDay}, no vote)!`);
        await refreshBootstrap();
      }
    } else if (action === 'picker-create-and-use') {
      const name = document.getElementById('picker-new-name')?.value?.trim();
      if (!name) return toast('Enter a restaurant name');
      const created = await api('/api/places', { method: 'POST', body: JSON.stringify({ name }) });
      state.places = [created.place, ...state.places];
      const mode = actEl.dataset.mode;
      const dinnerId = Number(actEl.dataset.dinnerId);
      if (mode === 'backfill') {
        await api(`/api/dinners/${dinnerId}/backfill`, { method: 'POST', body: JSON.stringify({ restaurantId: created.place.id }) });
        closeModal();
        await refreshBootstrap();
        if (state.tab === 'history') await loadHistory(false);
        toast(`Added & linked ${created.place.name}`);
      } else {
        const body = state.pickerKeepNightVote
          ? { dinnerId, restaurantId: created.place.id, keepNightVote: true }
          : { dinnerId, restaurantId: created.place.id, dayOfWeek: state.pickerDay, keepNightVote: false };
        await api('/api/week/pick-place', { method: 'POST', body: JSON.stringify(body) });
        closeModal();
        await refreshBootstrap();
        toast(state.pickerKeepNightVote ? `Added & set ${created.place.name}` : `Added & locked ${created.place.name}`);
      }
    } else if (action === 'open-pass-swap') {
      openPassSwapModal();
    } else if (action === 'exec-rotation') {
      await api('/api/week/rotation', {
        method: 'POST',
        body: JSON.stringify({
          dinnerId: state.bootstrap.thisWeek.dinner.id,
          action: actEl.dataset.rot,
          targetSlug: actEl.dataset.target || undefined,
        }),
      });
      closeModal();
      toast('Rotation updated');
      await refreshBootstrap();
    } else if (action === 'filter-host') {
      state.historyHost = actEl.dataset.host;
      loadHistory(false);
    } else if (action === 'filter-places') {
      state.placesFilter = actEl.dataset.filter || 'all';
      render();
    } else if (action === 'focus-trophy') {
      state.placesFilter = 'all';
      state.placesQuery = '';
      state.selectedPlaceId = Number(actEl.dataset.placeId);
      render();
    } else if (action === 'focus-place') {
      state.placesFilter = 'all';
      state.placesQuery = '';
      state.selectedPlaceId = Number(actEl.dataset.placeId);
      setTab('places');
    } else if (action === 'filter-place-history') {
      state.historyPlaceId = Number(actEl.dataset.placeId);
      state.historyHost = '';
      state.historyQuery = '';
      setTab('history');
    } else if (action === 'clear-place-filter') {
      state.historyPlaceId = null;
      loadHistory(false);
    } else if (action === 'load-more-history') {
      loadHistory(true);
    } else if (action === 'select-place') {
      state.selectedPlaceId = Number(actEl.dataset.placeId);
      render();
    } else if (action === 'open-new-place') {
      openNewPlaceModal();
    } else if (action === 'create-place') {
      const name = document.getElementById('np-name')?.value?.trim();
      const address = document.getElementById('np-addr')?.value?.trim();
      const city = document.getElementById('np-city')?.value?.trim();
      if (!name) return toast('Name is required');
      const res = await api('/api/places', { method: 'POST', body: JSON.stringify({ name, address, city }) });
      state.places = [res.place, ...state.places];
      state.selectedPlaceId = res.place.id;
      closeModal();
      toast(`Saved ${res.place.name}`);
      render();
    } else if (action === 'enable-push' || action === 'walk-enable-push') {
      const inSettings = Boolean(document.getElementById('settings-push-feedback'));
      await enableWebPush();
      if (inSettings) openSettingsModal();
    } else if (action === 'test-push') {
      await runTestNotification();
    } else if (action === 'open-walkthrough') {
      showWalkthrough(0);
    } else if (action === 'walk-prev') {
      showWalkthrough(Math.max(0, state.walkStep - 1));
    } else if (action === 'walk-next') {
      showWalkthrough(state.walkStep + 1);
    } else if (action === 'walk-close') {
      closeModal();
      if (!state.bootstrap.user.walkthrough_seen) {
        await api('/api/user/walkthrough', { method: 'POST', body: '{}' });
        state.bootstrap.user.walkthrough_seen = true;
      }
    } else if (action === 'open-report') {
      openReportIssueModal();
    } else if (action === 'submit-issue') {
      const title = document.getElementById('issue-title')?.value?.trim();
      const category = document.getElementById('issue-category')?.value || 'bug';
      const description = document.getElementById('issue-desc')?.value?.trim();
      if (!title || !description) return toast('Enter a title and description');
      actEl.disabled = true;
      const res = await api('/api/issues', {
        method: 'POST',
        body: JSON.stringify({ title, category, description, pageContext: actEl.dataset.ctx }),
      });
      const fb = document.getElementById('issue-feedback');
      if (res.issue?.github_issue_url) {
        fb.innerHTML = `<div class="badge badge-ok" style="padding:8px 12px;border-radius:10px;width:100%;">Created GitHub Issue #${res.issue.github_issue_number} · <a href="${esc(res.issue.github_issue_url)}" target="_blank" rel="noopener">View issue ↗</a></div>`;
        toast('Issue reported & queued for OpenBot!');
      } else {
        fb.innerHTML = `<div class="badge badge-muted" style="padding:8px 12px;border-radius:10px;">Saved report #${res.issue?.id} (${esc(res.issue?.webhook_status)})</div>`;
      }
      await refreshRecentIssuesList();
      actEl.disabled = false;
    }
  } catch (err) {
    toast(err.message || 'Action failed');
  }
});

let searchTimer = null;
document.addEventListener('input', (e) => {
  if (e.target.id === 'picker-q') {
    const btn = document.querySelector('[data-action="picker-create-and-use"]');
    renderPickerOptions(btn?.dataset.mode || 'pick', btn?.dataset.dinnerId || '', e.target.value);
  } else if (e.target.id === 'poll-q') {
    state.pollSearchQuery = e.target.value;
    renderPollBuilderBody();
  } else if (e.target.id === 'history-search') {
    state.historyQuery = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadHistory(false), 220);
  } else if (e.target.id === 'places-search') {
    state.placesQuery = e.target.value;
    render();
  }
});

document.addEventListener('change', async (e) => {
  if (e.target.id === 'places-sort') {
    state.placesSort = e.target.value;
    render();
  } else if (e.target.dataset.pref) {
    const key = e.target.dataset.pref;
    await api('/api/user/prefs', { method: 'PATCH', body: JSON.stringify({ [key]: e.target.checked }) });
    state.bootstrap.user[key] = e.target.checked;
    toast('Preferences saved');
  }
});

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  try {
    await refreshBootstrap();
    if (state.bootstrap?.user && !state.bootstrap.user.walkthrough_seen) {
      showWalkthrough(0);
    }
  } catch (err) {
    document.getElementById('main-content').innerHTML = `
      <div class="card">
        <h2>Could not load Man Night</h2>
        <p class="hero-sub">${esc(err.message)}</p>
      </div>
    `;
  }
}

boot();
