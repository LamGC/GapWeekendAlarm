const READY_TIMEOUT_MS = 15_000;
const READY_ERROR = '通知服务暂未就绪，可能是离线缓存安装失败或存储空间不足。请确认网络与存储可用，刷新后重试。';

async function bounded<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(READY_ERROR)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function waitForServiceWorker(
  container: Pick<ServiceWorkerContainer, 'ready'> | undefined,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<ServiceWorkerRegistration> {
  if (!container) return Promise.reject(new Error('浏览器不支持通知服务，请更换支持的浏览器后重试。'));
  return bounded(container.ready, timeoutMs);
}

/** Server deletion is authoritative; local push cleanup must not block local logout. */
export async function removeLocalPushSubscription(
  container: Pick<ServiceWorkerContainer, 'getRegistration'> | undefined,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<boolean> {
  if (!container) return false;
  let finished = false;
  try {
    return await bounded((async () => {
      const registration = await container.getRegistration();
      if (finished || !registration) return false;
      const subscription = await registration.pushManager.getSubscription();
      if (finished) return false;
      return subscription ? await subscription.unsubscribe() : true;
    })(), timeoutMs);
  } catch {
    return false;
  } finally {
    // A slow lookup must not unsubscribe a newer registration after the user retries.
    finished = true;
  }
}
