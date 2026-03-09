import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, RetryQueueRow, SubscriptionRow } from './types';
import type { PushErrorKind } from './push';

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_INTERVAL_MS = 5 * 60 * 1000;
import {
  anchorCorrectionSchema,
  createSubscriptionSchema,
  extensionSchema,
  updateSubscriptionSchema,
} from './validation';
import { daysBetweenInclusive, isValidTimeZone, parseHHMM, zonedNowParts } from './time';
import { isRestDay, nextDate, scheduleRuleToInt, weekTypeToInt } from './rules';
import { sendPush } from './push';
import { syncHolidaysFromCn } from './holiday-sync';

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

app.get('/api/v1/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

app.get('/api/v1/config', (c) => {
  return c.json({ vapid_public_key: c.env.VAPID_PUBLIC_KEY ?? null });
});


app.get('/api/v1/holiday-sources', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT source_code, source_name, region, enabled, priority
       FROM holiday_data_sources
      WHERE enabled = 1
   ORDER BY priority DESC, source_code ASC`
  ).all();

  return c.json({ sources: rows.results ?? [] });
});

app.post('/api/v1/subscriptions', async (c) => {
  const parsed = createSubscriptionSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', detail: parsed.error.flatten() }, 400);
  }

  const payload = parsed.data;
  const turnstileOk = await verifyTurnstile(c.env, payload.turnstile_token);
  if (!turnstileOk) {
    return c.json({ error: 'turnstile_failed' }, 403);
  }

  if (payload.schedule_rule === 'big_small' && !payload.week_pattern_anchor) {
    return c.json({ error: 'week_pattern_anchor_required_for_big_small' }, 400);
  }
  if (!isValidTimeZone(payload.timezone)) {
    return c.json({ error: 'invalid_timezone' }, 400);
  }

  // Verify the push endpoint is reachable before writing anything to DB.
  // type 4 = subscription confirmation ping; failure aborts registration.
  const pingResult = await sendPush(
    c.env,
    { endpoint: payload.subscription.endpoint, p256dh: payload.subscription.keys.p256dh, auth: payload.subscription.keys.auth },
    { type: 4 },
  );
  if (!pingResult.ok) {
    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'registration_push_check_failed',
      endpointHost: new URL(payload.subscription.endpoint).host,
      errorKind: pingResult.errorKind,
      reason: pingResult.reason,
    }));
    return c.json({ error: 'push_verification_failed', reason: pingResult.reason }, 400);
  }

  const now = new Date().toISOString();
  const scheduleRule = scheduleRuleToInt(payload.schedule_rule);
  const anchorDate = payload.week_pattern_anchor?.anchor_date ?? null;
  const anchorWeekType = payload.week_pattern_anchor
    ? weekTypeToInt(payload.week_pattern_anchor.anchor_week_type)
    : null;

  const existing = await c.env.DB.prepare(
    `SELECT id, device_token FROM subscriptions WHERE client_id = ? LIMIT 1`
  )
    .bind(payload.client_id)
    .first<{ id: string; device_token: string }>();

  const subscriptionId = existing?.id ?? crypto.randomUUID();
  const deviceToken = crypto.randomUUID();

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE subscriptions
          SET device_token = ?,
              endpoint = ?,
              p256dh = ?,
              auth = ?,
              timezone = ?,
              weekend_remind_time = ?,
              workday_remind_time = ?,
              schedule_rule = ?,
              anchor_date = ?,
              anchor_week_type = ?,
              registered_at = ?,
              status = 1,
              updated_at = datetime('now')
        WHERE id = ?`
    )
      .bind(
        deviceToken,
        payload.subscription.endpoint,
        payload.subscription.keys.p256dh,
        payload.subscription.keys.auth,
        payload.timezone,
        payload.weekend_remind_time,
        payload.workday_remind_time,
        scheduleRule,
        anchorDate,
        anchorWeekType,
        now,
        subscriptionId
      )
      .run();

    await c.env.DB.prepare(`DELETE FROM subscription_holiday_sources WHERE subscription_id = ?`)
      .bind(subscriptionId)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO subscriptions (
         id, client_id, device_token,
         endpoint, p256dh, auth,
         timezone, weekend_remind_time, workday_remind_time,
         schedule_rule, anchor_date, anchor_week_type,
         registered_at, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    )
      .bind(
        subscriptionId,
        payload.client_id,
        deviceToken,
        payload.subscription.endpoint,
        payload.subscription.keys.p256dh,
        payload.subscription.keys.auth,
        payload.timezone,
        payload.weekend_remind_time,
        payload.workday_remind_time,
        scheduleRule,
        anchorDate,
        anchorWeekType,
        now
      )
      .run();
  }

  if (payload.enabled_holiday_sources.length > 0) {
    const sourceRows = await c.env.DB.prepare(
      `SELECT id, source_code FROM holiday_data_sources WHERE source_code IN (${payload.enabled_holiday_sources
        .map(() => '?')
        .join(',')})`
    )
      .bind(...payload.enabled_holiday_sources)
      .all<{ id: string; source_code: string }>();

    for (const source of sourceRows.results ?? []) {
      await c.env.DB.prepare(
        `INSERT INTO subscription_holiday_sources (id, subscription_id, source_id)
         VALUES (?, ?, ?)`
      )
        .bind(crypto.randomUUID(), subscriptionId, source.id)
        .run();
    }
  }

  return c.json({ device_token: deviceToken, registered_at: now });
});

