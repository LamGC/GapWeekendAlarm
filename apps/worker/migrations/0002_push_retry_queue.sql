CREATE TABLE IF NOT EXISTS push_retry_queue (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  type INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at TEXT NOT NULL,
  last_error TEXT,
  last_error_kind TEXT,
  status INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(subscription_id) REFERENCES subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_push_retry_queue_due
  ON push_retry_queue(status, next_retry_at);
