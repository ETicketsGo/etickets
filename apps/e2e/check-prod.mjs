/**
 * What a reviewer opening www.eticketsgo.com actually gets.
 *
 * Driven against the real hostname with DNS pinned to Railway's edge, because a local resolver
 * can still be holding the old parking answer - and the Host header is what Railway routes a
 * custom domain on, so hitting the target hostname directly would 404 and prove nothing.
 */
import { chromium } from '@playwright/test';

const SITE = 'https://www.eticketsgo.com';
const EDGE = process.env.EDGE_IP ?? '69.46.46.12';
const OUT = process.env.OUT ?? '.';

const browser = await chromium.launch({
  args: [`--host-resolver-rules=MAP www.eticketsgo.com ${EDGE}`],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const notes = [];
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('favicon')) {
    notes.push(`${r.status()} ${new URL(r.url()).pathname}`);
  }
});

await page.goto(SITE, { waitUntil: 'networkidle' });
console.log(`title: ${await page.title()}`);
console.log(`url:   ${page.url()}`);

const body = (await page.locator('body').innerText()).split('\n').filter(Boolean);
console.log(`\nwhat the page says (first 12 lines):`);
for (const line of body.slice(0, 12)) console.log(`  ${line}`);

// Does the storefront offer anything to buy?
const eventLinks = await page.locator('a[href*="/events/"]').count();
console.log(`\nevent links on the home page: ${eventLinks}`);

// The policy pages a payment gateway checks for.
console.log('\npolicy pages:');
for (const path of ['/terms', '/privacy', '/refunds', '/contact', '/about']) {
  const res = await page.goto(`${SITE}${path}`, { waitUntil: 'domcontentloaded' });
  const heading = await page
    .locator('h1')
    .first()
    .innerText()
    .catch(() => '(no h1)');
  console.log(`  ${path.padEnd(10)} ${res?.status()}  ${heading.slice(0, 60)}`);
}

await page.goto(SITE, { waitUntil: 'networkidle' });
await page.screenshot({ path: `${OUT}/prod-home.png`, fullPage: false });

if (notes.length) {
  console.log(`\nfailed requests: ${[...new Set(notes)].join(', ')}`);
}
await browser.close();
