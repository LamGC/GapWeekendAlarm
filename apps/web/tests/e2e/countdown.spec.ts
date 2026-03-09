import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.removeItem('gwa:countdownUnit');
  });
  await page.route('**/api/v1/**', (route) => route.fulfill({ json: {} }));
  await page.goto('/');
});

test('shows 天 label by default', async ({ page }) => {
  await expect(page.getByText('天')).toBeVisible();
  await expect(page.getByText('距离下一休息日')).toBeVisible();
});

test('first click cycles to 小时', async ({ page }) => {
  const ring = page.locator('[data-testid="countdown-ring"]');
  await ring.click();
  await expect(page.getByText('小时')).toBeVisible();
});

test('second click cycles to hh:mm:ss format', async ({ page }) => {
  const ring = page.locator('[data-testid="countdown-ring"]');
  await ring.click();
  await ring.click();
  await expect(page.getByText(/\d{2}:\d{2}:\d{2}/)).toBeVisible();
});

test('third click cycles back to 天', async ({ page }) => {
  const ring = page.locator('[data-testid="countdown-ring"]');
  await ring.click();
  await ring.click();
  await ring.click();
  await expect(page.getByText('天')).toBeVisible();
});

test('persists unit to localStorage after click', async ({ page }) => {
  const ring = page.locator('[data-testid="countdown-ring"]');
  await ring.click();
  const stored = await page.evaluate(() => localStorage.getItem('gwa:countdownUnit'));
  expect(stored).toBe('hours');
});

test('restores unit from localStorage on reload', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.setItem('gwa:countdownUnit', 'hours');
  });
  await page.reload();
  await expect(page.getByText('小时')).toBeVisible();
});
