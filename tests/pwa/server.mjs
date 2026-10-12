// Local-only production shell fixture: never contacts a deployed API or push service.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root = resolve('apps/web/dist');
let revision = '';
let broken = false;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4175');
  console.log('PWA fixture request', req.method, url.pathname);
  res.on('finish', () => console.log('PWA fixture response', res.statusCode, url.pathname));
  res.setHeader('Cache-Control', 'no-store');
  if (url.pathname === '/__test/update' && req.method === 'POST') {
    revision = url.searchParams.get('revision') ?? '';
    broken = url.searchParams.get('broken') === '1';
    res.end('ok'); return;
  }
  if (/^\/(api|auth|subscriptions|cdn-cgi)(\/|$)/.test(url.pathname)) {
    res.setHeader('Content-Type', 'application/json');
    const year = Number(url.searchParams.get('year') ?? new Date().getFullYear());
    const catalog = [{ source_code: 'CN_MAINLAND', source_name: '中国内地', region: 'CN', enabled: 1, priority: 1 }];
    const subscription = { device_token: 'test-only', active: true, timezone: 'Asia/Shanghai',
      weekend_remind_time: '17:00', workday_remind_time: '20:00', schedule_rule: 'big_small',
      week_pattern_anchor: { anchor_date: new Date().toISOString().slice(0, 10), anchor_week_type: 'big' },
      weekend_enabled: true, workday_enabled: true, enabled_holiday_sources: ['CN_MAINLAND'],
      registered_at: new Date().toISOString() };
    const payload = url.pathname === '/api/v1/subscriptions/test-only' ? { item: subscription }
      : url.pathname === '/api/v1/subscriptions/test-only/extensions' ? { items: [] }
      : url.pathname === '/api/v1/holiday-sources' ? { sources: catalog }
      : url.pathname === '/api/v1/holidays' ? { source_code: 'CN_MAINLAND', region: 'CN', year,
        status: 'available', synced_at: new Date().toISOString(), source_url: 'https://github.com/NateScarlet/holiday-cn',
        days: [{ date: `${year}-01-01`, name: '离线假期测试', isOffDay: true }] }
      : { probe: 'network-only' };
    res.end(JSON.stringify(payload)); return;
  }
  if (url.pathname === '/assets/missing-test.js') { res.writeHead(404); res.end(); return; }
  const file = resolve(root, '.' + decodeURIComponent(url.pathname));
  if (!file.startsWith(root + '/') && file !== root) { res.writeHead(403); res.end(); return; }
  try {
    let data = await readFile(file === root ? resolve(root, 'index.html') : file);
    if (url.pathname === '/sw.js') {
      data = Buffer.from(data.toString()
        .replace('const response = await fetch(request);', "console.log('PWA install fetch', path); const response = await fetch(request); console.log('PWA install fetched', path, response.status, response.type);")
        .replace('const cache = await caches.open(SHELL_CACHE);', "console.log('PWA opening cache'); const cache = await caches.open(SHELL_CACHE); console.log('PWA opened cache');")
        .replace('cache.put(request, response)', "cache.put(request, response).then(() => console.log('PWA cached', request.url))"));
    }
    if (url.pathname === '/sw.js' && revision) {
      data = Buffer.from(data.toString().replace(/"version":"[^"]+"/, `"version":"test-${revision}"`)
        .replace('"urls":[', broken ? '"urls":["/assets/missing-test.js",' : '"urls":['));
    }
    res.setHeader('Content-Type', types[extname(file)] ?? (file === root ? 'text/html' : 'application/octet-stream'));
    res.end(data);
  } catch {
    if (req.headers.accept?.includes('text/html')) {
      res.setHeader('Content-Type', 'text/html'); res.end(await readFile(resolve(root, 'index.html')));
    } else { res.writeHead(404); res.end(); }
  }
}).listen(4175, '127.0.0.1');
createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.end('{"probe":"cross-origin"}');
}).listen(4176, '127.0.0.1');
