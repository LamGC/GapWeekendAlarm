import type { HolidayCnData } from './types';

const CDN_BASE = 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master';
const REGION = 'CN';
const BATCH_SIZE = 50;

export interface SyncResult {
  year: number;
  total: number;
  ok: boolean;
  error?: string;
}

function log(event: string, data?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

export async function syncHolidaysFromCn(db: D1Database, years: number[]): Promise<SyncResult[]> {
  log('holiday_sync_start', { years });
  const results = await Promise.all(years.map((year) => syncYear(db, year)));
  const totalInserted = results.reduce((s, r) => s + r.total, 0);
  const allOk = results.every((r) => r.ok);
  log('holiday_sync_done', { years, totalInserted, ok: allOk, results });
  return results;
}

async function syncYear(db: D1Database, year: number): Promise<SyncResult> {
  log('holiday_sync_fetch', { year, url: `${CDN_BASE}/${year}.json` });

  let data: HolidayCnData;
  try {
    const res = await fetch(`${CDN_BASE}/${year}.json`);
    if (!res.ok) {
      const error = `fetch failed: ${res.status}`;
      log('holiday_sync_fetch_error', { year, error });
      return { year, total: 0, ok: false, error };
    }
    data = (await res.json()) as HolidayCnData;
  } catch (err) {
    const error = String(err);
    log('holiday_sync_fetch_error', { year, error });
    return { year, total: 0, ok: false, error };
  }

  const days = data.days ?? [];
  log('holiday_sync_fetched', { year, days: days.length });

  if (days.length === 0) {
    return { year, total: 0, ok: true };
  }

  for (let i = 0; i < days.length; i += BATCH_SIZE) {
    const batch = days.slice(i, i + BATCH_SIZE);
    const stmts = batch.map((day) => {
      const type = day.isOffDay ? 1 : 2;
      return db
        .prepare(
          `INSERT OR REPLACE INTO holiday_adjustments (id, date, type, region, note)
           VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)`
        )
        .bind(day.date, type, REGION, day.name);
    });
    await db.batch(stmts);
  }

  log('holiday_sync_year_done', { year, total: days.length });
  return { year, total: days.length, ok: true };
}