app.get('/api/v1/subscriptions/:deviceToken', async (c) => {
  const sub = await getSubscriptionByDeviceToken(c.env.DB, c.req.param('deviceToken'));
  if (!sub) {
    return c.json({ error: 'subscription_not_found' }, 404);
  }

  const sourceRows = await c.env.DB.prepare(
    `SELECT hds.source_code
       FROM subscription_holiday_sources shs
       JOIN holiday_data_sources hds ON hds.id = shs.source_id
      WHERE shs.subscription_id = ?
   ORDER BY hds.priority DESC, hds.source_code ASC`
  )
    .bind(sub.id)
    .all<{ source_code: string }>();

  const enabledSources = (sourceRows.results ?? []).map((row) => row.source_code);
  const weekPatternAnchor =
    sub.anchor_date && sub.anchor_week_type
      ? {
          anchor_date: sub.anchor_date,
          anchor_week_type: sub.anchor_week_type === 1 ? 'big' : 'small',
        }
      : null;

  return c.json({
    item: {
      device_token: sub.device_token,
      active: sub.status === 1,
      timezone: sub.timezone,
      weekend_remind_time: sub.weekend_remind_time,
      workday_remind_time: sub.workday_remind_time,
      schedule_rule: intToScheduleRule(sub.schedule_rule),
      week_pattern_anchor: weekPatternAnchor,
      weekend_enabled: sub.weekend_enabled === 1,
      workday_enabled: sub.workday_enabled === 1,
      enabled_holiday_sources: enabledSources,
      registered_at: sub.registered_at,
    },
  });
});

