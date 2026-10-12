import { test, expect } from '@playwright/test';
import { HolidayCache, holidayCacheKey, parseHolidayCache, validHolidayYear, validHolidaySources, MAX_CACHED_YEARS } from '../../apps/web/src/lib/holidayCache';
import type { HolidayYear } from '../../apps/web/src/lib/api';

const catalog = [{ source_code: 'CN_MAINLAND', source_name: '中国内地', region: 'CN', enabled: 1, priority: 1 }];
const calendar = (year = 2026): HolidayYear => ({ source_code: 'CN_MAINLAND', region: 'CN', year, status: 'available', synced_at: '2026-10-12T00:00:00Z', source_url: 'https://github.com/NateScarlet/holiday-cn', days: [{ date: `${year}-10-01`, name: '国庆节', isOffDay: true }, { date: `${year}-10-10`, name: '国庆节', isOffDay: false }] });
function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

test('persisted catalog and official rest/makeup days survive reload as stale coverage', () => {
  const store = storage();
  const first = new HolidayCache('https://api.example/v1', store);
  first.putCatalog(catalog);
  first.putYear(calendar());
  const reload = new HolidayCache('https://api.example/v1', store);
  expect(reload.getCatalog()).toEqual(catalog);
  expect(reload.getYear('CN_MAINLAND', 2026)).toEqual({ ...calendar(), status: 'stale' });
  expect(reload.getYear('CN_MAINLAND', 2027)).toBeUndefined();
});

test('cache is API-base and schema isolated; empty and disabled live catalogs supersede old support', () => {
  const store = storage();
  const cache = new HolidayCache('https://a.example/api', store);
  cache.putCatalog(catalog);
  cache.putYear(calendar());
  expect(new HolidayCache('https://b.example/api', store).getCatalog()).toBeNull();
  expect(new HolidayCache('https://a.example/other', store).getYear('CN_MAINLAND', 2026)).toBeUndefined();
  cache.putCatalog([]);
  expect(new HolidayCache('https://a.example/api', store).getCatalog()).toEqual([]);
  cache.putCatalog([{ ...catalog[0], enabled: 0 }]);
  expect(new HolidayCache('https://a.example/api', store).getCatalog()?.[0].enabled).toBe(0);
  expect(parseHolidayCache(JSON.stringify({ version: 999, catalog, entries: [] })).catalog).toBeNull();
});

test('unavailable or malformed responses do not replace last-good snapshots or create negative caches', () => {
  const store = storage();
  const cache = new HolidayCache('https://api.example', store);
  cache.putYear(calendar());
  cache.putYear({ ...calendar(), status: 'unavailable', days: [] });
  cache.putYear({ ...calendar(2027), status: 'unavailable', days: [] });
  cache.putYear({ ...calendar(), days: [{ date: '2026-02-30', name: '', isOffDay: true }] });
  expect(cache.getYear('CN_MAINLAND', 2026)?.days).toEqual(calendar().days);
  expect(cache.getYear('CN_MAINLAND', 2027)).toBeUndefined();
  expect(new HolidayCache('https://api.example', store).getYear('CN_MAINLAND', 2026)?.days).toEqual(calendar().days);
});

test('invalid JSON, schema, dates, duplicates, statuses and source identities fail closed', () => {
  for (const raw of ['{', 'null', '[]', 'x'.repeat(512_001)]) expect(parseHolidayCache(raw).entries).toEqual([]);
  for (const change of [
    { region: 'other' }, { source_code: 'other' }, { status: 'unknown' }, { synced_at: 'bad' }, { source_url: 'https://evil.example' },
    { days: [calendar().days[0], calendar().days[0]] },
    { days: [{ ...calendar().days[0], isOffDay: 'false' }] },
    { days: [{ ...calendar().days[0], date: '2025-10-01' }] },
    { days: [{ ...calendar().days[0], date: '2026-13-01' }] },
  ]) expect(validHolidayYear({ ...calendar(), ...change }, 'CN_MAINLAND', 2026)).toBe(false);
  expect(validHolidaySources([{ ...catalog[0], enabled: 'true' }])).toBe(false);
  expect(validHolidaySources([catalog[0], catalog[0]])).toBe(false);
  expect(validHolidaySources([])).toBe(true);
  expect(validHolidayYear({ ...calendar(), source_url: '' }, 'CN_MAINLAND', 2026)).toBe(true);
});

test('least recently used years are bounded, while reads retain an older useful year', () => {
  const store = storage();
  const cache = new HolidayCache('https://api.example', store);
  for (let offset = 0; offset < MAX_CACHED_YEARS; offset++) cache.putYear(calendar(2000 + offset), offset);
  cache.getYear('CN_MAINLAND', 2000, 100);
  cache.putYear(calendar(2026), 101);
  const reload = new HolidayCache('https://api.example', store);
  expect(reload.getYear('CN_MAINLAND', 2000)).toBeDefined();
  expect(reload.getYear('CN_MAINLAND', 2001)).toBeUndefined();
  expect(parseHolidayCache(store.getItem(holidayCacheKey('https://api.example'))).entries).toHaveLength(MAX_CACHED_YEARS);
});

test('quota or security errors preserve in-memory data without throwing and report persistence warning', () => {
  const blocked = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); } };
  const cache = new HolidayCache('https://api.example', blocked);
  expect(cache.warning).toBe(true);
  expect(() => { cache.putCatalog(catalog); cache.putYear(calendar()); }).not.toThrow();
  expect(cache.getYear('CN_MAINLAND', 2026)?.days).toEqual(calendar().days);
  expect(cache.warning).toBe(true);
  expect(new HolidayCache('https://api.example').warning).toBe(true);
});

test('quota retries evict oldest snapshots and only persist public projected fields', () => {
  const store = storage();
  const limited = { getItem: store.getItem, setItem(key: string, raw: string) {
    if (JSON.parse(raw).entries.length > 1) throw new Error('quota');
    store.setItem(key, raw);
  } };
  const cache = new HolidayCache('https://api.example', limited);
  cache.putCatalog([{ ...catalog[0], secret: 'do-not-store' }] as typeof catalog);
  cache.putYear({ ...calendar(2025), token: 'do-not-store' } as HolidayYear, 1);
  cache.putYear(calendar(2026), 2);
  const raw = store.getItem(holidayCacheKey('https://api.example'))!;
  expect(raw).not.toContain('do-not-store');
  expect(parseHolidayCache(raw).entries.map((entry) => entry.calendar.year)).toEqual([2026]);
  expect(cache.warning).toBe(true);
});
