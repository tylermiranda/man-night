PRAGMA foreign_keys = ON;

/* --- Track admin dashboard logins --- */
CREATE TABLE IF NOT EXISTS admin_logins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slug TEXT NOT NULL,
  email TEXT NOT NULL,
  login_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT,
  user_agent TEXT,
  UNIQUE(user_slug, login_at)
);

/* --- Track notification sends --- */
CREATE TABLE IF NOT EXISTS notification_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slug TEXT NOT NULL,
  notification_type TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivery_endpoint TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  UNIQUE(user_slug, notification_type, sent_at)
);

/* --- Track feature usage / API calls --- */
CREATE TABLE IF NOT EXISTS feature_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_slug TEXT NOT NULL,
  feature_name TEXT NOT NULL,
  called_at TEXT NOT NULL DEFAULT (datetime('now')),
  endpoint_path TEXT,
  request_method TEXT,
  UNIQUE(user_slug, feature_name, called_at)
);

CREATE INDEX IF NOT EXISTS idx_admin_logins_user ON admin_logins(user_slug, login_at DESC);
CREATE INDEX IF NOT EXISTS idx_notification_logs_user ON notification_logs(user_slug, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_feature_usage_user ON feature_usage(user_slug, called_at DESC);