app.put('/api/v1/subscriptions/:deviceToken', async (c) => {
  const parsed = updateSubscriptionSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', detail: parsed.error.flatten() }, 400);
  }

  const sub = await getSubscriptionByDeviceToken(c.env.DB, c.req.param('deviceToken'));
  if (!sub) {
    return c.json({ error: 'subscription_not_found' }, 404);
  }

  const payload = parsed.data;
  if (payload.timezone && !isValidTimeZone(payload.timezone)) {
    return c.json({ error: 'invalid_timezone' }, 400);
  }

  const updates: string[] = [];
  const binds: unknown[] = [];

  if (payload.timezone) {
    updates.push('timezone = ?');
    binds.push(payload.timezone);
  }
  if (payload.weekend_remind_time) {
    updates.push('weekend_remind_time = ?');
    binds.push(payload.weekend_remind_time);
  }
  if (payload.workday_remind_time) {
    updates.push('workday_remind_time = ?');
    binds.push(payload.workday_remind_time);
  }
  if (payload.schedule_rule) {
    updates.push('schedule_rule = ?');
    binds.push(scheduleRuleToInt(payload.schedule_rule));
    if (payload.schedule_rule !== 'big_small' && !payload.week_pattern_anchor) {
      updates.push('anchor_date = NULL');
      updates.push('anchor_week_type = NULL');
    }
  }
  if (payload.week_pattern_anchor) {
    updates.push('anchor_date = ?');
    updates.push('anchor_week_type = ?');
    updates.push('anchor_updated_at = ?');
    binds.push(payload.week_pattern_anchor.anchor_date);
    binds.push(weekTypeToInt(payload.week_pattern_anchor.anchor_week_type));
    binds.push(new Date().toISOString());
  }
  if (typeof payload.weekend_enabled === 'boolean') {
    updates.push('weekend_enabled = ?');
    binds.push(payload.weekend_enabled ? 1 : 0);
  }
  if (typeof payload.workday_enabled === 'boolean') {
    updates.push('workday_enabled = ?');
    binds.push(payload.workday_enabled ? 1 : 0);
  }

  if (updates.length > 0) {
    await c.env.DB.prepare(
      `UPDATE subscriptions SET ${updates.join(', ')}, updated_at = datetime('now') WHERE id = ?`
    )
      .bind(...binds, sub.id)
      .run();
  }

  if (payload.enabled_holiday_sources) {
    await c.env.DB.prepare(`DELETE FROM subscription_holiday_sources WHERE subscription_id = ?`)
      .bind(sub.id)
      .run();

    if (payload.enabled_holiday_sources.length > 0) {
      const sourceRows = await c.env.DB.prepare(
        `SELECT id FROM holiday_data_sources WHERE source_code IN (${payload.enabled_holiday_sources
          .map(() => '?')
          .join(',')})`
      )
        .bind(...payload.enabled_holiday_sources)
        .all<{ id: string }>();

      for (const source of sourceRows.results ?? []) {
        await c.env.DB.prepare(
          `INSERT INTO subscription_holiday_sources (id, subscription_id, source_id)
           VALUES (?, ?, ?)`
        )
          .bind(crypto.randomUUID(), sub.id, source.id)
          .run();
      }
    }
  }

  return c.json({ ok: true });
});

app.post('/api/v1/subscriptions/:deviceToken/extensions', async (c) => {
  const parsed = extensionSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', detail: parsed.error.flatten() }, 400);
  }
  const payload = parsed.data;

  const sub = await getSubscriptionByDeviceToken(c.env.DB, c.req.param('deviceToken'));
  if (!sub) {
    return c.json({ error: 'subscription_not_found' }, 404);
  }

  const durationDays = daysBetweenInclusive(payload.start_date, payload.end_date);
  if (durationDays < 1) {
    return c.json({ error: 'invalid_date_range' }, 400);
  }
  if (durationDays > 90) {
    return c.json({ error: 'extension_range_too_long', max_days: 90 }, 400);
  }

  const scope = extensionScopeToInt(payload.scope);
  await c.env.DB.prepare(
    `INSERT INTO reminder_extensions (id, subscription_id, scope, start_date, end_date, status)
     VALUES (?, ?, ?, ?, ?, 1)`
  )
    .bind(crypto.randomUUID(), sub.id, scope, payload.start_date, payload.end_date)
    .run();

  return c.json({ ok: true });
});

app.get('/api/v1/subscriptions/:deviceToken/extensions', async (c) => {
  const sub = await getSubscriptionByDeviceToken(c.env.DB, c.req.param('deviceToken'));
  if (!sub) {
    return c.json({ error: 'subscription_not_found' }, 404);
  }

  const rows = await c.env.DB.prepare(
    `SELECT id, scope, start_date, end_date, status, created_at
       FROM reminder_extensions
      WHERE subscription_id = ?
   ORDER BY created_at DESC`
  )
    .bind(sub.id)
    .all();

  return c.json({ items: rows.results ?? [] });
});

app.delete('/api/v1/subscriptions/:deviceToken/extensions/:id', async (c) => {
  const sub = await getSubscriptionByDeviceToken(c.env.DB, c.req.param('deviceToken'));
  if (!sub) {
    return c.json({ error: 'subscription_not_found' }, 404);
  }

  await c.env.DB.prepare(`DELETE FROM reminder_extensions WHERE id = ? AND subscription_id = ?`)
    .bind(c.req.param('id'), sub.id)
    .run();

  return c.json({ ok: true });
});

