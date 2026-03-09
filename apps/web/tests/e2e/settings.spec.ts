import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ json: {} }));
  await page.goto('/');
  await page.getByRole('tab', { name: '设置' }).click();
});

test('settings tab shows 通知 section', async ({ page }) => {
  await expect(page.getByText('通知')).toBeVisible();
});

test('shows 当前未开启通知 info alert when no device token', async ({ page }) => {
  await expect(page.getByText('当前未开启通知')).toBeVisible();
});

test('schedule rule section is visible', async ({ page }) => {
  await expect(page.getByText('排班规则')).toBeVisible();
});

test('weekend and workday time fields are visible', async ({ page }) => {
  // Look for time-related inputs or their labels
  const timeInputs = page.locator('input[type="time"]');
  const count = await timeInputs.count();
  if (count > 0) {
    await expect(timeInputs.first()).toBeVisible();
  } else {
    // Fall back to looking for time-related text labels
    const timeLabel = page.getByText(/提醒时间|休息日|工作日/);
    await expect(timeLabel.first()).toBeVisible();
  }
});
