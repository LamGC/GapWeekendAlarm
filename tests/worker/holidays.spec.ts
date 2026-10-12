import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker, { determineTypeForEveningReminder, shouldSendWorkdayReminder, initializeHolidaySnapshots } from '../../apps/worker/src/index';
import { calendarFromSnapshots, parseHolidayDocument, holidayOverride } from '../../apps/worker/src/holidays';
import { syncYear } from '../../apps/worker/src/holiday-sync';
import { createSubscriptionSchema, updateSubscriptionSchema } from '../../apps/worker/src/validation';

const document = {
  year: 2026,
  papers: ['https://www.gov.cn/holiday-notice'],
  days: [
    { date: '2026-10-01', name: '国庆节', isOffDay: true },
    { date: '2026-10-10', name: '国庆节', isOffDay: false },
  ],
};
const snapshot = (year: number, data: unknown, overrides = {}) => ({
  year, payload: JSON.stringify(data), synced_at: '2026-10-12T00:00:00.000Z',
  attempted_at: '2026-10-12T00:00:00.000Z', last_error: null, ...overrides,
});
const now = Date.parse('2026-10-12T02:00:00Z');

test('upstream parser rejects unpublished, invalid, duplicate, and wrong-year documents', () => {
  expect(parseHolidayDocument(document, 2026)).toEqual(document);
  expect(() => parseHolidayDocument({ year: 2027, papers: [], days: [] }, 2027)).toThrow('unpublished_year');
  expect(() => parseHolidayDocument(document, 2027)).toThrow('invalid_document');
  for (const date of ['2026-02-30', '2026-13-01', '2024-10-01']) {
    expect(() => parseHolidayDocument({ ...document, days: [{ ...document.days[0], date }] }, 2026)).toThrow();
  }
  expect(() => parseHolidayDocument({ ...document, days: [{ ...document.days[0], isOffDay: 'false' }] }, 2026)).toThrow();
  expect(() => parseHolidayDocument({ ...document, days: [document.days[0], document.days[0]] }, 2026)).toThrow();
});

test('calendar combines next document December overrides without treating missing dates as work', () => {
  const next = { year: 2027, papers: document.papers, days: [{ date: '2026-12-31', name: '元旦', isOffDay: true }] };
  const calendar = calendarFromSnapshots(2026, [snapshot(2026, document), snapshot(2027, next)], now);
  expect(calendar.status).toBe('available');
  const unrelated = { ...document, year: 2025, days: [{ ...document.days[0], date: '2025-10-01' }] };
  expect(calendarFromSnapshots(2026, [snapshot(2026, document), snapshot(2025, unrelated, { last_error: 'failed' })], now).status).toBe('available');
  expect(holidayOverride(calendar, '2026-12-31')?.isOffDay).toBe(true);
  expect(holidayOverride(calendar, '2026-10-10')?.isOffDay).toBe(false);
  expect(holidayOverride(calendar, '2026-10-12')).toBeUndefined();
  const unknown = calendarFromSnapshots(2027, [snapshot(2026, document)], now);
  expect(unknown.status).toBe('unavailable');
  expect(unknown.days).toEqual([]);
});

test('stale data is retained and malformed stored snapshots cannot imply coverage', () => {
  for (const change of [{ last_error: 'upstream_http_503' }, { synced_at: '2026-10-01T00:00:00Z' }]) {
    const calendar = calendarFromSnapshots(2026, [snapshot(2026, document, change)], now);
    expect(calendar.status).toBe('stale');
    expect(calendar.days).toHaveLength(2);
  }
  expect(calendarFromSnapshots(2026, [snapshot(2026, {})], now).status).toBe('unavailable');
});

