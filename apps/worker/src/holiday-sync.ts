import { HOLIDAY_SOURCE, parseHolidayDocument } from './holidays';

export interface SyncResult {
  year: number;
  total: number;
  ok: boolean;
  error?: string;
}

export async function syncHolidaysFromCn(db: D1Database, years: number[]): Promise<SyncResult[]> {
  return Promise.all([...new Set(years)].map((year) => syncYear(db, year)));
}

export async function syncYear(db: D1Database, year: number): Promise<SyncResult> {
  const attemptedAt = new Date().toISOString();
  try {
    const response = await fetch(`${HOLIDAY_SOURCE.dataUrl}/${year}.json`, {
      signal: AbortSignal.timeout(10_000),
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`upstream_http_${response.status}`);
    const text = await response.text();
    if (text.length > 200_000) throw new Error('document_too_large');
    const data = parseHolidayDocument(JSON.parse(text), year);
    // One atomic UPSERT replaces the entire year, removing corrected/deleted days.
    await db.prepare(
      `INSERT INTO holiday_year_snapshots (source_code, year, payload, synced_at, attempted_at, last_error)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(source_code, year) DO UPDATE SET payload = excluded.payload,
         synced_at = excluded.synced_at, attempted_at = excluded.attempted_at, last_error = NULL`
    ).bind(HOLIDAY_SOURCE.code, year, JSON.stringify(data), attemptedAt, attemptedAt).run();
    return { year, total: data.days.length, ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'sync_failed';
    // Never replace last-good data on network, schema, or unpublished-year failure.
    await db.prepare(
      `INSERT INTO holiday_year_snapshots (source_code, year, attempted_at, last_error)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source_code, year) DO UPDATE SET attempted_at = excluded.attempted_at,
         last_error = excluded.last_error`
    ).bind(HOLIDAY_SOURCE.code, year, attemptedAt, error).run();
    console.warn(JSON.stringify({ event: 'holiday_sync_failed', year, error }));
    return { year, total: 0, ok: false, error };
  }
}
