export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_URL: string;
  CLUB_TIMEZONE: string;
  GCAL_CALENDAR_ID: string;
  GITHUB_REPO: string;
  AI?: Ai;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  GCAL_ICAL_URL?: string;
  GCAL_SERVICE_ACCOUNT_EMAIL?: string;
  GCAL_PRIVATE_KEY?: string;
  GITHUB_TOKEN?: string;
  OPENBOT_WEBHOOK_URL?: string;
  OPENBOT_WEBHOOK_SECRET?: string;
  DEV_DEFAULT_USER?: string;
}

export interface UserRow {
  id: number;
  slug: string;
  name: string;
  email: string;
  avatar_class: string;
  initials: string;
  is_rotation: number;
  rotation_order: number | null;
  notify_night_vote: number;
  notify_place: number;
  notify_reminder: number;
  walkthrough_seen_at: string | null;
  whats_new_seen_id: string | null;
  whats_new_seen_at: string | null;
  is_active?: number;
}

export interface RestaurantRow {
  id: number;
  slug: string;
  name: string;
  address: string;
  city: string;
  lat: number | null;
  lng: number | null;
  google_place_id: string | null;
  visit_count: number;
  last_visited: string | null;
  avg_rating: number | null;
  rating_count?: number;
  photo_count?: number;
  avg_meal_price?: number | null;
  price_stats?: PlacePriceStats | null;
  is_closed?: number;
  closed_at?: string | null;
  closed_reason?: string;
  closed_source_url?: string | null;
  status_locked?: number;
  source?: string;
  source_external_id?: string | null;
  source_url?: string | null;
  cuisine?: string;
  discovered_at?: string | null;
  eb_review_url?: string | null;
  eb_review_date?: string | null;
  eb_review_title?: string;
}

export interface PlaceVisitPrice {
  dinner_id: number;
  dinner_date: string;
  day_of_week: string;
  host_label: string;
  avg_price: number;
  my_price?: number | null;
  entry_count: number;
}

export interface PlacePriceStats {
  avg_price: number | null;
  min_price: number | null;
  max_price: number | null;
  entry_count: number;
  visit_count: number;
  history: PlaceVisitPrice[];
  first_price?: number | null;
  first_date?: string | null;
  latest_price?: number | null;
  latest_date?: string | null;
  price_change?: number | null;
  price_change_pct?: number | null;
}

export type AllowedPhotoMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

export interface MealPhotoViewRow {
  id: number;
  dinner_id: number;
  restaurant_id: number | null;
  user_slug: string;
  user_name: string | null;
  dish: string;
  appetizer?: string;
  caption: string;
  mime_type: AllowedPhotoMime;
  width: number | null;
  height: number | null;
  byte_size: number;
  created_at: string;
  image_url: string;
  dinner_date?: string;
  day_of_week?: string;
  host_label?: string;
  restaurant_name?: string | null;
}

export interface BeerViewRow {
  id: number;
  user_slug: string;
  user_name: string | null;
  name: string;
  brewery: string;
  style: string;
  purchased_where: string;
  rating: number | null;
  notes: string;
  created_at: string;
  updated_at: string;
  has_photo: boolean;
  image_url: string | null;
}

export interface BeerStats {
  total: number;
  avg_rating: number | null;
  breweries: number;
  styles: number;
}

export interface BeerListPayload {
  beers: BeerViewRow[];
  total: number;
  stats: BeerStats;
}

export interface RatingViewRow {
  id: number;
  dinner_id: number;
  restaurant_id: number | null;
  user_slug: string;
  user_name: string | null;
  score: number;
  dish: string;
  appetizer?: string;
  comment: string;
  price?: number | null;
  rated_at: string;
  dinner_date?: string;
  day_of_week?: string;
  host_label?: string;
}

export interface NightVoteViewRow {
  user_slug: string;
  user_name: string | null;
  choice: 'tuesday' | 'wednesday' | 'both';
  reason: string;
  voted_at: string;
}

export type DinnerStatus =
  | 'night_poll'
  | 'awaiting_pick'
  | 'noon_vote'
  | 'place_locked'
  | 'completed'
  | 'scheduled'
  | 'cancelled';

export interface DinnerRow {
  id: number;
  week_key: string;
  dinner_date: string;
  start_time: string;
  day_of_week: string;
  host_slug: string | null;
  host_label: string;
  restaurant_id: number | null;
  raw_location: string;
  raw_summary: string;
  ics_uid: string | null;
  gcal_event_id: string | null;
  status: DinnerStatus;
  chosen_via: string;
  night_poll_opened_at: string | null;
  night_locked_at: string | null;
  noon_draw_opened_at: string | null;
  noon_draw_ids: string | null;
  place_locked_at: string | null;
  reminder_sent_at: string | null;
  pre_event_sent_at: string | null;
  completed_at: string | null;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  cancel_reason?: string;
  cancelled_prev_status?: string | null;
  cancelled_archived_at?: string | null;
  meal_price?: number | null;
  dinner_avg_price?: number | null;
  is_historical: number;
}

