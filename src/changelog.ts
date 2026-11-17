import type { WhatsNewEntry, WhatsNewPayload, WhatsNewViewEntry } from './types';

/**
 * Club release changelog (newest first).
 *
 * Maintenance rule: Whenever a new user-facing feature or fix is shipped,
 * prepend a new WhatsNewEntry at the top of WHATS_NEW_RELEASES. When it was
 * submitted by a crew member (idea or bug report), set creditSlug, creditName,
 * creditRole ('idea' | 'bug_report'), and issueNumber; leave those null/undefined
 * for non-crew-submitted updates.
 */
export const WHATS_NEW_RELEASES: readonly WhatsNewEntry[] = [
  {
    id: '2026-11-17-both-night-voting',
    date: '2026-11-17',
    kind: 'feature',
    title: '🤝 Either Day (Can Do Both) Night Poll Voting',
    summary:
      'Crew members can now vote "Either day (can do both)" in the Tuesday vs Wednesday night poll. Selecting either day adds +1 to both Tuesday and Wednesday availability counts while maintaining Tuesday tie-breaker priority.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
  },
  {
    id: '2026-11-16-top-places-poplar-fix',
    date: '2026-11-16',
    kind: 'fix',
    title: '🏆 Poplar Restored to #1 Top Place',
    summary:
      'Fixed a calendar seed parsing bug where historical visits containing generic "dinner" keywords were mistakenly assigned to Pour Haus. Poplar is now accurately crowned as the #1 all-time venue with 29 visits!',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'bug_report',
  },
  {
    id: '2026-11-15-future-pick-notifications',
    date: '2026-11-15',
    kind: 'fix',
    title: '📅 Clearer Future Night Notifications',
    summary:
      'Push notifications for spots picked or polled in advance now explicitly specify the future date and day, eliminating confusion with current-week dinner voting.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'bug_report',
    issueNumber: 18,
  },
  {
    id: '2026-11-15-appetizers',
    date: '2026-11-15',
    kind: 'feature',
    title: '🥟 Appetizer Tracking',
    summary:
      'Keep track of appetizers alongside standout dishes across dinners, reviews, and meal photos—with dedicated appetizer fields, review badges, and restaurant favorite app callouts.',
    creditSlug: 'jacob',
    creditName: 'Jacob',
    creditRole: 'idea',
    issueNumber: 17,
  },
  {
    id: '2026-11-15-beer-cellar',
    date: '2026-11-15',
    kind: 'feature',
    title: '🍺 Beer Cellar & Crew Search',
    summary:
      'Log every beer you buy—name, brewery, style, where you got it, a 1–5 rating, tasting notes, and a photo—then search the whole crew’s cellar by beer, brewery, store, or member.',
    creditSlug: 'jacob',
    creditName: 'Jacob',
    creditRole: 'idea',
    issueNumber: 15,
  },
  {
    id: '2026-11-15-issue-feature-form',
    date: '2026-11-15',
    kind: 'fix',
    title: '📝 Faster Issue & Feature Reports',
    summary:
      'The report button now reads Issue / Feature, accepts a pasted or attached screenshot, hides the form after you submit, and the Places map frames every pin on load.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 16,
  },
  {
    id: '2026-11-15-favorite-places',
    date: '2026-11-15',
    kind: 'feature',
    title: '👑 Crew Favorite Places',
    summary:
      'Check the Crew page to see each host’s all-time favorite restaurant based on how often they picked it when hosting, complete with quick links to view place details.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 14,
  },
  {
    id: '2026-11-15-meal-prices',
    date: '2026-11-15',
    kind: 'feature',
    title: '💵 Meal Price & Inflation Tracking',
    summary:
      'Log what your meal cost when rating any dinner to track how restaurant prices increase across visits over the years—with price history badges, average dinner costs, and place inflation stats.',
    creditSlug: 'jacob',
    creditName: 'Jacob',
    creditRole: 'idea',
    issueNumber: 13,
  },
  {
    id: '2026-11-15-meal-pictures',
    date: '2026-11-15',
    kind: 'feature',
    title: '📷 Meal Pictures & Photo Galleries',
    summary:
      'Snap or upload pictures of what you ordered right from This Week, Last Dinner, Places, or History—with dish captions, full-screen photo galleries, and restaurant photo feeds.',
    creditSlug: 'jacob',
    creditName: 'Jacob',
    creditRole: 'idea',
    issueNumber: 12,
  },
  {
    id: '2026-11-15-whats-new',
    date: '2026-11-15',
    kind: 'feature',
    title: 'What’s New & Crew Credits',
    summary:
      'Automatically pops up when new features or fixes ship—and shouts out which member of the crew pitched the idea or reported the bug. Reopen anytime from the header or account menu.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 11,
  },
  {
    id: '2026-11-15-feeling-lucky',
    date: '2026-11-15',
    kind: 'feature',
    title: '🎲 I’m Feeling Lucky Picker & Random Polls',
    summary:
      'Can’t decide where to go? Roll a single random spot or draw 3–6 places for a poll filtered by All Spots, Regulars (5+), Comeback Due, or Top Rated—skipping anything visited in the last 8 weeks.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 10,
  },
  {
    id: '2026-11-15-extra-guests',
    date: '2026-11-15',
    kind: 'feature',
    title: 'Extra People (+1s) & 5-Minute Headcount Alert',
    summary:
      'Add optional extra guests right on your RSVP. The 30-minute reminder nudges everyone to log any +1s, followed by a 5-minute pre-dinner push alert with the total headcount.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 9,
  },
  {
    id: '2026-11-15-places-pagination',
    date: '2026-11-15',
    kind: 'fix',
    title: 'Paginated Places Directory & Cleaner Crew Tab',
    summary:
      'Paginated the 225-restaurant directory (15 per page) for faster browsing and removed duplicate issue and notification cards from the Crew tab.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'bug_report',
    issueNumber: 8,
  },
  {
    id: '2026-11-15-crowns',
    date: '2026-11-15',
    kind: 'feature',
    title: '👑 King of Hosting & Sellout Crown of Shame',
    summary:
      'Added Crew tab royalty cards crowning the all-time hosting leader alongside forward-tracked sellout stats (with optional excuses) for whoever misses the most weeks.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 7,
  },
  {
    id: '2026-11-15-night-vote-reasons',
    date: '2026-11-15',
    kind: 'feature',
    title: 'Tuesday / Wednesday Vote Reasons',
    summary:
      'Add an optional note explaining why you voted Tuesday or Wednesday so the rest of the crew can see schedule constraints.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 6,
  },
  {
    id: '2026-11-15-future-trophy-fix',
    date: '2026-11-15',
    kind: 'fix',
    title: 'Future Scheduled Spots Excluded from Trophy Case',
    summary:
      'Prevented upcoming scheduled dinners (like Deano’s) from showing up as the most recent stop before dinner night happens.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'bug_report',
    issueNumber: 5,
  },
  {
    id: '2026-11-15-early-pick-poll',
    date: '2026-11-15',
    kind: 'feature',
    title: 'Early Host Pick & Simultaneous Place Polls',
    summary:
      'Hosts can lock a restaurant or launch a multi-place poll ahead of Monday noon while keeping the Tuesday/Wednesday night vote open alongside it.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 4,
  },
  {
    id: '2026-11-14-place-reviews',
    date: '2026-11-14',
    kind: 'fix',
    title: 'Crew Dinner & Restaurant Reviews',
    summary:
      'Surfaced star ratings, standout dishes, and crew review notes across Last Dinner, Places details, and History.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'bug_report',
    issueNumber: 3,
  },
  {
    id: '2026-11-14-last-dinner-box',
    date: '2026-11-14',
    kind: 'feature',
    title: 'Last Dinner Memory Refresher',
    summary:
      'Displays last week’s restaurant name, address, host, and prior stops right above the rating prompt.',
    creditSlug: 'tyler',
    creditName: 'Tyler',
    creditRole: 'idea',
    issueNumber: 2,
  },
];

