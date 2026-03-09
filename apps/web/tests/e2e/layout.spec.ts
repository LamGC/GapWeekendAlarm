import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ json: {} }));
  await page.goto('/');
});

test('page loads without crash', async ({ page }) => {
  await expect(page).toHaveTitle(/Weekend Alarm/);
});

test('AppBar has a visible background', async ({ page }) => {
  const header = page.locator('header');
  await expect(header).toBeVisible();
  const bgColor = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
  expect(bgColor).not.toBe('transparent');
});

test('three main tabs are visible', async ({ page }) => {
  await expect(page.getByRole('tab', { name: '首页' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '设置' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '延长' })).toBeVisible();
});

test('clicking 设置 tab shows settings content', async ({ page }) => {
  await page.getByRole('tab', { name: '设置' }).click();
  await expect(page.getByText('通知')).toBeVisible();
});

test('clicking 延长 tab shows extension content', async ({ page }) => {
  await page.getByRole('tab', { name: '延长' }).click();
  await expect(page.getByText('提醒延长')).toBeVisible();
});

test('switching back to 首页 tab shows countdown', async ({ page }) => {
  await page.getByRole('tab', { name: '设置' }).click();
  await page.getByRole('tab', { name: '首页' }).click();
  await expect(page.getByText('距离下一休息日')).toBeVisible();
});

test('倒计时 and 日历 subtabs are visible on 首页', async ({ page }) => {
  await expect(page.getByRole('tab', { name: '倒计时' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '日历' })).toBeVisible();
});
