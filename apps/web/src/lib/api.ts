import type { ExtensionRecord, ExtensionScope, ScheduleRule } from '../types';

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8787';

type JsonValue = Record<string, unknown>;

export interface HolidaySource {
  source_code: string;
  source_name: string;
  region: string;
  enabled: number;
  priority: number;
}

export interface SubscriptionConfig {
  device_token: string;
  active: boolean;
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
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    ...options,
  });

  const json = (await res.json().catch(() => ({}))) as JsonValue;
  if (!res.ok) {
    throw new Error(String(json.error ?? `request_failed_${res.status}`));
  }

  return json as T;
}

export async function registerSubscription(payload: {
  clientId: string;
  turnstileToken: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  timezone: string;
  weekendRemindTime: string;
  workdayRemindTime: string;
  scheduleRule: ScheduleRule;
  anchorDate?: string;
  anchorWeekType?: 'big' | 'small';
  enabledHolidaySources?: string[];
}): Promise<{ device_token: string; registered_at: string }> {
  return request('/api/v1/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      client_id: payload.clientId,
      turnstile_token: payload.turnstileToken,
      subscription: {
        endpoint: payload.endpoint,
        keys: { p256dh: payload.p256dh, auth: payload.auth },
      },
      timezone: payload.timezone,
      weekend_remind_time: payload.weekendRemindTime,
      workday_remind_time: payload.workdayRemindTime,
      schedule_rule: payload.scheduleRule,
      week_pattern_anchor:
        payload.scheduleRule === 'big_small' && payload.anchorDate && payload.anchorWeekType
          ? {
              anchor_date: payload.anchorDate,
              anchor_week_type: payload.anchorWeekType,
            }
          : undefined,
      enabled_holiday_sources: payload.enabledHolidaySources ?? [],
    }),
  });
}

export async function updateSubscription(
  deviceToken: string,
  payload: {
    timezone: string;
    weekendRemindTime: string;
    workdayRemindTime: string;
    scheduleRule: ScheduleRule;
    anchorDate?: string;
    anchorWeekType?: 'big' | 'small';
    weekendEnabled: boolean;
    workdayEnabled: boolean;
    enabledHolidaySources: string[];
  }
): Promise<void> {
  await request(`/api/v1/subscriptions/${deviceToken}`, {
    method: 'PUT',
    body: JSON.stringify({
      timezone: payload.timezone,
      weekend_remind_time: payload.weekendRemindTime,
      workday_remind_time: payload.workdayRemindTime,
      schedule_rule: payload.scheduleRule,
      week_pattern_anchor:
        payload.scheduleRule === 'big_small' && payload.anchorDate && payload.anchorWeekType
          ? {
              anchor_date: payload.anchorDate,
              anchor_week_type: payload.anchorWeekType,
            }
          : undefined,
      weekend_enabled: payload.weekendEnabled,
      workday_enabled: payload.workdayEnabled,
      enabled_holiday_sources: payload.enabledHolidaySources,
    }),
  });
}

export async function createExtension(
  deviceToken: string,
  payload: { scope: ExtensionScope; startDate: string; endDate: string }
): Promise<void> {
  await request(`/api/v1/subscriptions/${deviceToken}/extensions`, {
    method: 'POST',
    body: JSON.stringify({
      scope: payload.scope,
      start_date: payload.startDate,
      end_date: payload.endDate,
    }),
  });
}

export async function listExtensions(deviceToken: string): Promise<ExtensionRecord[]> {
  const res = await request<{ items: ExtensionRecord[] }>(
    `/api/v1/subscriptions/${deviceToken}/extensions`,
    { method: 'GET' }
  );
  return res.items;
}

export async function removeExtension(deviceToken: string, extensionId: string): Promise<void> {
  await request(`/api/v1/subscriptions/${deviceToken}/extensions/${extensionId}`, {
    method: 'DELETE',
  });
}

export async function getSubscription(deviceToken: string): Promise<SubscriptionConfig> {
  const res = await request<{ item: SubscriptionConfig }>(`/api/v1/subscriptions/${deviceToken}`, {
    method: 'GET',
  });
  return res.item;
}

export async function listHolidaySources(): Promise<HolidaySource[]> {
  const res = await request<{ sources: HolidaySource[] }>('/api/v1/holiday-sources', {
    method: 'GET',
  });
  return res.sources;
}

export async function deleteSubscription(deviceToken: string): Promise<void> {
  await request(`/api/v1/subscriptions/${deviceToken}`, { method: 'DELETE' });
}

export async function fetchConfig(): Promise<{ vapid_public_key: string | null }> {
  return request<{ vapid_public_key: string | null }>('/api/v1/config');
}
