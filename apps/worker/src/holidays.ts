import type { HolidayCnData, HolidayCnDay } from './types';

export const HOLIDAY_SOURCE = {
  code: 'CN_MAINLAND',
  region: 'CN',
  url: 'https://github.com/NateScarlet/holiday-cn',
  dataUrl: 'https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master',
} as const;
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

export interface HolidaySnapshot {
  year: number;
  payload: string | null;
  synced_at: string | null;
  attempted_at: string;
  last_error: string | null;
}

export interface HolidayCalendar {
  source_code: string;
  region: string;
  year: number;
  status: 'available' | 'stale' | 'unavailable';
  synced_at: string | null;
  source_url: string;
  days: HolidayCnDay[];
}

export function isValidDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

/** holiday-cn has empty future-year placeholders; HTTP 200 is not coverage. */
export function parseHolidayDocument(value: unknown, year: number): HolidayCnData {
  if (!value || typeof value !== 'object') throw new Error('invalid_document');
  const data = value as Record<string, unknown>;
  if (data.year !== year || !Array.isArray(data.papers) || !Array.isArray(data.days)) {
    throw new Error('invalid_document');
  }
  if (!data.papers.length || !data.days.length) throw new Error('unpublished_year');
  if (!data.papers.every((paper) => typeof paper === 'string' && /^https?:\/\//.test(paper))) {
    throw new Error('invalid_papers');
  }
  if (data.days.length > 400) throw new Error('invalid_days');
  const dates = new Set<string>();
  const days: HolidayCnDay[] = data.days.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('invalid_day');
    const day = value as Record<string, unknown>;
    if (!isValidDate(day.date) || typeof day.name !== 'string' || !day.name.trim() ||
        day.name.length > 100 || typeof day.isOffDay !== 'boolean') throw new Error('invalid_day');
    // New Year's arrangements can include the previous December.
    const dateYear = Number(day.date.slice(0, 4));
    if (dateYear < year - 1 || dateYear > year + 1 || dates.has(day.date)) throw new Error('invalid_day');
    dates.add(day.date);
    return { date: day.date, name: day.name, isOffDay: day.isOffDay };
  });
  return { year, papers: data.papers as string[], days };
}

export function calendarFromSnapshots(year: number, rows: HolidaySnapshot[], now = Date.now()): HolidayCalendar {
  const own = rows.find((row) => row.year === year);
  const valid = new Map<number, HolidayCnData>();
  for (const row of rows) {
    if (!row.payload || !row.synced_at) continue;
    try { valid.set(row.year, parseHolidayDocument(JSON.parse(row.payload), row.year)); } catch { /* invalid persisted data is never coverage */ }
  }
  const hasCoverage = valid.has(year);
  const days = new Map<string, HolidayCnDay>();
  const owners = new Map<string, number>();
  // Later document years take precedence for cross-year arrangements.
  for (const [, document] of [...valid].sort(([a], [b]) => a - b)) {
    for (const day of document.days) {
      if (Number(day.date.slice(0, 4)) === year) {
        days.set(day.date, day);
        owners.set(day.date, document.year);
      }
    }
  }
  const contributingYears = new Set([year, ...owners.values()]);
  const stale = rows.some((row) => valid.has(row.year) && contributingYears.has(row.year) && (
    row.last_error || !Number.isFinite(Date.parse(row.synced_at!)) || now - Date.parse(row.synced_at!) > STALE_AFTER_MS
  ));
  return {
    source_code: HOLIDAY_SOURCE.code, region: HOLIDAY_SOURCE.region, year,
    status: !hasCoverage ? 'unavailable' : stale ? 'stale' : 'available',
    synced_at: hasCoverage ? own!.synced_at : null,
    source_url: HOLIDAY_SOURCE.url,
    // Without the year's published schedule, do not imply a complete calendar.
    days: hasCoverage ? [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) : [],
  };
}

export async function readHolidayCalendar(db: D1Database, year: number): Promise<HolidayCalendar> {
  const rows = await db.prepare(
    `SELECT year, payload, synced_at, attempted_at, last_error FROM holiday_year_snapshots
     WHERE source_code = ? AND year BETWEEN ? AND ?`
  ).bind(HOLIDAY_SOURCE.code, year - 1, year + 1).all<HolidaySnapshot>();
  return calendarFromSnapshots(year, rows.results ?? []);
}

export function holidayOverride(calendar: HolidayCalendar, date: string): HolidayCnDay | undefined {
  return calendar.status === 'unavailable' ? undefined : calendar.days.find((day) => day.date === date);
}