app.post('/api/v1/subscriptions/:deviceToken/anchor-correction', async (c) => {
  const parsed = anchorCorrectionSchema.safeParse(await readJson(c));
  if (!parsed.success) {
    return c.json({ error: 'invalid_payload', detail: parsed.error.flatten() }, 400);
  }

  const sub = await getSubscriptionByDeviceToken(c.env.DB, c.req.param('deviceToken'));
  if (!sub) {
    return c.json({ error: 'subscription_not_found' }, 404);
  }

  await c.env.DB.prepare(
    `UPDATE subscriptions
        SET anchor_date = ?, anchor_week_type = ?, anchor_updated_at = ?, updated_at = datetime('now')
      WHERE id = ?`
  )
    .bind(
      parsed.data.anchor_date,
      weekTypeToInt(parsed.data.anchor_week_type),
      new Date().toISOString(),
      sub.id
    )
    .run();

  return c.json({ ok: true });
});

app.delete('/api/v1/subscriptions/:deviceToken', async (c) => {
  const res = await c.env.DB.prepare(`DELETE FROM subscriptions WHERE device_token = ?`)
    .bind(c.req.param('deviceToken'))
    .run();

  if ((res.meta.changes ?? 0) < 1) {
    return c.json({ error: 'subscription_not_found' }, 404);
  }

  return c.json({ ok: true });
});

const CRON_HOLIDAY_SYNC = '0 2 * * *';

export default {
  fetch: app.fetch,
  scheduled: async (event: ScheduledEvent, env: Env): Promise<void> => {
    if (event.cron === CRON_HOLIDAY_SYNC) {
      const now = new Date();
      const years = [now.getFullYear(), now.getFullYear() + 1];
      await syncHolidaysFromCn(env.DB, years);
    } else {
      await runScheduler(env);
    }
  },
};

async function runScheduler(env: Env): Promise<void> {
  await processRetryQueue(env);

  const rows = await env.DB.prepare(
    `SELECT * FROM subscriptions WHERE status = 1`
  ).all<SubscriptionRow>();

  for (const sub of rows.results ?? []) {
    try {
      await processSubscription(env, sub);
    } catch (error) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(),
        event: 'scheduler_subscription_failed',
        subscriptionId: sub.id,
        deviceToken: sub.device_token,
        error: String(error),
      }));
    }
  }
}

async function processSubscription(env: Env, sub: SubscriptionRow): Promise<void> {
  let now: ReturnType<typeof zonedNowParts>;
  try {
    now = zonedNowParts(sub.timezone);
  } catch {
    console.warn('subscription_invalid_timezone', {
      subscriptionId: sub.id,
      deviceToken: sub.device_token,
      timezone: sub.timezone,
    });
    return;
  }

  const nextDay = nextDate(now.localDate);
  const sentMap = parseSentMap(sub.last_push_date_local_by_type);

  if (sub.weekend_enabled === 1 && isTimeMatch(now.hour, now.minute, sub.weekend_remind_time)) {
    const maybeType = await determineTypeForEveningReminder(env, sub, nextDay);
    if (maybeType && !isAlreadySent(sentMap, maybeType, now.localDate)) {
      const suppressed = await isSuppressedByExtension(env.DB, sub.id, maybeType, now.localDate);
      if (!suppressed) {
        const ok = await sendType(env, sub, maybeType);
        if (ok) {
          sentMap[String(maybeType)] = now.localDate;
          await persistSentMap(env.DB, sub.id, sentMap);
        }
      }
    }
  }

  if (
    sub.workday_enabled === 1 &&
    now.weekday === 0 &&
    isTimeMatch(now.hour, now.minute, sub.workday_remind_time) &&
    !isAlreadySent(sentMap, 3, now.localDate)
  ) {
    const suppressed = await isSuppressedByExtension(env.DB, sub.id, 3, now.localDate);
    if (!suppressed) {
      const ok = await sendType(env, sub, 3);
      if (ok) {
        sentMap['3'] = now.localDate;
        await persistSentMap(env.DB, sub.id, sentMap);
      }
    }
  }
}

async function determineTypeForEveningReminder(
  env: Env,
  sub: SubscriptionRow,
  targetDate: string
): Promise<1 | 2 | null> {
  const regions = await getEnabledRegions(env.DB, sub.id);

  if (regions.length > 0) {
    const placeholders = regions.map(() => '?').join(',');
    const row = await env.DB.prepare(
      `SELECT type
         FROM holiday_adjustments
        WHERE date = ?
          AND region IN (${placeholders})
     ORDER BY type DESC
        LIMIT 1`
    )
      .bind(targetDate, ...regions)
      .first<{ type: number }>();

    if (row?.type === 2) return 2;
    if (row?.type === 1) return 1;
  }

  const rest = isRestDay({
    scheduleRule: sub.schedule_rule,
    anchorDate: sub.anchor_date,
    anchorWeekType: sub.anchor_week_type,
    date: targetDate,
  });

  return rest ? 1 : null;
}

