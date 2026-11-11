/** Validate the generated site as a reader/crawler sees it, including rewritten README links. */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import assert from 'node:assert/strict';

const out = resolve(import.meta.dirname, '../docs/.vitepress/dist');
assert.ok(existsSync(out), 'Build the documentation first.');
const files = [];
function visit(dir) { for (const entry of readdirSync(dir, { withFileTypes: true })) { const p = resolve(dir, entry.name); if (entry.isDirectory()) visit(p); else files.push(p); } }
visit(out);
const htmlFiles = files.filter(p => p.endsWith('.html'));
const site = process.env.DOCS_SITE_URL ? new URL(process.env.DOCS_SITE_URL) : null;
if (site && !site.pathname.endsWith('/')) site.pathname += '/';
const origin = site?.origin || 'https://preview.invalid';
const base = site?.pathname || '/';
const failures = [];
let checked = 0;
const decode = s => s.replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
for (const file of htmlFiles) {
  const html = readFileSync(file, 'utf8');
  const path = relative(out, file).replaceAll('\\', '/');
  const url = new URL(base + path, origin);
  if (!/<title>[^<]+<\/title>/.test(html)) failures.push(`${path}: missing title`);
  if (!/<meta name="description" content="[^"]+"/.test(html)) failures.push(`${path}: missing description`);
  if (!html.includes('property="og:title"')) failures.push(`${path}: missing Open Graph title`);
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/);
  const is404 = path === '404.html';
  if (!site || is404) {
    if (canonical || !html.includes('content="noindex,nofollow"')) failures.push(`${path}: preview/404 should not be indexed`);
  } else {
    const expected = new URL(path.replace(/index\.html$/, ''), site).href;
    if (canonical?.[1] !== expected) failures.push(`${path}: canonical mismatch`);
  }
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const raw = decode(match[1]);
    if (/^(data:|mailto:|tel:|javascript:)/i.test(raw)) continue;
    let target; try { target = new URL(raw, url); } catch { failures.push(`${path}: malformed URL ${raw}`); continue; }
    if (target.origin !== origin) continue;
    if (!target.pathname.startsWith(base)) { failures.push(`${path}: path escapes configured base: ${raw}`); continue; }
    const targetPath = decodeURIComponent(target.pathname.slice(base.length));
    let disk = resolve(out, targetPath);
    if (!disk.startsWith(out + '/') && disk !== out) { failures.push(`${path}: invalid local path`); continue; }
    if (existsSync(disk) && statSync(disk).isDirectory()) disk = resolve(disk, 'index.html');
    if (!existsSync(disk) && !extname(disk)) disk += '.html';
    if (!existsSync(disk)) { failures.push(`${path}: missing ${raw}`); continue; }
    checked++;
    if (target.hash && disk.endsWith('.html')) {
      const anchor = decodeURIComponent(target.hash.slice(1));
      const targetHtml = readFileSync(disk, 'utf8');
      if (!targetHtml.includes(`id="${anchor}"`)) failures.push(`${path}: missing anchor ${raw}`);
    }
  }
}
for (const file of ['index.html', 'en/index.html', 'docs/setup.html', 'docs/faq.html', 'license.txt', 'llms.txt', 'robots.txt', 'images/social-card.png']) {
  if (!existsSync(resolve(out, file))) failures.push(`missing required artifact: ${file}`);
}
const robots = readFileSync(resolve(out, 'robots.txt'), 'utf8');
if (site) {
  assert.ok(robots.includes(`Sitemap: ${new URL('sitemap.xml', site).href}`));
  const sitemap = readFileSync(resolve(out, 'sitemap.xml'), 'utf8');
  for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    if (!match[1].startsWith(site.href)) failures.push(`sitemap outside publication URL: ${match[1]}`);
  }
} else assert.ok(robots.includes('Disallow: /'));
const png = readFileSync(resolve(out, 'images/social-card.png'));
assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
assert.ok(htmlFiles.length >= 10, 'Expected the full documentation set.');
if (failures.length) { console.error(failures.join('\n')); process.exitCode = 1; }
else console.log(`Documentation checked: ${htmlFiles.length} HTML pages, ${checked} local links/assets, metadata and share image; ${site ? 'publication URL configured' : 'noindex preview'}.`);
