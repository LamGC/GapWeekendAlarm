import { test, expect, type Page } from '@playwright/test';

const days = [
  { date: '2026-10-01', name: '国庆节', isOffDay: true },
  { date: '2026-10-02', name: '国庆节', isOffDay: true },
  { date: '2026-10-10', name: '国庆节', isOffDay: false },
];
const schedule = { timezone: 'Asia/Shanghai', scheduleRule: 'double_rest', anchorDate: '2026-09-28', anchorWeekType: 'big', weekendRemindTime: '17:00', workdayRemindTime: '20:00', weekendEnabled: true, workdayEnabled: true, enabledHolidaySources: ['CN_MAINLAND'] };
async function setup(page: Page, status = 'available', source = 'CN_MAINLAND') {
  await page.clock.setFixedTime(new Date('2026-10-01T04:00:00Z'));
  await page.addInitScript((value) => {
    if (!localStorage.getItem('gwa:schedule')) localStorage.setItem('gwa:schedule', JSON.stringify(value));
  }, { ...schedule, enabledHolidaySources: source ? [source] : [] });
  await page.route('**/api/v1/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/holiday-sources') return route.fulfill({ json: { sources: [{ source_code: 'CN_MAINLAND', source_name: '中国内地', region: 'CN', enabled: 1, priority: 100 }] } });
    if (url.pathname === '/api/v1/holidays') return route.fulfill({ json: { source_code: 'CN_MAINLAND', region: 'CN', year: Number(url.searchParams.get('year')), status, synced_at: '2026-09-30T02:00:00Z', source_url: 'https://github.com/NateScarlet/holiday-cn', days: status === 'unavailable' ? [] : days } });
    return route.fulfill({ json: {} });
  });
  await page.goto('/');
}
async function choose(page: Page, name: string) {
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '节假日地区' }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

test('holiday selection persists and disabling restores the schedule countdown', async ({ page }) => {
  await setup(page, 'available', '');
  await expect(page.getByText('下一个休息日：2026-10-03', { exact: true })).toBeVisible();
  await choose(page, '中国内地');
  await page.reload();
  await expect(page.getByText('下一个休息日：2026-10-01', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).enabledHolidaySources)).toEqual(['CN_MAINLAND']);
  await choose(page, '关闭（仅按排班）');
  await page.getByRole('tab', { name: '首页', exact: true }).click();
  await expect(page.getByText('下一个休息日：2026-10-03', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).enabledHolidaySources)).toEqual([]);
});

test('calendar labels holiday rest and makeup workdays with full-date reasons', async ({ page }) => {
  await setup(page);
  await expect(page.getByTestId('holiday-coverage')).toContainText('2026年已覆盖');
  await page.getByRole('tab', { name: '日历', exact: true }).click();
  // The existing virtual scroller can initialize before layout. The return button positions the current week.
  const back = page.getByRole('button', { name: '回到本周' });
  if (await back.isVisible()) await back.click();
  await expect(page.getByTestId('calendar-2026-10-01')).toHaveAttribute('data-rest', 'true');
  await expect(page.getByTestId('calendar-2026-10-01')).toHaveAttribute('aria-label', /2026-10-01 休 · 国庆节/);
  await expect(page.getByTestId('calendar-2026-10-10')).toHaveAttribute('data-rest', 'false');
  await expect(page.getByTestId('calendar-2026-10-10')).toHaveAttribute('aria-label', /班 · 国庆节/);
});

test('unavailable and unknown coverage explicitly falls back to schedule', async ({ page }) => {
  await setup(page, 'unavailable');
  await expect(page.getByTestId('holiday-coverage')).toContainText('数据不可用，按排班估算');
  await expect(page.getByText('下一个休息日：2026-10-03', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const value = JSON.parse(localStorage.getItem('gwa:schedule')!);
    value.enabledHolidaySources = ['UNKNOWN'];
    localStorage.setItem('gwa:schedule', JSON.stringify(value));
  });
  await page.reload();
  await expect(page.getByTestId('holiday-coverage')).toContainText('来源不可用');
  await expect(page.getByText('下一个休息日：2026-10-03', { exact: true })).toBeVisible();
});

test('stale validated coverage is retained and clearly labelled', async ({ page }) => {
  await setup(page, 'stale');
  await expect(page.getByTestId('holiday-coverage')).toContainText('旧数据，待更新');
  await expect(page.getByText('下一个休息日：2026-10-01', { exact: true })).toBeVisible();
});