async function sendType(env: Env, sub: SubscriptionRow, type: 1 | 2 | 3): Promise<boolean> {
  const result = await sendPush(
    env,
    { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
    { type }
  );

  if (!result.ok) {
    if (result.errorKind === 'invalid_subscription') {
      await disableSubscription(env.DB, sub.id, result.errorKind);
    } else {
      await enqueuePushRetry(env.DB, sub.id, type, result.reason ?? 'unknown', result.errorKind ?? 'unknown');
    }
    return false;
  }

  return true;
}

async function disableSubscription(db: D1Database, subscriptionId: string, reason: string): Promise<void> {
  await db.prepare(
    `UPDATE subscriptions SET status = 0, updated_at = datetime('now') WHERE id = ?`
  ).bind(subscriptionId).run();
  // Also cancel any pending retries for this subscription
  await db.prepare(
    `UPDATE push_retry_queue SET status = 0, updated_at = datetime('now') WHERE subscription_id = ? AND status = 1`
  ).bind(subscriptionId).run();
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'subscription_disabled',
    subscriptionId,
    reason,
  }));
}

async function enqueuePushRetry(
  db: D1Database,
  subscriptionId: string,
  type: number,
  lastError: string,
  lastErrorKind: string,
): Promise<void> {
  const nextRetryAt = new Date(Date.now() + RETRY_INTERVAL_MS).toISOString();
  // Avoid duplicate queue entries for the same subscription+type
  const existing = await db
    .prepare(`SELECT id FROM push_retry_queue WHERE subscription_id = ? AND type = ? AND status = 1 LIMIT 1`)
    .bind(subscriptionId, type)
    .first<{ id: string }>();
  if (existing) return;

  await db.prepare(
    `INSERT INTO push_retry_queue (id, subscription_id, type, attempt_count, max_attempts, next_retry_at, last_error, last_error_kind)
     VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
  ).bind(crypto.randomUUID(), subscriptionId, type, MAX_RETRY_ATTEMPTS, nextRetryAt, lastError, lastErrorKind).run();

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event: 'push_retry_enqueued',
    subscriptionId,
    type,
    nextRetryAt,
    lastErrorKind,
  }));
}

async function processRetryQueue(env: Env): Promise<void> {
  const now = new Date().toISOString();
  const rows = await env.DB.prepare(
    `SELECT prq.id, prq.subscription_id, prq.type, prq.attempt_count, prq.max_attempts,
            prq.next_retry_at, prq.last_error, prq.last_error_kind, prq.status,
            s.endpoint, s.p256dh, s.auth, s.device_token
       FROM push_retry_queue prq
       JOIN subscriptions s ON s.id = prq.subscription_id
      WHERE prq.status = 1 AND prq.next_retry_at <= ? AND s.status = 1
      LIMIT 50`
  ).bind(now).all<RetryQueueRow>();

  for (const row of rows.results ?? []) {
    try {
      const result = await sendPush(
        env,
        { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
        { type: row.type as 1 | 2 | 3 },
      );

      const newCount = row.attempt_count + 1;

      if (result.ok) {
        await env.DB.prepare(
          `UPDATE push_retry_queue SET status = 0, attempt_count = ?, updated_at = datetime('now') WHERE id = ?`
        ).bind(newCount, row.id).run();
        console.log(JSON.stringify({
          ts: now,
          event: 'push_retry_success',
          subscriptionId: row.subscription_id,
          type: row.type,
          attemptCount: newCount,
        }));
      } else {
        const exhausted = result.errorKind === 'invalid_subscription' || newCount >= row.max_attempts;
        if (exhausted) {
          await env.DB.prepare(
            `UPDATE push_retry_queue SET status = 0, attempt_count = ?, last_error = ?, last_error_kind = ?, updated_at = datetime('now') WHERE id = ?`
          ).bind(newCount, result.reason, result.errorKind, row.id).run();
          await disableSubscription(
            env.DB,
            row.subscription_id,
            result.errorKind === 'invalid_subscription' ? 'invalid_subscription' : 'max_retries_exhausted',
          );
          console.warn(JSON.stringify({
            ts: now,
            event: 'push_retry_exhausted',
            subscriptionId: row.subscription_id,
            type: row.type,
            attemptCount: newCount,
            errorKind: result.errorKind,
            reason: result.reason,
          }));
        } else {
          const nextRetryAt = new Date(Date.now() + RETRY_INTERVAL_MS).toISOString();
          await env.DB.prepare(
            `UPDATE push_retry_queue SET attempt_count = ?, next_retry_at = ?, last_error = ?, last_error_kind = ?, updated_at = datetime('now') WHERE id = ?`
          ).bind(newCount, nextRetryAt, result.reason, result.errorKind, row.id).run();
          console.log(JSON.stringify({
            ts: now,
            event: 'push_retry_scheduled',
            subscriptionId: row.subscription_id,
            type: row.type,
            attemptCount: newCount,
            nextRetryAt,
            errorKind: result.errorKind,
          }));
        }
      }
    } catch (err) {
      console.error(JSON.stringify({
        ts: now,
        event: 'retry_processor_error',
        rowId: row.id,
        subscriptionId: row.subscription_id,
        error: String(err),
      }));
    }
  }
}

async function isSuppressedByExtension(
  db: D1Database,
  subscriptionId: string,
  type: 1 | 2 | 3,
  localDate: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1
         FROM reminder_extensions
        WHERE subscription_id = ?
          AND scope = ?
          AND status = 1
          AND start_date <= ?
          AND end_date >= ?
        LIMIT 1`
    )
    .bind(subscriptionId, type, localDate, localDate)
    .first();

  return Boolean(row);
}