test('atomic sync preserves last-good snapshot on timeout/HTTP/schema/unpublished failure', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) { return { bind(...values: unknown[]) {
    return { async run() { calls.push({ sql, values }); return { success: true }; } };
  } }; } };
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(document));
    expect((await syncYear(db as never, 2026)).ok).toBe(true);
    expect(calls[0].sql).toContain('payload = excluded.payload');
    expect(JSON.parse(calls[0].values[2] as string)).toEqual(document);
    for (const response of [
      new Response('', { status: 503 }),
      new Response(JSON.stringify({ year: 2026, papers: [], days: [] })),
      new Response(JSON.stringify({ ...document, days: [{ ...document.days[0], isOffDay: 1 }] })),
    ]) {
      globalThis.fetch = async () => response;
      expect((await syncYear(db as never, 2026)).ok).toBe(false);
      expect(calls.at(-1)!.sql).not.toContain('payload =');
      expect(calls.at(-1)!.sql).toContain('last_error = excluded.last_error');
    }
    globalThis.fetch = async () => { throw new Error('timeout'); };
    expect((await syncYear(db as never, 2026)).error).toBe('timeout');
  } finally { globalThis.fetch = originalFetch; }
});

test('source validation rejects unsupported regions, duplicates and arbitrary URLs', () => {
  expect(updateSubscriptionSchema.safeParse({ enabled_holiday_sources: ['CN_MAINLAND'] }).success).toBe(true);
  expect(updateSubscriptionSchema.safeParse({ enabled_holiday_sources: [] }).success).toBe(true);
  for (const sources of [['CN_HK'], ['https://evil.test'], ['CN_MAINLAND', 'CN_MAINLAND']]) {
    expect(updateSubscriptionSchema.safeParse({ enabled_holiday_sources: sources }).success).toBe(false);
  }
  expect(createSubscriptionSchema.shape.enabled_holiday_sources.parse(undefined)).toEqual([]);
});

test('holiday API advertises only implemented sources and explicitly unavailable years', async () => {
  const db = database();
  const request = { get: (url: string) => worker.fetch(new Request(url), { DB: db as never }) };
  const sources = await (await request.get('http://127.0.0.1:8787/api/v1/holiday-sources')).json();
  expect(sources.sources.map((source: { source_code: string }) => source.source_code)).toEqual(['CN_MAINLAND']);
  const response = await request.get('http://127.0.0.1:8787/api/v1/holidays?source=CN_MAINLAND&year=2027');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ year: 2027, status: 'unavailable', synced_at: null, days: [] });
  for (const query of ['source=CN_HK&year=2026', 'source=CN_MAINLAND&year=2026junk', 'source=CN_MAINLAND&year=9999']) {
    expect((await request.get(`http://127.0.0.1:8787/api/v1/holidays?${query}`)).status).toBe(400);
  }
});

function database() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0001_init.sql', '0002_push_retry_queue.sql', '0003_holiday_snapshots.sql']) {
    sqlite.exec(readFileSync(`apps/worker/migrations/${name}`, 'utf8'));
  }
  return {
    sqlite,
    prepare(sql: string) {
      let values: Array<string | number | null> = [];
      const statement = {
        bind(...args: Array<string | number | null>) { values = args; return statement; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async run() { return sqlite.prepare(sql).run(...values); },
      };
      return statement;
    },
  };
}

test('SQLite sync replaces corrections atomically and API serves retained stale data', async () => {
  const db = database();
  const fetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify(document));
    await syncYear(db as never, 2026);
    const corrected = { ...document, days: [document.days[0]] };
    globalThis.fetch = async () => new Response(JSON.stringify(corrected));
    await syncYear(db as never, 2026);
    globalThis.fetch = async () => new Response('', { status: 503 });
    await syncYear(db as never, 2026);
    const response = await worker.fetch(new Request('http://test/api/v1/holidays?source=CN_MAINLAND&year=2026'), { DB: db as never });
    const result = await response.json() as { status: string; days: unknown[] };
    expect(result.status).toBe('stale');
    expect(result.days).toEqual(corrected.days);
  } finally { globalThis.fetch = fetch; db.sqlite.close(); }
});

