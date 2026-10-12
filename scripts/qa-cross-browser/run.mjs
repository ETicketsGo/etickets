#!/usr/bin/env node
/*
 * Cross-browser storefront check: chromium, firefox and webkit at phone, tablet, laptop and desktop widths.
 *
 * READ-ONLY and GUARDED: it only ever targets localhost or the QA storefront. It never signs in, never
 * books and never writes, so it is safe to run against QA at any time. Anything else is refused before a
 * browser starts (production and UAT are never valid targets).
 *
 *   node scripts/qa-cross-browser/run.mjs [--base https://qa.eticketsgo.com] [--out DIR] [--engines chromium,webkit]
 *
 * Checks per page x engine x viewport: horizontal scroll, broken images, failed fonts, page errors.
 * Plus, per engine on a fresh profile: no false "new version" banner on the FIRST visit (WebKit showed one).
 * Playwright comes from apps/e2e; browsers: `cd apps/e2e && npx playwright install firefox webkit`.
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(path.resolve('apps/e2e/package.json'));
const pw = require('playwright');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const BASE = arg('base', 'https://qa.eticketsgo.com').replace(/\/$/, '');
const OUT = arg('out', 'cross-browser-out');
const ENGINES = arg('engines', 'chromium,firefox,webkit').split(',');

const ALLOWED = new Set(['localhost', '127.0.0.1', 'qa.eticketsgo.com']);
const host = new URL(BASE).hostname;
if (!ALLOWED.has(host)) {
  console.error(`Refusing to run against ${host}. Allowed: ${[...ALLOWED].join(', ')}`);
  process.exit(2);
}

const PAGES = [
  ['home', '/'],
  ['events', '/events'],
  ['movies', '/movies'],
  ['explore', '/explore'],
  ['events-city', '/events?city=Boise'],
];
const VIEWPORTS = [
  ['m390', 390, 844, 3],
  ['t768', 768, 1024, 2],
  ['l1280', 1280, 800, 1],
  ['d1440', 1440, 900, 1],
  ['d1920x2', 1920, 1080, 2],
];

const inPage = () => {
  const de = document.documentElement;
  return {
    hscroll: de.scrollWidth - de.clientWidth,
    broken: [...document.images].filter((i) => i.complete && i.naturalWidth === 0).length,
    fontsFailed: [...document.fonts].filter((f) => f.status === 'error').length,
  };
};

mkdirSync(OUT, { recursive: true });
let fail = 0;
const report = (ok, label, detail = '') => {
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${detail}`);
};

for (const engine of ENGINES) {
  const browser = await pw[engine].launch();

  // A fresh profile, first visit: there is no earlier version, so "a new version is available" is wrong.
  for (let i = 0; i < 6; i++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(1200);
    const banner = await page.evaluate(() => /new version/i.test(document.body.innerText));
    await ctx.close();
    if (banner) {
      report(false, `${engine} first-visit update banner`, `(visit ${i + 1})`);
      break;
    }
    if (i === 5) report(true, `${engine} first-visit update banner absent x6`);
  }

  for (const [vn, w, h, dpr] of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      deviceScaleFactor: dpr,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e).slice(0, 80)));
    for (const [name, url] of PAGES) {
      await page.goto(BASE + url, { waitUntil: 'load', timeout: 45000 });
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      const m = await page.evaluate(inPage);
      await page.screenshot({ path: path.join(OUT, `${name}-${engine}-${vn}.png`) });
      const ok = m.hscroll <= 0 && m.broken === 0 && m.fontsFailed === 0 && errors.length === 0;
      report(
        ok,
        `${engine} ${vn} ${name}`,
        ok ? '' : JSON.stringify({ ...m, errors: errors.splice(0) }),
      );
      errors.length = 0;
    }
    await ctx.close();
  }
  await browser.close();
}
process.exit(fail ? 1 : 0);
