import { expect, test } from '@playwright/test';
import { removeLocalPushSubscription, waitForServiceWorker } from '../../apps/web/src/lib/serviceWorkerReady';

const never = new Promise<never>(() => {});
const registration = (pushManager: unknown) => ({ pushManager }) as ServiceWorkerRegistration;

test('readiness timeout returns a readable retry error rather than hanging', async () => {
  await expect(waitForServiceWorker({ ready: never }, 10)).rejects.toThrow(/刷新后重试/);
  await expect(waitForServiceWorker(undefined, 10)).rejects.toThrow(/不支持/);
});

test('ready registration passes through and a rejected readiness remains handled', async () => {
  const ready = registration({});
  expect(await waitForServiceWorker({ ready: Promise.resolve(ready) }, 10)).toBe(ready);
  await expect(waitForServiceWorker({ ready: Promise.reject(new Error('failed')) }, 10)).rejects.toThrow('failed');
});

test('local cleanup tolerates missing, rejected and stalled workers or subscriptions', async () => {
  expect(await removeLocalPushSubscription(undefined, 10)).toBe(false);
  expect(await removeLocalPushSubscription({ getRegistration: async () => undefined }, 10)).toBe(false);
  expect(await removeLocalPushSubscription({ getRegistration: () => never }, 10)).toBe(false);
  expect(await removeLocalPushSubscription({ getRegistration: async () => { throw new Error('blocked'); } }, 10)).toBe(false);
  for (const getSubscription of [
    () => never,
    async () => ({ unsubscribe: () => never }),
    async () => ({ unsubscribe: async () => { throw new Error('blocked'); } }),
    async () => ({ unsubscribe: async () => false }),
  ]) {
    expect(await removeLocalPushSubscription({ getRegistration: async () => registration({ getSubscription }) }, 10)).toBe(false);
  }
});

test('cleanup succeeds when subscription is removed or already absent', async () => {
  for (const subscription of [null, { unsubscribe: async () => true }]) {
    expect(await removeLocalPushSubscription({ getRegistration: async () => registration({ getSubscription: async () => subscription }) }, 10)).toBe(true);
  }
});

test('timed-out cleanup does not later unsubscribe a newly found subscription', async () => {
  let release!: (value: ServiceWorkerRegistration) => void;
  const pending = new Promise<ServiceWorkerRegistration>((resolve) => { release = resolve; });
  let lookedUp = false;
  expect(await removeLocalPushSubscription({ getRegistration: () => pending }, 10)).toBe(false);
  release(registration({ getSubscription: async () => { lookedUp = true; return null; } }));
  await Promise.resolve();
  expect(lookedUp).toBe(false);
});
