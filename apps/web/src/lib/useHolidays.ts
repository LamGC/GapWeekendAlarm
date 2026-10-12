import { useEffect, useMemo, useRef, useState } from 'react';
import { getHolidayYear, listHolidaySources, type HolidayDay, type HolidaySource, type HolidayYear } from './api';

// A missing year is not an empty official calendar. Only validated coverage can override a rule.
const SOURCE_URL = 'https://github.com/NateScarlet/holiday-cn';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const MAX_FRESH_AGE_MS = 48 * 60 * 60 * 1000;

export function useHolidays(source: string, years: number[], nowMs: number) {
  const [sources, setSources] = useState<HolidaySource[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [coverage, setCoverage] = useState<Record<string, HolidayYear>>({});
  const [refreshVersion, setRefreshVersion] = useState(0);
  const lastRefreshRef = useRef(nowMs);
  useEffect(() => {
    const refresh = () => {
      // Avoid duplicate visibility/online events causing a burst of requests.
      if (Date.now() - lastRefreshRef.current < 30_000) return;
      lastRefreshRef.current = Date.now();
      setRefreshVersion((previous) => previous + 1);
    };
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const yearKey = [...new Set(years)].sort().join(',');
  useEffect(() => {
    let alive = true;
    void listHolidaySources().then((items) => {
      if (!Array.isArray(items)) throw new Error('invalid_sources');
      if (alive) {
        setSources(items.filter((item) => item.enabled && item.source_code === 'CN_MAINLAND'));
        setCatalogFailed(false);
      }
    }).catch(() => { if (alive) setCatalogFailed(true); });
    return () => { alive = false; };
  }, [refreshVersion]);
  const supported = source === 'CN_MAINLAND' && !!sources?.some((item) => item.source_code === source);
  useEffect(() => {
    if (!supported) return;
    let alive = true;
    for (const year of yearKey.split(',').map(Number)) {
      void getHolidayYear(source, year).then((result) => {
        if (result.source_code !== source || result.year !== year || !Array.isArray(result.days) ||
          !['available', 'stale', 'unavailable'].includes(result.status)) throw new Error('invalid_calendar');
        if (alive) setCoverage((previous) => {
          const old = previous[`${source}:${year}`];
          const next = result.status === 'unavailable' && old && old.status !== 'unavailable'
            ? { ...old, status: 'stale' as const } : result;
          return { ...previous, [`${source}:${year}`]: next };
        });
      }).catch(() => {
        if (!alive) return;
        setCoverage((previous) => {
          const old = previous[`${source}:${year}`];
          return { ...previous, [`${source}:${year}`]: old && old.status !== 'unavailable'
            ? { ...old, status: 'stale' }
            : { source_code: source, region: 'CN', year, status: 'unavailable', synced_at: null, source_url: '', days: [] } };
        });
      });
    }
    return () => { alive = false; };
  }, [source, supported, yearKey, refreshVersion]);
  const days = useMemo(() => {
    const result: Record<string, HolidayDay> = {};
    if (!supported) return result;
    for (const calendar of Object.values(coverage)) {
      if (calendar.source_code !== source || calendar.status === 'unavailable') continue;
      for (const day of calendar.days) {
        if (day.date.startsWith(`${calendar.year}-`) && typeof day.isOffDay === 'boolean') result[day.date] = day;
      }
    }
    return result;
  }, [coverage, source, supported]);
  function yearStatus(year: number): string {
    const calendar = coverage[`${source}:${year}`];
    if (!supported || !calendar) return '未覆盖，按排班估算';
    if (calendar.status === 'unavailable') return '数据不可用，按排班估算';
    const syncedAt = calendar.synced_at ? Date.parse(calendar.synced_at) : NaN;
    if (calendar.status === 'stale' || !Number.isFinite(syncedAt) || nowMs - syncedAt > MAX_FRESH_AGE_MS) return '旧数据，待更新';
    return '已覆盖';
  }
  const summary = !source ? '节假日：关闭 · 仅按排班规则'
    : !supported ? (sources === null && !catalogFailed ? '节假日：加载中，暂按排班估算' : '节假日来源不可用，暂按排班估算')
    : `${sources?.find((item) => item.source_code === source)?.source_name || '中国内地'}节假日 · ${yearKey.split(',').map((year) => `${year}年${yearStatus(Number(year))}`).join('；')}`;
  const metadata = yearKey.split(',').map((year) => {
    const calendar = coverage[`${source}:${year}`];
    return { year, syncedAt: calendar?.synced_at ?? null, sourceUrl: calendar?.source_url === SOURCE_URL ? SOURCE_URL : null };
  });
  return { metadata, sources: sources ?? [], days, summary, yearStatus, catalogUnavailable: catalogFailed || (sources !== null && sources.length === 0) };
}
