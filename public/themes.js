/**
 * Custom seasonal themes for Man Night (dinner.tylermiranda.com).
 * Zero-dependency ES module shared between the browser PWA and Vitest tests.
 */

export const SEASON_THEMES = [
  {
    id: 'classic',
    name: 'Classic',
    emoji: '🍽️',
    subtitle: 'Signature Man Night',
    windowLabel: 'Default',
    swatches: ['#e5484d', '#18181b', '#f4f4f5'],
    themeColorLight: '#ffffff',
    themeColorDark: '#121215',
  },
  {
    id: 'thanksgiving',
    name: 'Thanksgiving',
    emoji: '🦃',
    subtitle: 'Harvest amber & spice',
    windowLabel: 'Nov',
    swatches: ['#c2410c', '#d97706', '#f7ede0'],
    themeColorLight: '#fffaf3',
    themeColorDark: '#17110d',
  },
  {
    id: 'christmas',
    name: 'Christmas',
    emoji: '🎄',
    subtitle: 'Cranberry, pine & gold',
    windowLabel: 'Dec',
    swatches: ['#b91c1c', '#15803d', '#ca8a04'],
    themeColorLight: '#fbfdfa',
    themeColorDark: '#0d1612',
  },
  {
    id: 'halloween',
    name: 'Halloween',
    emoji: '🎃',
    subtitle: 'Pumpkin & midnight plum',
    windowLabel: 'Oct',
    swatches: ['#c2410c', '#7e22ce', '#1f1429'],
    themeColorLight: '#fdfaf7',
    themeColorDark: '#120d18',
  },
  {
    id: 'winter',
    name: 'Winter',
    emoji: '❄️',
    subtitle: 'Frost blue & crisp slate',
    windowLabel: 'Jan–Feb',
    swatches: ['#1d4ed8', '#0ea5e9', '#ebf3fc'],
    themeColorLight: '#f8fbff',
    themeColorDark: '#0b1220',
  },
  {
    id: 'stpatricks',
    name: "St. Patrick's",
    emoji: '☘️',
    subtitle: 'Emerald & lucky gold',
    windowLabel: 'Mar 1–20',
    swatches: ['#15803d', '#22c55e', '#eab308'],
    themeColorLight: '#f7fcf9',
    themeColorDark: '#0a1710',
  },
  {
    id: 'spring',
    name: 'Spring',
    emoji: '🌸',
    subtitle: 'Blossom & fresh meadow',
    windowLabel: 'Mar 21–May',
    swatches: ['#be185d', '#f472b6', '#4ade80'],
    themeColorLight: '#fffafd',
    themeColorDark: '#170e15',
  },
  {
    id: 'july4',
    name: '4th of July',
    emoji: '🎆',
    subtitle: 'Fireworks red & navy',
    windowLabel: 'Jun 28–Jul 7',
    swatches: ['#c81e3a', '#1d4ed8', '#edf2fa'],
    themeColorLight: '#fafcff',
    themeColorDark: '#0c1324',
  },
  {
    id: 'summer',
    name: 'Summer BBQ',
    emoji: '☀️',
    subtitle: 'Patio teal & grill gold',
    windowLabel: 'Jun–Aug',
    swatches: ['#0f766e', '#f59e0b', '#f4f1e6'],
    themeColorLight: '#fffdf8',
    themeColorDark: '#0c1716',
  },
];

export const SEASON_THEME_IDS = SEASON_THEMES.map((t) => t.id);

const SEASON_BY_ID = new Map(SEASON_THEMES.map((t) => [t.id, t]));

/**
 * Determine the automatic seasonal theme for a given ISO date (YYYY-MM-DD).
 * Returns 'classic' outside dedicated seasonal windows (e.g. September).
 */
export function resolveAutoSeasonTheme(isoDate) {
  if (typeof isoDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    return 'classic';
  }
  const month = Number(isoDate.slice(5, 7));
  const day = Number(isoDate.slice(8, 10));
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return 'classic';
  }

  if (month === 11) return 'thanksgiving';
  if (month === 12) return 'christmas';
  if (month === 1 || month === 2) return 'winter';
  if (month === 3 && day <= 20) return 'stpatricks';
  if ((month === 3 && day >= 21) || month === 4 || month === 5) return 'spring';
  if ((month === 6 && day >= 28) || (month === 7 && day <= 7)) return 'july4';
  if (month === 6 || month === 7 || month === 8) return 'summer';
  if (month === 10) return 'halloween';
  return 'classic';
}

export function normalizeSeasonThemePref(pref) {
  if (pref === 'auto') return 'auto';
  if (typeof pref === 'string' && SEASON_BY_ID.has(pref)) return pref;
  return 'auto';
}

export function resolveEffectiveSeasonTheme(pref, isoDate) {
  const normalized = normalizeSeasonThemePref(pref);
  if (normalized === 'auto') {
    return resolveAutoSeasonTheme(isoDate);
  }
  return normalized;
}

export function getSeasonThemeMeta(id) {
  return SEASON_BY_ID.get(id) || SEASON_BY_ID.get('classic');
}

export function getThemeColor(seasonId, mode) {
  const meta = getSeasonThemeMeta(seasonId);
  return mode === 'dark' ? meta.themeColorDark : meta.themeColorLight;
}
