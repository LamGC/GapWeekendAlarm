-- Only mainland China has an implemented provider. Keep future source identities
-- for backwards compatibility, but never advertise calendars without data.
UPDATE holiday_data_sources SET enabled = 0 WHERE source_code IN ('CN_HK', 'CN_MO', 'CN_TW');

-- A document-year snapshot is atomic, including corrections and cross-year days.
-- Legacy holiday_adjustments have no provenance/coverage and are not promoted.
CREATE TABLE IF NOT EXISTS holiday_year_snapshots (
  source_code TEXT NOT NULL,
  year INTEGER NOT NULL,
  payload TEXT,
  synced_at TEXT,
  attempted_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY (source_code, year),
  FOREIGN KEY(source_code) REFERENCES holiday_data_sources(source_code)
);
