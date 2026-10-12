import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

type Listener = (event: Record<string, unknown>) => void;
function worker(failPath = '', urls = ['/index.html', '/assets/app-hash.js'], fetchSlots = Infinity) {
  const listeners = new Map<string, Listener>();
  const stores = new Map<string, Map<string, unknown>>();
  const fetched: string[] = [];
  const consumed: string[] = [];
  const cacheOpenConsumedCounts: number[] = [];
  let activeFetches = 0;
  const waitingFetches: Array<() => void> = [];
  async function acquireFetchSlot() {
    if (activeFetches < fetchSlots) { activeFetches++; return; }
    await new Promise<void>((resolve) => waitingFetches.push(resolve));
  }
  function releaseFetchSlot() {
    const next = waitingFetches.shift();
    if (next) next();
    else activeFetches--;
  }
  let claimed = 0;
  let skipped = 0;
  const key = (request: string | Request) => typeof request === 'string' ? new URL(request, 'https://shell.example').href : request.url;
  const source = readFileSync('apps/web/public/sw.js', 'utf8').replace('/* __GWA_PRECACHE__ */ null', JSON.stringify({ version: 'unit-new', urls }));
  runInNewContext(source, {
    URL, Request, Response, Set, console,
    self: {
      location: { origin: 'https://shell.example' }, registration: { scope: 'https://shell.example/' },
      clients: { claim: async () => { claimed++; } }, skipWaiting: async () => { skipped++; },
      addEventListener: (name: string, listener: Listener) => listeners.set(name, listener),
    },
    caches: {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        cacheOpenConsumedCounts.push(consumed.length);
        if (!stores.has(name)) stores.set(name, new Map());
        const store = stores.get(name)!;
        return { put: async (request: string | Request, response: unknown) => { store.set(key(request), response); }, match: async (request: string | Request) => store.get(key(request)) };
      },
    },
    fetch: async (request: Request) => {
      await acquireFetchSlot();
      fetched.push(request.url);
      let bodyConsumed = false;
      return {
        status: new URL(request.url).pathname === failPath ? 500 : 200,
        statusText: 'OK', type: 'basic', redirected: false,
        headers: new Headers({ 'content-type': 'application/javascript', 'content-encoding': 'gzip', 'content-length': '999' }),
        arrayBuffer: async () => {
          if (bodyConsumed) throw new Error('body_already_consumed');
          bodyConsumed = true;
          const body = await new Response(`decoded:${new URL(request.url).pathname}`).arrayBuffer();
          consumed.push(request.url);
          releaseFetchSlot();
          return body;
        },
      };
    },
  });
  async function lifecycle(name: string) {
    let work: Promise<unknown> | undefined;
    listeners.get(name)!({ waitUntil: (promise: Promise<unknown>) => { work = promise; } });
    await work;
  }
  function intercept(path: string, options: { method?: string; mode?: string } = {}) {
    let response: Promise<unknown> | undefined;
    listeners.get('fetch')!({ request: { url: new URL(path, 'https://shell.example').href, method: 'GET', mode: 'cors', ...options },
      respondWith: (promise: Promise<unknown>) => { response = promise; } });
    return response;
  }
  return { stores, fetched, consumed, cacheOpenConsumedCounts, lifecycle, intercept, claimed: () => claimed, skipped: () => skipped };
}

test('shell install is complete before activation and never forces updates', async () => {
  const sw = worker();
  sw.stores.set('gwa-shell-v1-old', new Map());
  sw.stores.set('gwa-config-v1', new Map());
  sw.stores.set('another-app-cache', new Map());
  await sw.lifecycle('install');
  expect(sw.skipped()).toBe(0);
  expect(sw.stores.get('gwa-shell-v1-unit-new')?.size).toBe(2);
  expect(sw.stores.has('gwa-shell-v1-old')).toBe(true);
  await sw.lifecycle('activate');
  expect([...sw.stores.keys()]).toEqual(['gwa-config-v1', 'another-app-cache', 'gwa-shell-v1-unit-new']);
  expect(sw.claimed()).toBe(1);
});

test('failed shell install does not damage last complete cache', async () => {
  const sw = worker('/assets/app-hash.js');
  sw.stores.set('gwa-shell-v1-old', new Map());
  await expect(sw.lifecycle('install')).rejects.toThrow('precache_failed');
  expect([...sw.stores.keys()]).toEqual(['gwa-shell-v1-old']);
});

test('only installed public assets and SPA navigation are intercepted', async () => {
  const sw = worker();
  await sw.lifecycle('install');
  const initial = [...sw.fetched];
  expect(await sw.intercept('/unknown/deep?view=calendar', { mode: 'navigate' })).toBeTruthy();
  expect(await sw.intercept('/assets/app-hash.js')).toBeTruthy();
  for (const path of ['/api/v1/subscriptions', '/auth/session', '/oauth/login', '/subscriptions/a', '/cdn-cgi/challenge', '/turnstile/a', '/__gwa_notification_config__', 'https://other.example/file.js']) {
    expect(sw.intercept(path)).toBeUndefined();
    expect(sw.intercept(path, { mode: 'navigate' })).toBeUndefined();
  }
  expect(sw.intercept('/assets/app-hash.js', { method: 'POST' })).toBeUndefined();
  expect(sw.intercept('/assets/app-hash.js?secret=value')).toBeUndefined();
  expect(sw.intercept('/not-allowlisted.js')).toBeUndefined();
  expect(sw.fetched).toEqual(initial);
});


test('install drains bodies before awaiting all headers under a three-fetch limit', async () => {
  const urls = ['/assets/app-hash.css', '/assets/app-hash.js', '/icon-192.svg', '/icon-512.svg', '/index.html', '/manifest.webmanifest'];
  const sw = worker('', urls, 3);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sw.lifecycle('install'),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('install deadlocked: unconsumed bodies hold all three fetch slots')), 1_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
  expect(sw.fetched).toHaveLength(6);
  expect(sw.consumed).toHaveLength(6);
  // Atomic write phase starts only after every complete response body is available.
  expect(sw.cacheOpenConsumedCounts).toEqual([6]);
  const cache = sw.stores.get('gwa-shell-v1-unit-new')!;
  expect(cache.size).toBe(6);
  for (const url of urls) {
    const response = cache.get(`https://shell.example${url}`) as Response;
    expect(await response.text()).toBe(`decoded:${url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/javascript');
    expect(response.headers.has('content-encoding')).toBe(false);
    expect(response.headers.has('content-length')).toBe(false);
  }
});
