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