test('reads server selection and sends selected or disabled subscription payload', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('gwa:auth', JSON.stringify({ clientId: 'client', deviceToken: 'test-token' })));
  await setup(page, 'available', '');
  const server = { device_token: 'test-token', active: true, timezone: 'Asia/Shanghai', weekend_remind_time: '17:00', workday_remind_time: '20:00', schedule_rule: 'double_rest', week_pattern_anchor: null, weekend_enabled: true, workday_enabled: true, enabled_holiday_sources: ['CN_MAINLAND'], registered_at: '2026-01-01' };
  const payloads: unknown[] = [];
  await page.route('**/api/v1/subscriptions/test-token', (route) => {
    if (route.request().method() === 'PUT') { payloads.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
    return route.fulfill({ json: { item: server } });
  });
  await page.reload();
  await expect(page.getByText('下一个休息日：2026-10-01', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '同步通知配置', exact: true }).click();
  await expect.poll(() => payloads.length).toBe(1);
  expect(payloads[0]).toMatchObject({ enabled_holiday_sources: ['CN_MAINLAND'] });
  await choose(page, '关闭（仅按排班）');
  await page.getByRole('button', { name: '同步通知配置', exact: true }).click();
  await expect.poll(() => payloads.length).toBe(2);
  expect(payloads[1]).toMatchObject({ enabled_holiday_sources: [] });
});

test('registration includes the selected mainland source', async ({ page }) => {
  await page.addInitScript(() => {
    const registration = { active: { postMessage() {} }, pushManager: { getSubscription: async () => ({ toJSON: () => ({ endpoint: 'https://push.example.test/mock', keys: { p256dh: 'mock', auth: 'mock' } }) }) } };
    Object.defineProperty(navigator, 'serviceWorker', { value: { ready: Promise.resolve(registration), register: async () => registration } });
    Object.defineProperty(window, 'Notification', { value: { permission: 'granted', requestPermission: async () => 'granted' } });
  });
  await setup(page);
  await page.route('**/api/v1/config', (route) => route.fulfill({ json: { vapid_public_key: 'mock' } }));
  let body: unknown;
  await page.route('**/api/v1/subscriptions', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { device_token: 'registered-token', registered_at: '2026-10-01' } });
  });
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '开启通知', exact: true }).click();
  await expect.poll(() => body).toMatchObject({ enabled_holiday_sources: ['CN_MAINLAND'] });
});

test('late holiday response cannot re-enable holidays after disabling', async ({ page }) => {
  await setup(page, 'unavailable', '');
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/v1/holidays?**', async (route) => {
    await pending;
    return route.fulfill({ json: { source_code: 'CN_MAINLAND', region: 'CN', year: Number(new URL(route.request().url()).searchParams.get('year')), status: 'available', synced_at: null, source_url: '', days } });
  });
  await choose(page, '中国内地');
  await choose(page, '关闭（仅按排班）');
  release();
  await page.getByRole('tab', { name: '首页', exact: true }).click();
  await expect(page.getByTestId('holiday-coverage')).toHaveText('节假日：关闭 · 仅按排班规则');
  await expect(page.getByText('下一个休息日：2026-10-03', { exact: true })).toBeVisible();
});

test('countdown uses selected civil timezone and requests both sides of New Year', async ({ page }) => {
  await setup(page, 'available', '');
  await page.clock.setFixedTime(new Date('2026-12-31T17:00:00Z')); // Already January 1 in Shanghai.
  const requested: number[] = [];
  await page.route('**/api/v1/holidays?**', (route) => {
    const year = Number(new URL(route.request().url()).searchParams.get('year'));
    requested.push(year);
    return route.fulfill({ json: { source_code: 'CN_MAINLAND', region: 'CN', year, status: 'available', synced_at: '2026-12-31T02:00:00Z', source_url: '', days: year === 2027 ? [{ date: '2027-01-01', name: '元旦', isOffDay: true }] : [] } });
  });
  await choose(page, '中国内地');
  await page.reload();
  await expect(page.getByText('下一个休息日：2027-01-01', { exact: true })).toBeVisible();
  expect(requested).toContain(2027);
  expect(requested).toContain(2028);
});

test('old successful snapshots are stale and settings show verified attribution', async ({ page }) => {
  await setup(page);
  await page.route('**/api/v1/holidays?**', (route) => route.fulfill({ json: {
    source_code: 'CN_MAINLAND', region: 'CN', year: Number(new URL(route.request().url()).searchParams.get('year')),
    status: 'available', synced_at: '2026-09-01T02:00:00Z', source_url: 'https://github.com/NateScarlet/holiday-cn', days,
  } }));
  await page.reload();
  await expect(page.getByTestId('holiday-coverage')).toContainText('旧数据，待更新');
  await expect(page.getByText('下一个休息日：2026-10-01', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByText(/2026年 · 最近成功同步：2026\/9\/1/)).toBeVisible();
  await expect(page.getByRole('link', { name: '数据来源：holiday-cn' }).first()).toHaveAttribute('href', 'https://github.com/NateScarlet/holiday-cn');
});

test('online recovery refreshes coverage without losing last-good days on failure', async ({ page }) => {
  await setup(page);
  await expect(page.getByTestId('holiday-coverage')).toContainText('2026年已覆盖');
  let requests = 0;
  await page.route('**/api/v1/holidays?**', (route) => {
    requests += 1;
    return route.fulfill({ status: 503, json: { error: 'unavailable' } });
  });
  await page.clock.setFixedTime(new Date('2026-10-01T04:01:00Z'));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => requests).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('holiday-coverage')).toContainText('旧数据，待更新');
  await expect(page.getByText('下一个休息日：2026-10-01', { exact: true })).toBeVisible();
});
