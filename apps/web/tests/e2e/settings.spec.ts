import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('**/api/v1/**', (route) => route.fulfill({ json: {} }));
  await page.goto('/');
  await page.getByRole('tab', { name: '设置' }).click();
});

test('settings tab shows 通知 section', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '通知', exact: true })).toBeVisible();
});

test('shows 当前未开启通知 info alert when no device token', async ({ page }) => {
  await expect(page.getByText('当前未开启通知')).toBeVisible();
});

test('schedule rule section is visible', async ({ page }) => {
  await expect(page.getByRole('heading', { name: '排班规则与本地计算', exact: true })).toBeVisible();
});

test('weekend and workday time fields are visible', async ({ page }) => {
  for (const label of ['周末/调休提醒时间', '工作日提醒时间']) {
    const heading = page.getByRole('heading', { name: label, exact: true });
    await expect(heading).toBeVisible();
    const timeFields = heading.locator('..').getByRole('combobox');
    await expect(timeFields).toHaveCount(2);
    await expect(timeFields.nth(0)).toBeVisible();
    await expect(timeFields.nth(1)).toBeVisible();
  }
});