async function persistSentMap(db: D1Database, subscriptionId: string, map: Record<string, string>): Promise<void> {
  await db
    .prepare(
      `UPDATE subscriptions
          SET last_push_date_local_by_type = ?,
              updated_at = datetime('now')
        WHERE id = ?`
    )
    .bind(JSON.stringify(map), subscriptionId)
    .run();
}

async function getEnabledRegions(db: D1Database, subscriptionId: string): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT hds.region
         FROM subscription_holiday_sources shs
         JOIN holiday_data_sources hds ON hds.id = shs.source_id
        WHERE shs.subscription_id = ? AND hds.enabled = 1`
    )
    .bind(subscriptionId)
    .all<{ region: string }>();

  return (rows.results ?? []).map((r) => r.region);
}

async function getSubscriptionByDeviceToken(db: D1Database, deviceToken: string): Promise<SubscriptionRow | null> {
  return (
    (await db
      .prepare(`SELECT * FROM subscriptions WHERE device_token = ? LIMIT 1`)
      .bind(deviceToken)
      .first<SubscriptionRow>()) ?? null
  );
}

function parseSentMap(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    // ignore invalid map
  }
  return {};
}

function isAlreadySent(map: Record<string, string>, type: 1 | 2 | 3, localDate: string): boolean {
  return map[String(type)] === localDate;
}

function isTimeMatch(hour: number, minute: number, hhmm: string): boolean {
  const parsed = parseHHMM(hhmm);
  return parsed.hour === hour && parsed.minute === minute;
}

function extensionScopeToInt(scope: 'holiday' | 'adjustment' | 'workday'): 1 | 2 | 3 {
  if (scope === 'holiday') return 1;
  if (scope === 'adjustment') return 2;
  return 3;
}

function intToScheduleRule(value: number): 'big_small' | 'double_rest' | 'single_rest' {
  if (value === 1) return 'big_small';
  if (value === 2) return 'double_rest';
  return 'single_rest';
}

async function verifyTurnstile(env: Env, token: string): Promise<boolean> {
  if (!env.TURNSTILE_SECRET) {
    return env.ALLOW_INSECURE_TURNSTILE_BYPASS === 'true' && token.length > 0;
  }

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);

  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });

    if (!res.ok) return false;
    const payload = (await res.json()) as { success?: boolean };
    return payload.success === true;
  } catch {
    return false;
  }
}

async function readJson(c: { req: { raw: Request } }): Promise<unknown> {
  try {
    return await c.req.raw.json();
  } catch {
    return {};
  }
}
