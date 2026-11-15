export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_URL: string;
  CLUB_TIMEZONE: string;
  GCAL_CALENDAR_ID: string;
  GITHUB_REPO: string;
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
}

export interface RatingViewRow {
  id: number;
  dinner_id: number;
  restaurant_id: number | null;
  user_slug: string;
  user_name: string | null;
  score: number;
  dish: string;
  comment: string;
  rated_at: string;
  dinner_date?: string;
  day_of_week?: string;
  host_label?: string;
}

export interface NightVoteViewRow {
  user_slug: string;
  user_name: string | null;
  choice: 'tuesday' | 'wednesday';
  reason: string;
  voted_at: string;
}

export type DinnerStatus =
  | 'night_poll'
  | 'awaiting_pick'
  | 'noon_vote'
  | 'place_locked'
  | 'completed'
  | 'scheduled';

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
  completed_at: string | null;
  is_historical: number;
}

export interface PushPayload {
  title: string;
  body: string;
  tag?: string;
  url?: string;
  actions?: Array<{ action: string; title: string }>;
  dinnerId?: number;
}
