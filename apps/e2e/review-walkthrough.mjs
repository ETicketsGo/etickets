/**
 * What a payment gateway's reviewer sees, on the real domain, doing what they will do.
 *
 * Browse -> open an event -> choose tickets -> reach the payment step. The last step is the one
 * that matters: it must show the price in rupees and say plainly that online payment is being
 * activated, rather than failing in a way that looks like a broken checkout.
 */
import { chromium } from '@playwright/test';

const SITE = process.env.SITE ?? 'https://www.eticketsgo.com';
const OUT = process.env.OUT ?? '.';
const EVENT = process.env.EVENT ?? 'hyderabad-live-comedy-night';

const browser = await chromium.launch();
/*
  An Indian visitor, which is who the reviewer will be.

  The storefront derives the visitor's country from the BROWSER TIME ZONE, so a headless browser
  left on UTC falls back to en-US and asks the API for `country=US` - the catalogue then correctly
  shows nothing, because every event is in Hyderabad. That is the location scoping working, not a
  fault, and testing from the wrong time zone reports a broken storefront that is not broken.
*/
const page = await browser.newPage({
  viewport: { width: 1280, height: 1100 },
  timezoneId: 'Asia/Kolkata',
  locale: 'en-IN',
});

const failures = [];
page.on('response', (r) => {
  if (r.status() >= 500) failures.push(`${r.status()} ${new URL(r.url()).pathname}`);
});

const step = async (name, file) => {
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/review-${file}.png` });
  console.log(`\n── ${name} — ${page.url()}`);
};

// ── 1. the catalogue ──────────────────────────────────────────────────────────────────
await page.goto(`${SITE}/events`, { waitUntil: 'networkidle' });
const cards = page.locator('a[href*="/events/"]');
await cards.first().waitFor({ state: 'visible', timeout: 30_000 });
console.log(`catalogue: ${await cards.count()} event link(s)`);
await step('catalogue', '1-catalogue');

// ── 2. an event ───────────────────────────────────────────────────────────────────────
await page.goto(`${SITE}/events/${EVENT}`, { waitUntil: 'networkidle' });
await step('event page', '2-event');
console.log(`   ${await page.locator('h1').first().innerText()}`);

// ── 3. pick a session, then tickets ───────────────────────────────────────────────────
const session = page.locator('main button').filter({ hasText: /\d{4},/ }).first();
if (await session.count()) {
  await session.click();
  await page.waitForTimeout(1500);
}
/*
  Quantities are SELECT dropdowns, one per ticket tier - not a plus/minus stepper, which is what
  a first guess reached for and why "Continue to payment" stayed disabled with nothing chosen.
  Each select is tried until the button enables, so this does not depend on which tier is first.
*/
const cont = page.getByRole('button', { name: /continue to payment/i }).first();
const selects = page.locator('main select');
for (let i = 0; i < (await selects.count()); i += 1) {
  await selects
    .nth(i)
    .selectOption('1')
    .catch(() => {});
  await page.waitForTimeout(700);
  if (await cont.isEnabled().catch(() => false)) break;
}
console.log(`   continue enabled: ${await cont.isEnabled().catch(() => false)}`);

/*
  Buying without an account: the event page asks for the name the tickets are in and an e-mail to
  send them to before it will continue. Leaving them empty is what produced "Enter the name for
  the tickets." on the first run - a validation message, not a fault.
*/
for (const [pattern, value] of [
  [/name/i, 'Gateway Reviewer'],
  [/e-?mail/i, 'reviewer@eticketsgo.com'],
]) {
  const field = page.locator('main input').filter({ hasNot: page.locator('[type=hidden]') });
  const byLabel = page.getByLabel(pattern).first();
  if (await byLabel.count()) await byLabel.fill(value).catch(() => {});
  else if (await field.count()) await field.first().fill(value).catch(() => {});
}
await page.waitForTimeout(500);

await step('tickets chosen', '3-tickets');

if (!(await cont.count())) {
  failures.push('no "Continue to payment" button');
} else {
  await cont.click();
  await page.waitForLoadState('networkidle');
  await step('after continue', '4-continue');
}

// ── 4. the payment step ───────────────────────────────────────────────────────────────
const pay = page.getByRole('button', { name: /^pay\b|pay ₹/i }).first();
if (await pay.count()) {
  await pay.click();
  await page.waitForTimeout(3000);
  await step('payment attempted', '5-payment');
}

const notice = page.getByRole('status').filter({ hasText: /activated/i });
if (await notice.count()) {
  console.log(`\nACTIVATION NOTICE:\n  ${(await notice.innerText()).split('\n').filter(Boolean).join('\n  ')}`);
} else {
  const body = (await page.locator('main').innerText()).split('\n').filter(Boolean);
  console.log('\nno activation notice; page shows:');
  for (const l of body.slice(0, 16)) console.log(`  ${l}`);
}

const alerts = (await page.getByRole('alert').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
if (alerts.length) console.log(`\nred errors on screen: ${alerts.join(' / ')}`);

console.log(
  failures.length ? `\nPROBLEMS:\n  ${[...new Set(failures)].join('\n  ')}` : '\nNo server errors.',
);
await browser.close();