export interface HostFavoritePlace {
  restaurant_id: number;
  restaurant_name: string;
  times_picked: number;
  last_picked: string;
}

export interface HostStatRow {
  host_slug: string;
  host_label: string;
  hosted_count: number;
  last_hosted: string | null;
  favorite_place?: HostFavoritePlace | null;
}

export interface SelloutStatRow {
  user_slug: string;
  user_name: string;
  avatar_class: string;
  initials: string;
  is_rotation: number;
  sellout_count: number;
  attended_count: number;
  last_sellout_date: string | null;
  last_sellout_note: string | null;
}

export interface SelloutLogRow {
  dinner_id: number;
  week_key: string;
  dinner_date: string;
  day_of_week: string;
  host_label: string;
  restaurant_name: string | null;
  user_slug: string;
  user_name: string;
  note: string;
  recorded_by: string | null;
  updated_at: string;
}

export interface TrackableDinnerRow {
  id: number;
  week_key: string;
  dinner_date: string;
  day_of_week: string;
  host_slug: string | null;
  host_label: string;
  status: DinnerStatus;
  restaurant_name: string | null;
}

export interface DinnerHeadcount {
  goingMembers: number;
  lateMembers: number;
  outMembers: number;
  extraGuests: number;
  extraGuestNames?: string[];
  totalGoing: number;
  activeCrewCount: number;
  unansweredCount: number;
}

export type LuckyPool = 'any' | 'regulars' | 'comeback' | 'top_rated' | 'untried';

export interface RestaurantSyncUpsertInput {
  name: string;
  address?: string;
  city?: string;
  lat?: number | null;
  lng?: number | null;
  cuisine?: string;
  source?: 'wichitabyeb_dir' | 'wichitabyeb_post' | 'manual' | 'club';
  sourceExternalId?: string | null;
  sourceUrl?: string | null;
  discoveredAt?: string | null;
  ebReviewUrl?: string | null;
  ebReviewDate?: string | null;
  ebReviewTitle?: string;
}

export interface RestaurantSyncReviewUpdateInput {
  restaurantId?: number;
  slug?: string;
  ebReviewUrl: string;
  ebReviewDate?: string | null;
  ebReviewTitle?: string;
}

export interface RestaurantSyncClosingInput {
  restaurantId?: number;
  slug?: string;
  sourceExternalId?: string | null;
  name?: string;
  closedAt?: string | null;
  reason?: string;
  sourceUrl?: string | null;
}

export interface RestaurantSyncFlagInput {
  restaurantId?: number;
  slug?: string;
  sourceExternalId?: string | null;
  wpPostId: number;
  postTitle: string;
  postUrl: string;
  postDate: string;
  confidence?: string;
  reason?: string;
}

export interface RestaurantSyncPayload {
  mode?: 'backfill' | 'weekly' | 'manual' | 'reviews-backfill';
  cursorPostDate?: string | null;
  recordRun?: boolean;
  upserts?: RestaurantSyncUpsertInput[];
  reviews?: RestaurantSyncReviewUpdateInput[];
  closings?: RestaurantSyncClosingInput[];
  flags?: RestaurantSyncFlagInput[];
}

export interface RestaurantSyncRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  mode: string;
  cursor_post_date: string | null;
  added_count: number;
  updated_count: number;
  closed_count: number;
  flagged_count: number;
  summary_json: string;
}

export interface RestaurantClosingFlagRow {
  id: number;
  restaurant_id: number;
  restaurant_name?: string;
  restaurant_slug?: string;
  visit_count?: number;
  wp_post_id: number;
  post_title: string;
  post_url: string;
  post_date: string;
  confidence: string;
  reason: string;
  status: 'pending' | 'confirmed_closed' | 'dismissed';
  resolved_at: string | null;
  created_at: string;
}

export type WhatsNewCreditRole = 'idea' | 'bug_report';

export interface WhatsNewEntry {
  id: string;
  date: string;
  title: string;
  summary: string;
  kind: 'feature' | 'fix';
  creditSlug?: string | null;
  creditName?: string | null;
  creditRole?: WhatsNewCreditRole | null;
  issueNumber?: number | null;
}

export interface WhatsNewViewEntry extends WhatsNewEntry {
  isNew: boolean;
  creditLabel: string | null;
}

export interface WhatsNewPayload {
  latestId: string | null;
  seenId: string | null;
  hasUnseen: boolean;
  unseenCount: number;
  entries: WhatsNewViewEntry[];
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  directionsUrl?: string;
  actions?: Array<{ action: string; title: string }>;
  dinnerId?: number;
}

export interface DinnerCommentViewRow {
  id: number;
  dinner_id: number;
  user_slug: string;
  user_name: string | null;
  body: string;
  mentioned_slugs: string[];
  created_at: string;
}
