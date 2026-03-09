import { randomUUID } from 'node:crypto';

const API_BASE = 'http://127.0.0.1:8787';

type ScheduleRule = 'big_small' | 'double_rest' | 'single_rest';

interface CreateSubscriptionOptions {
  clientId?: string;
  timezone?: string;
  weekendRemindTime?: string;
  workdayRemindTime?: string;
  scheduleRule?: ScheduleRule;
  anchorDate?: string;
  anchorWeekType?: 'big' | 'small';
  enabledHolidaySources?: string[];
}

export interface CreatedSubscription {
  clientId: string;
  deviceToken: string;
  registeredAt: string;
}

export interface SubscriptionView {
  item: {
    device_token: string;
    timezone: string;
    weekend_remind_time: string;
    workday_remind_time: string;
    schedule_rule: ScheduleRule;
    week_pattern_anchor: {
      anchor_date: string;
      anchor_week_type: 'big' | 'small';
    } | null;
    weekend_enabled: boolean;
    workday_enabled: boolean;
    enabled_holiday_sources: string[];
    registered_at: string;
  };
}

export interface ExtensionsView {
  items: Array<{
    id: string;
    scope: number;
    start_date: string;
    end_date: string;
    status: number;
    created_at: string;
  }>;
}

export async function createSubscription(options?: CreateSubscriptionOptions): Promise<CreatedSubscription> {
  const clientId = options?.clientId ?? `e2e-${randomUUID()}`;
  const scheduleRule = options?.scheduleRule ?? 'big_small';
  const payload = {
    client_id: clientId,
    turnstile_token: 'dev-bypass',
    subscription: {
      endpoint: `https://example.push.service/subscriptions/${clientId}`,
      keys: {
        p256dh: `p256dh_${randomUUID().replace(/-/g, '')}`,
        auth: `auth_${randomUUID().replace(/-/g, '')}`,
      },
    },
    timezone: options?.timezone ?? 'Asia/Shanghai',
    weekend_remind_time: options?.weekendRemindTime ?? '17:00',
    workday_remind_time: options?.workdayRemindTime ?? '20:00',
    schedule_rule: scheduleRule,
    week_pattern_anchor:
      scheduleRule === 'big_small'
        ? {
            anchor_date: options?.anchorDate ?? '2026-03-02',
            anchor_week_type: options?.anchorWeekType ?? 'big',
          }
        : undefined,
    enabled_holiday_sources: options?.enabledHolidaySources ?? [],
  };

  const res = await request<{ device_token: string; registered_at: string }>('/api/v1/subscriptions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return {
    clientId,
    deviceToken: res.device_token,
    registeredAt: res.registered_at,
  };
}

export async function getSubscription(deviceToken: string): Promise<SubscriptionView['item']> {
  const res = await request<SubscriptionView>(`/api/v1/subscriptions/${deviceToken}`);
  return res.item;
}

export async function listExtensions(deviceToken: string): Promise<ExtensionsView['items']> {
  const res = await request<ExtensionsView>(`/api/v1/subscriptions/${deviceToken}/extensions`);
  return res.items;
}

export async function deleteSubscription(deviceToken: string): Promise<void> {
  await request(`/api/v1/subscriptions/${deviceToken}`, { method: 'DELETE' });
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(String(json.error ?? `request_failed_${res.status}`));
  }
  return json as T;
}