test('selected calendar controls makeup and holiday-to-work reminders, default stays unchanged', async () => {
  const db = database();
  db.sqlite.prepare(`INSERT INTO subscriptions (id,client_id,device_token,endpoint,p256dh,auth,timezone,schedule_rule,registered_at)
    VALUES ('sub','client','token','https://push.test','key','auth','Asia/Shanghai',2,'2026-01-01')`).run();
  const sub = await db.prepare('SELECT * FROM subscriptions').first();
  const env = { DB: db as never };
  expect(await shouldSendWorkdayReminder(env, sub as never, '2026-10-04', '2026-10-05', 0)).toBe(true);
  db.sqlite.prepare(`INSERT INTO subscription_holiday_sources (id, subscription_id, source_id) VALUES ('selected','sub','src_cn_mainland')`).run();
  const data = { ...document, days: [...document.days,
    { date: '2026-10-04', name: '国庆节', isOffDay: true },
    { date: '2026-10-05', name: '国庆节', isOffDay: true },
    { date: '2026-10-07', name: '国庆节', isOffDay: true },
  ] };
  db.sqlite.prepare(`INSERT INTO holiday_year_snapshots (source_code,year,payload,synced_at,attempted_at) VALUES ('CN_MAINLAND',2026,?,?,?)`)
    .run(JSON.stringify(data), new Date().toISOString(), new Date().toISOString());
  expect(await determineTypeForEveningReminder(env, sub as never, '2026-10-10')).toBe(2);
  expect(await determineTypeForEveningReminder(env, sub as never, '2026-10-01')).toBe(1);
  expect(await shouldSendWorkdayReminder(env, sub as never, '2026-10-04', '2026-10-05', 0)).toBe(false);
  expect(await shouldSendWorkdayReminder(env, sub as never, '2026-10-07', '2026-10-08', 3)).toBe(true);
  expect(await shouldSendWorkdayReminder(env, sub as never, '2026-10-09', '2026-10-10', 5)).toBe(true);
  // Unknown next year falls back to the base schedule rather than inventing a holiday.
  expect(await determineTypeForEveningReminder(env, sub as never, '2027-01-02')).toBe(1);
  db.sqlite.close();
});


test('first cron bootstraps snapshots once, failed attempts wait for daily retry', async () => {
  const db = database();
  const fetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response('', { status: 503 }); };
    await initializeHolidaySnapshots(db as never);
    expect(calls).toBe(3);
    await initializeHolidaySnapshots(db as never);
    expect(calls).toBe(3);
  } finally { globalThis.fetch = fetch; db.sqlite.close(); }
});

test('newer document wins conflicting dates and contributing stale data is exposed', () => {
  const current = { ...document, days: [{ date: '2026-12-31', name: '原安排', isOffDay: false }] };
  const next = { year: 2027, papers: document.papers, days: [{ date: '2026-12-31', name: '元旦', isOffDay: true }] };
  const rows = [snapshot(2027, next, { last_error: 'upstream_http_503' }), snapshot(2026, current)];
  const calendar = calendarFromSnapshots(2026, rows, now);
  expect(calendar.days).toEqual(next.days);
  expect(calendar.status).toBe('stale');
  expect(calendarFromSnapshots(2026, [snapshot(2026, current)], now).days).toEqual(current.days);
});

test('migration 0003 is repeatable and retains subscriptions, legacy data and snapshots', () => {
  const db = database();
  db.sqlite.prepare(`INSERT INTO subscriptions (id,client_id,device_token,endpoint,p256dh,auth,timezone,schedule_rule,registered_at)
    VALUES ('kept','kept-client','kept-token','https://push.test','key','auth','Asia/Shanghai',2,'2026-01-01')`).run();
  db.sqlite.prepare(`INSERT INTO holiday_adjustments (id,date,type,region,note) VALUES ('legacy','2026-10-01',1,'CN','国庆节')`).run();
  db.sqlite.prepare(`INSERT INTO holiday_year_snapshots (source_code,year,payload,synced_at,attempted_at) VALUES ('CN_MAINLAND',2026,?,?,?)`)
    .run(JSON.stringify(document), new Date().toISOString(), new Date().toISOString());
  const migration = readFileSync('apps/worker/migrations/0003_holiday_snapshots.sql', 'utf8');
  db.sqlite.exec(migration);
  db.sqlite.exec(migration);
  expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM subscriptions').get()?.count).toBe(1);
  expect(db.sqlite.prepare('SELECT COUNT(*) AS count FROM holiday_adjustments').get()?.count).toBe(1);
  expect(db.sqlite.prepare('SELECT payload FROM holiday_year_snapshots').get()?.payload).toBe(JSON.stringify(document));
  expect(db.sqlite.prepare("SELECT enabled FROM holiday_data_sources WHERE source_code = 'CN_HK'").get()?.enabled).toBe(0);
  db.sqlite.close();
});
