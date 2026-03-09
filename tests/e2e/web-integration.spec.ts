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

test('app loads and shows 首页 tab', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible();
  await expect(page.getByText('距离下一休息日')).toBeVisible();
});

test('without device_token shows 未开启通知 alert', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '设置' }).click();
  await expect(page.getByText('当前未开启通知')).toBeVisible();
});

test('with invalid device_token, app silently clears it and shows 未开启通知', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'gwa:auth',
      JSON.stringify({ clientId: 'test', deviceToken: 'invalid-nonexistent-token' }),
    );
  });
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: '设置' }).click();
  await expect(page.getByText('当前未开启通知')).toBeVisible();
});

test('with valid registered device_token, shows active subscription status', async ({
  page,
  request,
}) => {
  const registeredClientId = randomUUID();

  // Register a subscription via the API
  const regRes = await request.post(`${WORKER_URL}/api/v1/subscriptions`, {
    data: {
      client_id: registeredClientId,
      turnstile_token: 'test-bypass',
      subscription: FAKE_SUB,
      timezone: 'Asia/Shanghai',
      weekend_remind_time: '17:00',
      workday_remind_time: '20:00',
      schedule_rule: 'double_rest',
      enabled_holiday_sources: [],
    },
  });
  expect(regRes.status()).toBe(200);
  const regBody = await regRes.json();
  const deviceToken = regBody.device_token;

  // Pre-load localStorage with the auth state before page loads
  await page.addInitScript(
    ({ token, clientId }) => {
      localStorage.setItem('gwa:auth', JSON.stringify({ clientId, deviceToken: token }));
    },
    { token: deviceToken, clientId: registeredClientId },
  );

  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await page.getByRole('tab', { name: '设置' }).click();

  // Expect active subscription notification text
  await expect(page.getByText(/通知已开启|通知已注册/)).toBeVisible();

  // Cleanup
  await request.delete(`${WORKER_URL}/api/v1/subscriptions/${deviceToken}`);
});
