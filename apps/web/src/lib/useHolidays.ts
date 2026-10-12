import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, getHolidayYear, listHolidaySources, type HolidayDay, type HolidaySource, type HolidayYear } from './api';
import { createHolidayCache, validHolidaySources, validHolidayYear } from './holidayCache';

// A missing year is not an empty official calendar. Only validated coverage can override a rule.
const SOURCE_URL = 'https://github.com/NateScarlet/holiday-cn';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const MAX_FRESH_AGE_MS = 48 * 60 * 60 * 1000;
const usableSources = (items: HolidaySource[]) => items.filter((item) => item.enabled && item.source_code === 'CN_MAINLAND');

export function useHolidays(source: string, years: number[], nowMs: number) {
  const [cache] = useState(() => createHolidayCache(API_BASE));
  const [sources, setSources] = useState<HolidaySource[] | null>(() => {
    const catalog = cache.getCatalog();
    return catalog === null ? null : usableSources(catalog);
  });
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [coverage, setCoverage] = useState<Record<string, HolidayYear>>(() => {
    const initial: Record<string, HolidayYear> = {};
    for (const year of years) {
      const calendar = cache.getYear(source, year);
      if (calendar) initial[`${source}:${year}`] = calendar;
    }
    return initial;
  });
  const [cacheWarning, setCacheWarning] = useState(cache.warning);
  const [isOffline, setIsOffline] = useState(() => navigator.onLine === false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const lastRefreshRef = useRef(0);
  const offlineRef = useRef(isOffline);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible' || navigator.onLine === false) return;
      // Avoid duplicate visibility/online events causing a burst of requests.
      if (Date.now() - lastRefreshRef.current < 30_000) return;
      lastRefreshRef.current = Date.now();
      setRefreshVersion((previous) => previous + 1);
    };
    const onOnline = () => {
      // A genuine reconnect should retry immediately, even after a recent failed refresh.
      if (offlineRef.current) lastRefreshRef.current = 0;
      offlineRef.current = false;
      setIsOffline(false);
      refresh();
    };
    const onOffline = () => { offlineRef.current = true; setIsOffline(true); };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, []);
  const yearKey = [...new Set(years)].filter((year) => Number.isInteger(year) && year >= 1900 && year <= 2200).sort().join(',');
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    void listHolidaySources(controller.signal).then((items) => {
      if (!validHolidaySources(items)) throw new Error('invalid_sources');
      if (alive) {
        // An authoritative empty/disabled catalog immediately supersedes cached support.
        cache.putCatalog(items);
        setCacheWarning(cache.warning);
        setSources(usableSources(items));
        setCatalogFailed(false);
      }
    }).catch(() => { if (alive) setCatalogFailed(true); }).finally(() => window.clearTimeout(timeout));
    return () => { alive = false; controller.abort(); window.clearTimeout(timeout); };
  }, [cache, refreshVersion]);
  const supported = source === 'CN_MAINLAND' && !!sources?.some((item) => item.source_code === source);
  useEffect(() => {
    if (!supported || !yearKey) return;
    let alive = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    const requestedYears = yearKey.split(',').map(Number);
    const cached: Record<string, HolidayYear> = {};
    for (const year of requestedYears) {
      const calendar = cache.getYear(source, year);
      if (calendar) cached[`${source}:${year}`] = calendar;
    }
    setCoverage((previous) => ({ ...cached, ...previous }));
    setCacheWarning(cache.warning);
    void Promise.all(requestedYears.map(async (year) => {
      const key = `${source}:${year}`;
      const unavailable: HolidayYear = { source_code: source, region: 'CN', year, status: 'unavailable', synced_at: null, source_url: '', days: [] };
      try {
        const result = await getHolidayYear(source, year, controller.signal);
        if (!validHolidayYear(result, source, year)) throw new Error('invalid_calendar');
        if (!alive) return;
        // Never persist negative coverage; a later foreground refresh retries missing years.
        cache.putYear(result);
        setCacheWarning(cache.warning);
        setCoverage((previous) => {
          const old = previous[key];
          const next = result.status === 'unavailable' && old && old.status !== 'unavailable'
            ? { ...old, status: 'stale' as const } : result;
          return { ...previous, [key]: next };
        });
      } catch {
        if (!alive) return;
        setCoverage((previous) => {
          const old = previous[key];
          return { ...previous, [key]: old && old.status !== 'unavailable' ? { ...old, status: 'stale' } : unavailable };
        });
      }
    })).finally(() => window.clearTimeout(timeout));
    return () => { alive = false; controller.abort(); window.clearTimeout(timeout); };
  }, [cache, source, supported, yearKey, refreshVersion]);
  const days = useMemo(() => {
    const result: Record<string, HolidayDay> = {};
    if (!supported) return result;
    const requestedYears = new Set(yearKey.split(',').map(Number));
    for (const calendar of Object.values(coverage)) {
      if (calendar.source_code !== source || calendar.status === 'unavailable' || !requestedYears.has(calendar.year)) continue;
      for (const day of calendar.days) result[day.date] = day;
    }
    return result;
  }, [coverage, source, supported, yearKey]);
  function yearStatus(year: number): string {
    const calendar = coverage[`${source}:${year}`];
    if (!supported || !calendar) return '未覆盖，按排班估算';
    if (calendar.status === 'unavailable') return '数据不可用，按排班估算';
    if (isOffline) return '离线缓存，待联网更新';
    const syncedAt = calendar.synced_at ? Date.parse(calendar.synced_at) : NaN;
    if (catalogFailed || calendar.status === 'stale' || !Number.isFinite(syncedAt) || nowMs - syncedAt > MAX_FRESH_AGE_MS) return '旧数据，待更新';
    return '已覆盖';
  }
  const summary = !source ? '节假日：关闭 · 仅按排班规则'
    : !supported ? (sources === null && !catalogFailed ? '节假日：加载中，暂按排班估算' : '节假日来源不可用，暂按排班估算')
    : `${sources?.find((item) => item.source_code === source)?.source_name || '中国内地'}节假日 · ${yearKey.split(',').map((year) => `${year}年${yearStatus(Number(year))}`).join('；')}`;
  const metadata = yearKey.split(',').filter(Boolean).map((year) => {
    const calendar = coverage[`${source}:${year}`];
    return { year, syncedAt: calendar?.synced_at ?? null, sourceUrl: calendar?.source_url === SOURCE_URL ? SOURCE_URL : null };
  });
  return { metadata, sources: sources ?? [], days, summary, yearStatus, cacheWarning: cacheWarning ? '浏览器缓存空间不足或存储不可用，部分节假日数据仅在本次打开期间保留。' : null, isOffline,
    catalogUnavailable: catalogFailed || (sources !== null && sources.length === 0) };
}
