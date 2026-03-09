import webpush from 'web-push';
import type { Env, PushSubscriptionRecord } from './types';

export type PushErrorKind =
  | 'invalid_subscription' // 404/410: endpoint gone, do not retry
  | 'rate_limited'         // 429: push service throttle, retry with backoff
  | 'server_error'         // 5xx: push service issue, retry
  | 'network_error'        // fetch/connection failure, retry
  | 'unknown';             // anything else, retry up to limit

export interface PushResult {
  ok: boolean;
  reason?: string;
  errorKind?: PushErrorKind;
}

function setupVapid(env: Env): boolean {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(
    env.VAPID_SUBJECT ?? 'mailto:admin@gap-weekend-alarm.example',
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );
  return true;
}

export async function sendPush(
  env: Env,
  subscription: PushSubscriptionRecord,
  payload: { type: 1 | 2 | 3 | 4 },
): Promise<PushResult> {
  const mode = env.PUSH_MODE ?? 'simulate';

  if (mode === 'off') {
    return { ok: false, reason: 'push_disabled_by_env' };
  }

  if (mode === 'simulate') {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'push_simulate',
      endpointHost: safeHost(subscription.endpoint),
      type: payload.type,
    }));
    return { ok: true, reason: 'simulated' };
  }

  if (!setupVapid(env)) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'push_vapid_missing',
      detail: 'VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY not configured',
    }));
    return { ok: false, reason: 'vapid_not_configured', errorKind: 'unknown' };
  }

  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      JSON.stringify(payload),
      { TTL: 86400 },
    );

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'push_sent',
      endpointHost: safeHost(subscription.endpoint),
      type: payload.type,
    }));

    return { ok: true };
  } catch (err: unknown) {
    const result = classifyError(err);

    console.warn(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'push_failed',
      endpointHost: safeHost(subscription.endpoint),
      type: payload.type,
      errorKind: result.errorKind,
      reason: result.reason,
    }));

    return result;
  }
}

function classifyError(err: unknown): PushResult {
  if (err && typeof err === 'object' && 'statusCode' in err) {
    const e = err as { statusCode: number; body?: string };
    const status = e.statusCode;
    const body = (e.body ?? '').slice(0, 200);

    if (status === 404 || status === 410) {
      return { ok: false, reason: `endpoint_gone_${status}`, errorKind: 'invalid_subscription' };
    }
    if (status === 429) {
      return { ok: false, reason: 'rate_limited_429', errorKind: 'rate_limited' };
    }
    if (status >= 500) {
      return { ok: false, reason: `server_error_${status}: ${body}`.trimEnd(), errorKind: 'server_error' };
    }
    return { ok: false, reason: `push_error_${status}: ${body}`.trimEnd(), errorKind: 'unknown' };
  }
  return { ok: false, reason: `network_error: ${String(err)}`, errorKind: 'network_error' };
}

function safeHost(endpoint: string): string {
  try { return new URL(endpoint).host; } catch { return 'invalid-endpoint'; }
}
