export interface Env {
  DB: D1Database;
  TURNSTILE_SECRET?: string;
  ALLOW_INSECURE_TURNSTILE_BYPASS?: string;
  PUSH_MODE?: 'simulate' | 'off';
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface RetryQueueRow {
  id: string;
  subscription_id: string;
  type: number;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: string;
  last_error: string | null;
  last_error_kind: string | null;
  status: number;
  // joined from subscriptions
  endpoint: string;
  p256dh: string;
  auth: string;
  device_token: string;
}

export interface HolidayCnDay {
  name: string;
  date: string;
  isOffDay: boolean;
}

export interface HolidayCnData {
  year: number;
  days: HolidayCnDay[];
}

export interface PushSubscriptionRecord {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SubscriptionRow {
  id: string;
  client_id: string;
  device_token: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  timezone: string;
  weekend_remind_time: string;
  workday_remind_time: string;
  schedule_rule: number;
  anchor_date: string | null;
  anchor_week_type: number | null;
  holiday_cycle_policy: number;
  weekend_enabled: number;
  workday_enabled: number;
  registered_at: string;
  status: number;
  last_push_date_local_by_type: string | null;
}
