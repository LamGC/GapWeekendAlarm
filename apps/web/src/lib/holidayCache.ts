import type { HolidaySource, HolidayYear } from './api';

export const HOLIDAY_CACHE_VERSION = 1;
export const MAX_CACHED_YEARS = 12;
const MAX_CACHE_BYTES = 512_000;
const SOURCE_URL = 'https://github.com/NateScarlet/holiday-cn';
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Entry = { calendar: HolidayYear; usedAt: number };
type Snapshot = { version: number; catalog: HolidaySource[] | null; entries: Entry[] };
const cleanCatalog = (items: HolidaySource[]): HolidaySource[] => items.map(({ source_code, source_name, region, enabled, priority }) => ({ source_code, source_name, region, enabled, priority }));
const cleanYear = ({ source_code, region, year, status, synced_at, source_url, days }: HolidayYear): HolidayYear => ({ source_code, region, year, status, synced_at, source_url, days: days.map(({ date, name, isOffDay }) => ({ date, name, isOffDay })) });
const empty = (): Snapshot => ({ version: HOLIDAY_CACHE_VERSION, catalog: null, entries: [] });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function validHolidaySources(value: unknown): value is HolidaySource[] {
  return Array.isArray(value) && value.length <= 100 && value.every((item) => record(item) &&
    typeof item.source_code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(item.source_code) &&
    typeof item.source_name === 'string' && item.source_name.length <= 200 &&
    typeof item.region === 'string' && item.region.length <= 20 &&
    (item.enabled === 0 || item.enabled === 1) && Number.isFinite(item.priority)) &&
    new Set(value.map((item) => item.source_code)).size === value.length;
}

export function validHolidayYear(value: unknown, source: string, year: number): value is HolidayYear {
  if (!record(value) || source !== 'CN_MAINLAND' || value.source_code !== source || value.region !== 'CN' ||
    value.year !== year || !Number.isInteger(year) || year < 1900 || year > 2200 ||
    !['available', 'stale', 'unavailable'].includes(String(value.status)) ||
    !(value.synced_at === null || (typeof value.synced_at === 'string' && Number.isFinite(Date.parse(value.synced_at)))) ||
    !(value.source_url === SOURCE_URL || value.source_url === '') ||
    !Array.isArray(value.days) || value.days.length > 366) return false;
  const dates = new Set<string>();
  return value.days.every((day) => {
    if (!record(day) || typeof day.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
      !day.date.startsWith(`${year}-`) || typeof day.name !== 'string' || day.name.length > 200 ||
      typeof day.isOffDay !== 'boolean' || dates.has(day.date)) return false;
    const parsed = new Date(`${day.date}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day.date) return false;
    dates.add(day.date);
    return true;
  }) && (value.status !== 'unavailable' || value.days.length === 0);
}

export function holidayCacheKey(apiBase: string): string {
  // Include the complete API base, including a possible path prefix, not just its host.
  return `gap-weekend:holidays:v${HOLIDAY_CACHE_VERSION}:${encodeURIComponent(apiBase.replace(/\/$/, ''))}`;
}

export function parseHolidayCache(raw: string | null): Snapshot {
  if (!raw || raw.length > MAX_CACHE_BYTES) return empty();
  try {
    const data: unknown = JSON.parse(raw);
    if (!record(data) || data.version !== HOLIDAY_CACHE_VERSION || !Array.isArray(data.entries)) return empty();
    const entries: Entry[] = [];
    for (const entry of data.entries) {
      if (!record(entry) || !record(entry.calendar) || typeof entry.usedAt !== 'number' || !Number.isFinite(entry.usedAt)) continue;
      const calendar = entry.calendar;
      if (!validHolidayYear(calendar, String(calendar.source_code), Number(calendar.year)) || calendar.status === 'unavailable') continue;
      if (!entries.some((old) => old.calendar.source_code === calendar.source_code && old.calendar.year === calendar.year)) {
        entries.push({ calendar: cleanYear(calendar), usedAt: entry.usedAt });
      }
    }
    return { version: HOLIDAY_CACHE_VERSION, catalog: validHolidaySources(data.catalog) ? cleanCatalog(data.catalog) : null,
      entries: entries.sort((a, b) => b.usedAt - a.usedAt).slice(0, MAX_CACHED_YEARS) };
  } catch { return empty(); }
}

/** Only public holiday responses are stored here. Settings and subscriptions are separate. */
export class HolidayCache {
  private snapshot: Snapshot = empty();
  private readonly key: string;
  warning = false;
  private storage?: StorageLike;
  constructor(apiBase: string, storage?: StorageLike) {
    this.storage = storage;
    this.key = holidayCacheKey(apiBase);
    if (!storage) { this.warning = true; return; }
    try { this.snapshot = parseHolidayCache(storage.getItem(this.key)); }
    catch { this.warning = true; }
  }
  getCatalog() { return this.snapshot.catalog; }
  putCatalog(catalog: HolidaySource[]) {
    if (!validHolidaySources(catalog)) return;
    this.snapshot.catalog = cleanCatalog(catalog);
    this.save();
  }
  getYear(source: string, year: number, now = Date.now()): HolidayYear | undefined {
    const entry = this.snapshot.entries.find((item) => item.calendar.source_code === source && item.calendar.year === year);
    if (!entry) return undefined;
    entry.usedAt = now;
    this.save();
    // On reload no network validation has occurred yet, even if upstream sync was recent.
    return { ...entry.calendar, status: 'stale' };
  }
  putYear(calendar: HolidayYear, now = Date.now()) {
    if (!validHolidayYear(calendar, calendar.source_code, calendar.year) || calendar.status === 'unavailable') return;
    this.snapshot.entries = this.snapshot.entries.filter((item) => item.calendar.source_code !== calendar.source_code || item.calendar.year !== calendar.year);
    this.snapshot.entries.push({ calendar: cleanYear(calendar), usedAt: now });
    this.snapshot.entries.sort((a, b) => b.usedAt - a.usedAt);
    this.snapshot.entries = this.snapshot.entries.slice(0, MAX_CACHED_YEARS);
    this.save();
  }
  private save() {
    if (!this.storage) { this.warning = true; return; }
    // A quota error must never escape into rendering. Retry with fewer old snapshots.
    let entries = this.snapshot.entries;
    for (;;) {
      try {
        const raw = JSON.stringify({ ...this.snapshot, entries });
        if (raw.length > MAX_CACHE_BYTES) throw new Error('cache_too_large');
        this.storage.setItem(this.key, raw);
        this.warning = entries.length < this.snapshot.entries.length;
        return;
      } catch {
        this.warning = true;
        if (entries.length <= 1) return;
        entries = entries.slice(0, -1);
      }
    }
  }
}

export function createHolidayCache(apiBase: string): HolidayCache {
  try { return new HolidayCache(apiBase, window.localStorage); }
  catch { return new HolidayCache(apiBase); }
}
