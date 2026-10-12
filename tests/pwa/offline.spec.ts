import { expect, test, type Page } from '@playwright/test';

async function controlled(page: Page) {
  await page.goto('/');
  await expect.poll(() => page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.active?.state ?? registration?.installing?.state ?? 'unregistered';
  }), { message: 'Production service worker must finish installing', timeout: 10_000 }).toBe('activated');
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    { message: 'Production shell must be controlled', timeout: 10_000 }).toBe(true);
  await expect(page.locator('#root')).not.toBeEmpty();
}

async function shellNames(page: Page) {
  return page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith('gwa-shell-v1-')));
}

test.beforeEach(async ({ request, page, context }) => {
  context.on('console', (message) => { if (message.type() === 'warning' || message.type() === 'error') console.log('PWA browser:', message.text()); });
  context.on('requestfailed', (request) => console.log('PWA failed request:', request.url(), request.failure()?.errorText));
  page.on('pageerror', (error) => console.error('PWA page error:', error.message));
  await request.post('/__test/update');
});

test('production shell reloads and opens unknown SPA routes offline', async ({ page, context }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('gwa:schedule')) localStorage.setItem('gwa:schedule', JSON.stringify({ enabledHolidaySources: ['CN_MAINLAND'] }));
  });
  await controlled(page);
  await expect(page.getByTestId('holiday-coverage')).toContainText('已覆盖');
  const names = await shellNames(page);
  expect(names).toHaveLength(1);
  const urls = await page.evaluate(async (name) => (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname), names[0]);
  expect(urls).toEqual(expect.arrayContaining(['/index.html', '/manifest.webmanifest', '/icon-192.svg', '/icon-512.svg']));
  expect(urls.some((url) => /\/assets\/.+\.js$/.test(url))).toBe(true);
  expect(urls.some((url) => /\/assets\/.+\.css$/.test(url))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByTestId('offline-status')).toBeVisible();
  await expect(page.getByTestId('holiday-coverage')).toContainText('离线缓存');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '开启通知', exact: true })).toBeDisabled();
  await page.getByRole('tab', { name: '首页', exact: true }).click();
  await expect(page.getByRole('button', { name: /顺序不对/ })).toBeEnabled();
  await page.getByRole('button', { name: /顺序不对/ }).click();
  await page.goto('/offline/deep-link?view=calendar');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page).toHaveTitle('Weekend Alarm');
});

test('never caches private, POST, challenge, or cross-origin responses', async ({ page, context }) => {
  await controlled(page);
  const probes = ['/api/v1/subscriptions?token=private', '/auth/session', '/subscriptions/private', '/cdn-cgi/challenge-platform/probe', 'http://127.0.0.1:4176/probe'];
  await page.evaluate(async (urls) => {
    await Promise.all(urls.map((url) => fetch(url)));
    await fetch('/api/v1/subscriptions', { method: 'POST', body: 'private' });
  }, probes);
  const keys = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith('gwa-shell-v1-'));
    return (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((r) => r.url)))).flat();
  });
  for (const probe of probes) expect(keys.some((key) => key.includes(probe))).toBe(false);
  await context.setOffline(true);
  const results = await page.evaluate(async (urls) => Promise.all(urls.map(async (url) => {
    try { await fetch(url); return 'unexpected-response'; } catch { return 'offline'; }
  })), probes);
  expect(results).toEqual(probes.map(() => 'offline'));
});

test('update waits for old clients, then cleans only old shell caches', async ({ page, context, request }) => {
  await controlled(page);
  const previous = await shellNames(page);
  await page.evaluate(async () => {
    for (const name of ['gwa-config-v1', 'unrelated-cache']) {
      const cache = await caches.open(name);
      await cache.put('/preserved-test', new Response('keep'));
    }
    document.body.dataset.unsavedEdit = 'keep';
  });
  await request.post('/__test/update?revision=next');
  await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update(); });
  await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
  expect(await page.locator('body').getAttribute('data-unsaved-edit')).toBe('keep');
  expect(await shellNames(page)).toEqual(expect.arrayContaining([...previous, 'gwa-shell-v1-test-next']));
  await page.close();
  const next = await context.newPage();
  await controlled(next);
  await expect.poll(() => shellNames(next)).toEqual(['gwa-shell-v1-test-next']);
  expect(await next.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(['gwa-config-v1', 'unrelated-cache']));
  await context.setOffline(true);
  await next.reload();
  await expect(next.locator('#root')).not.toBeEmpty();
});

test('failed precache preserves current offline shell without partial cache', async ({ page, context, request }) => {
  await controlled(page);
  const previous = await shellNames(page);
  await request.post('/__test/update?revision=broken&broken=1');
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    await registration.update();
    const worker = registration.installing;
    if (worker && worker.state !== 'redundant') {
      await new Promise<void>((resolve) => worker.addEventListener('statechange', () => {
        if (worker.state === 'redundant') resolve();
      }));
    }
  });
  expect(await shellNames(page)).toEqual(previous);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
});


