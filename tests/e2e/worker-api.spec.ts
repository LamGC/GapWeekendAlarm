import { test, expect } from '@playwright/test';
import { randomUUID } from 'crypto';

const WORKER_URL = 'http://127.0.0.1:8787';

const FAKE_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-test-endpoint',
  keys: {
    p256dh: 'BAhJSTqC1tFa8xKCNpUnzZHHmEFZVh8GZNL5xqGPsWdKJJaFVNbE9oHaSwNXiX8Z9N3H7Ib8ZDAP7bG3lPdkd0=',
    auth: 'e2VzdGVzdHRlc3Q=',
  },
};

test('GET /api/v1/health returns ok', async ({ request }) => {
  const res = await request.get(`${WORKER_URL}/api/v1/health`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test('GET /api/v1/config returns vapid_public_key', async ({ request }) => {
  const res = await request.get(`${WORKER_URL}/api/v1/config`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body).toHaveProperty('vapid_public_key');
});

test('GET /api/v1/holiday-sources returns sources array', async ({ request }) => {
  const res = await request.get(`${WORKER_URL}/api/v1/holiday-sources`);
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Array.isArray(body.sources)).toBe(true);
});

test.describe.serial('subscription lifecycle', () => {
  let deviceToken = '';
  let extensionId = '';

  test('POST /api/v1/subscriptions registers successfully', async ({ request }) => {
    const res = await request.post(`${WORKER_URL}/api/v1/subscriptions`, {
      data: {
        client_id: randomUUID(),
        turnstile_token: 'test-bypass',
        subscription: FAKE_SUB,
        timezone: 'Asia/Shanghai',
        weekend_remind_time: '17:00',
        workday_remind_time: '20:00',
        schedule_rule: 'double_rest',
        enabled_holiday_sources: [],
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.device_token).toBe('string');
    deviceToken = body.device_token;
  });

  test('POST /api/v1/subscriptions with missing fields returns 400', async ({ request }) => {
    const res = await request.post(`${WORKER_URL}/api/v1/subscriptions`, {
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('GET /api/v1/subscriptions/:token returns subscription', async ({ request }) => {
    const res = await request.get(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.item.active).toBe(true);
    expect(body.item.timezone).toBe('Asia/Shanghai');
    expect(body.item.schedule_rule).toBe('double_rest');
  });

  test('GET /api/v1/subscriptions/:unknownToken returns 404', async ({ request }) => {
    const res = await request.get(`${WORKER_URL}/api/v1/subscriptions/nonexistent-token`);
    expect(res.status()).toBe(404);
  });

  test('PUT /api/v1/subscriptions/:token updates fields', async ({ request }) => {
    const putRes = await request.put(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}`, {
      data: {
        weekend_remind_time: '18:00',
        workday_enabled: false,
      },
    });
    expect(putRes.status()).toBe(200);

    const getRes = await request.get(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}`);
    expect(getRes.status()).toBe(200);
    const body = await getRes.json();
    expect(body.item.weekend_remind_time).toBe('18:00');
    expect(body.item.workday_enabled).toBe(false);
  });

  test('POST /api/v1/subscriptions/:token/extensions creates extension', async ({ request }) => {
    const res = await request.post(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}/extensions`, {
      data: {
        scope: 'holiday',
        start_date: '2026-06-01',
        end_date: '2026-06-07',
      },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    // Fetch the list to get the extension id
    const listRes = await request.get(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}/extensions`);
    const listBody = await listRes.json();
    expect(listBody.items.length).toBeGreaterThanOrEqual(1);
    extensionId = listBody.items[0].id;
  });

  test('GET /api/v1/subscriptions/:token/extensions lists extensions', async ({ request }) => {
    const res = await request.get(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}/extensions`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  test('POST /api/v1/subscriptions/:token/extensions rejects range > 90 days', async ({ request }) => {
    const res = await request.post(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}/extensions`, {
      data: {
        scope: 'holiday',
        start_date: '2026-01-01',
        end_date: '2026-05-01',
      },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('extension_range_too_long');
  });

  test('DELETE /api/v1/subscriptions/:token/extensions/:id deletes extension', async ({ request }) => {
    const deleteRes = await request.delete(
      `${WORKER_URL}/api/v1/subscriptions/${deviceToken}/extensions/${extensionId}`,
    );
    expect(deleteRes.status()).toBe(200);

    const listRes = await request.get(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}/extensions`);
    const listBody = await listRes.json();
    expect(listBody.items).toHaveLength(0);
  });

  test('POST /api/v1/subscriptions/:token/anchor-correction corrects anchor', async ({ request }) => {
    const res = await request.post(
      `${WORKER_URL}/api/v1/subscriptions/${deviceToken}/anchor-correction`,
      {
        data: {
          anchor_date: '2026-03-10',
          anchor_week_type: 'big',
        },
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('DELETE /api/v1/subscriptions/:token deletes subscription', async ({ request }) => {
    const res = await request.delete(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test('DELETE /api/v1/subscriptions/:token again returns 404', async ({ request }) => {
    const res = await request.delete(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}`);
    expect(res.status()).toBe(404);
  });
});