export function formatCrewCreditLabel(
  entry: Pick<WhatsNewEntry, 'kind' | 'creditName' | 'creditRole'>,
): string | null {
  if (!entry.creditName) return null;
  const role = entry.creditRole ?? (entry.kind === 'fix' ? 'bug_report' : 'idea');
  return role === 'bug_report' ? `Bug report by ${entry.creditName}` : `Idea by ${entry.creditName}`;
}

export function isValidWhatsNewId(
  id: string,
  entries: readonly WhatsNewEntry[] = WHATS_NEW_RELEASES,
): boolean {
  return entries.some((e) => e.id === id);
}

export function buildWhatsNewPayload(
  seenId: string | null | undefined,
  users: Array<{ slug: string; name: string }> = [],
  entries: readonly WhatsNewEntry[] = WHATS_NEW_RELEASES,
): WhatsNewPayload {
  const latestId = entries[0]?.id ?? null;
  const cleanSeen = seenId ? seenId.trim() : null;
  const seenIdx = cleanSeen ? entries.findIndex((e) => e.id === cleanSeen) : -1;
  const unseenCount = !latestId ? 0 : seenIdx === -1 ? entries.length : seenIdx;
  const hasUnseen = unseenCount > 0;

  const viewEntries: WhatsNewViewEntry[] = entries.map((e, idx) => {
    const matched = e.creditSlug ? users.find((u) => u.slug === e.creditSlug) : undefined;
    const resolvedName = matched?.name || e.creditName || null;
    const resolvedRole = resolvedName
      ? (e.creditRole ?? (e.kind === 'fix' ? 'bug_report' : 'idea'))
      : null;
    const creditLabel = formatCrewCreditLabel({
      kind: e.kind,
      creditName: resolvedName,
      creditRole: resolvedRole,
    });
    const isNew = seenIdx === -1 ? true : idx < seenIdx;
    return {
      ...e,
      creditName: resolvedName,
      creditRole: resolvedRole,
      isNew,
      creditLabel,
    };
  });

  return {
    latestId,
    seenId: cleanSeen || null,
    hasUnseen,
    unseenCount,
    entries: viewEntries,
  };
}