test('offline schedule edits survive a later online reload until explicit sync', async ({ page, context }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('gwa:auth')) localStorage.setItem('gwa:auth', JSON.stringify({ clientId: 'test-client', deviceToken: 'test-only' }));
  });
  await controlled(page);
  await expect(page.getByTestId('holiday-coverage')).toContainText('已覆盖');
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).anchorWeekType);
  await context.setOffline(true);
  await expect(page.getByTestId('offline-status')).toBeVisible();
  await page.getByRole('button', { name: /顺序不对/ }).click();
  const edited = original === 'big' ? 'small' : 'big';
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).anchorWeekType)).toBe(edited);
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId('offline-unsynced')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).anchorWeekType)).toBe(edited);
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByRole('button', { name: '同步通知配置', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '同步通知配置', exact: true }).click();
  await expect(page.getByTestId('offline-unsynced')).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).pendingCloudSync)).toBe(false);
});


test('blocked local storage keeps the shell usable and explains session-only settings', async ({ page }) => {
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    Storage.prototype.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  });
  await controlled(page);
  await expect(page.getByText('距离下一休息日', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: '本地存储不可用或空间不足' })).toBeVisible();
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  await expect(page.getByTestId('holiday-cache-warning')).toContainText('缓存空间不足或存储不可用');
});

test('foreground timer and reconnect revalidate cached holidays without losing last-good data', async ({ page, context }) => {
  let requests = 0;
  let name = '首次缓存';
  await page.clock.install();
  await page.addInitScript(() => {
    localStorage.setItem('gwa:schedule', JSON.stringify({ enabledHolidaySources: ['CN_MAINLAND'] }));
  });
  await page.route('**/api/v1/holidays?*', async (route) => {
    requests += 1;
    const year = Number(new URL(route.request().url()).searchParams.get('year'));
    await route.fulfill({ json: { source_code: 'CN_MAINLAND', region: 'CN', year,
      status: 'available', synced_at: new Date().toISOString(), source_url: 'https://github.com/NateScarlet/holiday-cn',
      days: [{ date: `${year}-01-01`, name, isOffDay: true }] } });
  });
  await controlled(page);
  await expect(page.getByTestId('holiday-coverage')).toContainText('已覆盖');
  const cachedText = () => page.evaluate(() => Object.entries(localStorage)
    .filter(([key]) => key.startsWith('gap-weekend:holidays:')).map(([, value]) => value).join(''));
  await expect.poll(cachedText).toContain('首次缓存');
  const initialRequests = requests;
  name = '定时刷新';
  await page.clock.fastForward(30 * 60 * 1000);
  await expect.poll(() => requests).toBeGreaterThan(initialRequests);
  await expect.poll(cachedText).toContain('定时刷新');
  await context.setOffline(true);
  await expect(page.getByTestId('holiday-coverage')).toContainText('离线缓存');
  expect(await cachedText()).toContain('定时刷新');
  name = '联网刷新';
  await context.setOffline(false);
  await expect.poll(cachedText).toContain('联网刷新');
  await expect(page.getByTestId('holiday-coverage')).toContainText('已覆盖');
});

test('failed first install cannot leave notification registration busy forever', async ({ page, context }) => {
  await context.grantPermissions(['notifications']);
  await page.clock.install();
  let subscriptionPosts = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/v1/subscriptions')) subscriptionPosts += 1;
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => {
      document.documentElement.dataset.readyReads = String(Number(document.documentElement.dataset.readyReads ?? 0) + 1);
      return new Promise(() => {});
    } });
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '设置', exact: true }).click();
  const button = page.getByRole('button', { name: '开启通知', exact: true });
  await expect(button).toBeEnabled();
  const before = await page.evaluate(() => localStorage.getItem('gwa:schedule'));
  const readyReads = await page.evaluate(() => Number(document.documentElement.dataset.readyReads ?? 0));
  await button.click();
  await expect(button).toBeDisabled();
  await expect.poll(() => page.evaluate(() => Number(document.documentElement.dataset.readyReads ?? 0))).toBeGreaterThan(readyReads);
  await page.clock.fastForward(16_000);
  await expect(page.getByText(/开启失败: 通知服务暂未就绪/)).toBeVisible();
  await expect(button).toBeEnabled();
  expect(subscriptionPosts).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem('gwa:schedule'))).toBe(before);
});

test('failed sync protects local edits even when the browser still reports online', async ({ page }) => {
  await page.addInitScript(() => {
    if (!localStorage.getItem('gwa:auth')) localStorage.setItem('gwa:auth', JSON.stringify({ clientId: 'test-client', deviceToken: 'test-only' }));
  });
  await controlled(page);
  await expect(page.getByTestId('holiday-coverage')).toContainText('已覆盖');
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  const original = await page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).anchorWeekType);
  await page.route('**/api/v1/subscriptions/test-only', async (route) => {
    if (route.request().method() === 'PUT') await route.abort('failed');
    else await route.continue();
  });
  await page.getByRole('button', { name: /顺序不对/ }).click();
  await expect(page.getByTestId('offline-unsynced')).toBeVisible();
  const edited = original === 'big' ? 'small' : 'big';
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).pendingCloudSync)).toBe(true);
  await page.unroute('**/api/v1/subscriptions/test-only');
  await page.reload();
  await expect(page.getByTestId('offline-unsynced')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('gwa:schedule')!).anchorWeekType)).toBe(edited);
});
