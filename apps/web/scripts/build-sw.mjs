import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
// Explicit public allowlist plus Vite's hashed production modules. No API/runtime data.
// Pages redirects /index.html to /. Cache its canonical URL, hash its disk contents.
const urls = ['/', '/manifest.webmanifest', '/icon-192.svg', '/icon-512.svg'];
for (const name of await readdir(join(dist, 'assets'))) {
  if (/^[\w.-]+-[\w-]+\.(?:js|css|svg|png|webp|woff2?)$/.test(name)) urls.push(`/assets/${name}`);
}
urls.sort();
const source = await readFile(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');
const hash = createHash('sha256').update(source);
for (const url of urls) hash.update(url).update(await readFile(join(dist, url === '/' ? 'index.html' : url)));
const manifest = JSON.stringify({ version: hash.digest('hex').slice(0, 24), urls });
const marker = '/* __GWA_PRECACHE__ */ null';
if (!source.includes(marker)) throw new Error('Service worker precache marker missing');
await writeFile(join(dist, 'sw.js'), source.replace(marker, manifest));
console.log(`Precached ${urls.length} static shell files`);
