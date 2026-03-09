const CONFIG_CACHE = 'gwa-config-v1';
const CONFIG_PATH = '__gwa_notification_config__';

const OFFICIAL_NOTIFICATION_PACKS = {
  'zh-CN': {
    labels: {
      '1': '周末提醒',
      '2': '调休提醒',
      '3': '工作日提醒',
      '4': '订阅确认',
    },
    templates: {
      '1': { title: '周末将至', body: '{{date}} {{time}}：明天节奏可以慢一点。' },
      '2': { title: '调休提醒', body: '{{date}} {{time}}：请留意明天调休安排。' },
      '3': { title: '工作日提醒', body: '{{date}} {{time}}：明天是工作日，记得早休息。' },
      '4': { title: '通知已开启', body: '设置已保存，我们将在合适的时间提醒你。' },
    },
  },
  'zh-HK': {
    labels: {
      '1': '週末提醒',
      '2': '調休提醒',
      '3': '工作日提醒',
      '4': '訂閱確認',
    },
    templates: {
      '1': { title: '週末將至', body: '{{date}} {{time}}：明日可以慢慢來。' },
      '2': { title: '調休提醒', body: '{{date}} {{time}}：請留意明日調休安排。' },
      '3': { title: '工作日提醒', body: '{{date}} {{time}}：明日要返工，早點休息。' },
      '4': { title: '通知已開啟', body: '設定已儲存，我們將在合適的時間提醒你。' },
    },
  },
  'zh-TW': {
    labels: {
      '1': '週末提醒',
      '2': '調休提醒',
      '3': '工作日提醒',
      '4': '訂閱確認',
    },
    templates: {
      '1': { title: '週末將至', body: '{{date}} {{time}}：明天可以慢一點。' },
      '2': { title: '調休提醒', body: '{{date}} {{time}}：請留意明天調休安排。' },
      '3': { title: '工作日提醒', body: '{{date}} {{time}}：明天是工作日，記得早點休息。' },
      '4': { title: '通知已開啟', body: '設定已儲存，我們將在合適的時間提醒你。' },
    },
  },
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.type !== 'SYNC_NOTIFICATION_CONFIG') return;
  event.waitUntil(saveNotificationConfig(message.payload));
});

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      if (clients.length > 0) {
        return clients[0].focus();
      }
      return self.clients.openWindow('/');
    })
  );
});

async function handlePush(event) {
  const type = parsePushType(event.data);
  const config = await readNotificationConfig();
  const locale = normalizeLocale(config.locale);
  const official = OFFICIAL_NOTIFICATION_PACKS[locale];

  const officialTpl = official.templates[String(type)] ?? official.templates['1'];
  let titleTemplate = officialTpl.title;
  let bodyTemplate = officialTpl.body;

  const importedPack = selectImportedNotificationPack(config.importedNotificationPacks, locale);
  const importedTemplate = resolveImportedTemplate(importedPack?.payload, type);
  if (importedTemplate?.title) titleTemplate = importedTemplate.title;
  if (importedTemplate?.body) bodyTemplate = importedTemplate.body;

  const userTemplate = findUserTemplate(config.templates, type);
  if (userTemplate?.titleTemplate) titleTemplate = userTemplate.titleTemplate;
  if (userTemplate?.bodyTemplate) bodyTemplate = userTemplate.bodyTemplate;

  const context = buildTemplateContext(type, locale, official.labels);
  const title = renderTemplate(titleTemplate, context) || officialTpl.title;
  const body = renderTemplate(bodyTemplate, context) || officialTpl.body;

  await self.registration.showNotification(title, {
    body,
    icon: '/icon-192.svg',
    badge: '/icon-192.svg',
    tag: `reminder-${type}`,
    data: { type, at: new Date().toISOString() },
  });
}

function parsePushType(data) {
  try {
    const payload = data ? data.json() : { type: 1 };
    const value = Number(payload?.type ?? 1);
    if (value === 1 || value === 2 || value === 3 || value === 4) return value;
    return 1;
  } catch {
    return 1;
  }
}

function findUserTemplate(templates, type) {
  if (!Array.isArray(templates)) return null;
  return templates.find((item) => Number(item?.type) === type) ?? null;
}

function buildTemplateContext(type, locale, labels) {
  const now = new Date();
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return {
    date: now.toLocaleDateString(locale),
    time: now.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
    datetime: now.toLocaleString(locale),
    weekday: now.toLocaleDateString(locale, { weekday: 'long' }),
    timezone,
    type: String(type),
    type_label: labels[String(type)] ?? labels['1'],
  };
}

function renderTemplate(template, context) {
  if (typeof template !== 'string') return '';
  return template.replace(/{{\s*([a-z_]+)\s*}}/g, (matched, key) => {
    if (Object.prototype.hasOwnProperty.call(context, key)) {
      return String(context[key]);
    }
    return matched;
  });
}

function normalizeLocale(locale) {
  if (locale === 'zh-HK' || locale === 'zh-TW') return locale;
  return 'zh-CN';
}

function resolveImportedTemplate(payload, type) {
  if (!payload || typeof payload !== 'object') return null;

  const asRecord = payload;
  const candidate =
    asRecord[`type_${type}`] ??
    asRecord[String(type)] ??
    (asRecord.types && typeof asRecord.types === 'object' ? asRecord.types[String(type)] : null);

  if (!candidate || typeof candidate !== 'object') return null;
  return {
    title: typeof candidate.title === 'string' ? candidate.title : '',
    body: typeof candidate.body === 'string' ? candidate.body : '',
  };
}

function selectImportedNotificationPack(packs, locale) {
  if (!Array.isArray(packs)) return null;
  const exact = packs.find((pack) => pack?.locale === locale);
  if (exact) return exact;
  return packs.find((pack) => pack?.locale === 'zh-CN') ?? null;
}

async function saveNotificationConfig(payload) {
  const cache = await caches.open(CONFIG_CACHE);
  const req = getConfigRequest();
  const safePayload = {
    locale: normalizeLocale(payload?.locale),
    templates: Array.isArray(payload?.templates) ? payload.templates : [],
    importedNotificationPacks: Array.isArray(payload?.importedNotificationPacks)
      ? payload.importedNotificationPacks
      : [],
    updated_at: new Date().toISOString(),
  };
  await cache.put(
    req,
    new Response(JSON.stringify(safePayload), {
      headers: { 'content-type': 'application/json' },
    })
  );
}

async function readNotificationConfig() {
  const cache = await caches.open(CONFIG_CACHE);
  const req = getConfigRequest();
  const hit = await cache.match(req);
  if (!hit) {
    return { locale: 'zh-CN', templates: [], importedNotificationPacks: [] };
  }
  try {
    return await hit.json();
  } catch {
    return { locale: 'zh-CN', templates: [], importedNotificationPacks: [] };
  }
}

function getConfigRequest() {
  const scope = self.registration.scope || self.location.origin;
  return new Request(`${scope}${CONFIG_PATH}`, { method: 'GET' });
}
