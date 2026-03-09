PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  client_id TEXT UNIQUE NOT NULL,
  device_token TEXT UNIQUE NOT NULL,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  timezone TEXT NOT NULL,
  weekend_remind_time TEXT NOT NULL DEFAULT '17:00',
  workday_remind_time TEXT NOT NULL DEFAULT '20:00',
  schedule_rule INTEGER NOT NULL,
  anchor_date TEXT,
  anchor_week_type INTEGER,
  anchor_updated_at TEXT,
  holiday_cycle_policy INTEGER NOT NULL DEFAULT 1,
  weekend_enabled INTEGER NOT NULL DEFAULT 1,
  workday_enabled INTEGER NOT NULL DEFAULT 1,
  registered_at TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  last_push_date_local_by_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_device_token ON subscriptions(device_token);

CREATE TABLE IF NOT EXISTS reminder_extensions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  scope INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_extensions_subscription ON reminder_extensions(subscription_id);
CREATE INDEX IF NOT EXISTS idx_extensions_scope_date ON reminder_extensions(scope, start_date, end_date);

CREATE TABLE IF NOT EXISTS holiday_adjustments (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  type INTEGER NOT NULL,
  region TEXT NOT NULL DEFAULT 'CN',
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, region)
);

CREATE TABLE IF NOT EXISTS holiday_data_sources (
  id TEXT PRIMARY KEY,
  source_code TEXT UNIQUE NOT NULL,
  source_name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT 'CN',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subscription_holiday_sources (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE,
  FOREIGN KEY(source_id) REFERENCES holiday_data_sources(id) ON DELETE CASCADE,
  UNIQUE(subscription_id, source_id)
);

CREATE TABLE IF NOT EXISTS config_share_links (
  id TEXT PRIMARY KEY,
  share_token_hash TEXT UNIQUE NOT NULL,
  source_client_id TEXT NOT NULL,
  snapshot_payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status INTEGER NOT NULL DEFAULT 1,
  max_apply_count INTEGER NOT NULL DEFAULT 1,
  apply_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config_share_apply_logs (
  id TEXT PRIMARY KEY,
  share_link_id TEXT NOT NULL,
  target_client_id TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  result TEXT NOT NULL,
  FOREIGN KEY(share_link_id) REFERENCES config_share_links(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS template_presets (
  id TEXT PRIMARY KEY,
  locale TEXT NOT NULL,
  template_key TEXT NOT NULL,
  title_template TEXT NOT NULL,
  body_template TEXT NOT NULL,
  allowed_placeholders TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(locale, template_key)
);

INSERT OR IGNORE INTO holiday_data_sources (id, source_code, source_name, region, enabled, priority)
VALUES
  ('src_cn_mainland', 'CN_MAINLAND', '中国内地', 'CN', 1, 100),
  ('src_cn_hk', 'CN_HK', '中国香港', 'CN-HK', 1, 90),
  ('src_cn_mo', 'CN_MO', '中国澳门', 'CN-MO', 1, 80),
  ('src_cn_tw', 'CN_TW', '中国台湾', 'CN-TW', 1, 70);
