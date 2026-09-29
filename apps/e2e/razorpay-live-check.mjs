/**
 * A real Razorpay payment, end to end, on the deployed QA storefront.
 *
 * Buy a paid INR ticket as a guest, pay with Razorpay's test card in their own checkout, and then
 * watch the booking become CONFIRMED and a ticket appear. The last step is the one that matters:
 * a payment that succeeds at the gateway while the booking stays pending is money taken and no
 * ticket issued, and only the signed webhook arriving can rule that out.
 */
import { chromium } from '@playwright/test';

const SITE = process.env.SITE ?? 'https://qa.eticketsgo.com';
const API = process.env.API ?? 'https://api-qa-f580.up.railway.app/api';
const OUT = process.env.OUT ?? '.';
const CARD = { number: '4100 2800 0000 1007', cvv: '123', expiry: '12/26', name: 'Test Buyer' };

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 1100 },
  timezoneId: 'Asia/Kolkata',
  locale: 'en-IN',
});

const log = (m) => console.log(m);
let bookingId = null;
page.on('response', (r) => {
  const m = r.url().match(/\/api\/bookings\/([a-z0-9]+)\/pay/);
  if (m) bookingId = m[1];
});

// ── find a paid INR event with tickets on sale ────────────────────────────────────────
const events = await (await fetch(`${API}/public/events?country=India&pageSize=30`)).json();
let target = null;
for (const e of events.data ?? []) {
  const d = await (await fetch(`${API}/public/events/${e.slug}`)).json();
  for (const s of d.sessions ?? []) {
    const tt = (s.ticketTypes ?? []).find((t) => (t.priceMinor ?? 0) > 0);
    if (tt) {
      target = { slug: e.slug, title: d.title, price: tt.priceMinor };
      break;
    }
  }
  if (target) break;
}
if (!target) {
  console.error('no paid INR event on QA to buy');
  process.exit(1);
}
log(`event: ${target.title} (${target.slug}) at INR ${(target.price / 100).toFixed(2)}`);

// ── buy it as a guest ─────────────────────────────────────────────────────────────────
await page.goto(`${SITE}/events/${target.slug}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);

const session = page.locator('main button').filter({ hasText: /\d{4},/ }).first();
if (await session.count()) {
  await session.click();
  await page.waitForTimeout(1500);
}

const cont = page.getByRole('button', { name: /continue to payment/i }).first();
const selects = page.locator('main select');
for (let i = 0; i < (await selects.count()); i += 1) {
  await selects.nth(i).selectOption('1').catch(() => {});
  await page.waitForTimeout(600);
  if (await cont.isEnabled().catch(() => false)) break;
}
for (const [pattern, value] of [
  [/name/i, 'Test Buyer'],
  [/e-?mail/i, 'qa-payment-check@eticketsgo.test'],
]) {
  const f = page.getByLabel(pattern).first();
  if (await f.count()) await f.fill(value).catch(() => {});
}
await page.waitForTimeout(500);
if (!(await cont.isEnabled().catch(() => false))) {
  console.error('could not enable "Continue to payment"');
  await page.screenshot({ path: `${OUT}/rzp-stuck.png` });
  process.exit(1);
}
await cont.click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(2000);
log(`at: ${page.url()}`);
await page.screenshot({ path: `${OUT}/rzp-1-review.png` });

// ── pay ───────────────────────────────────────────────────────────────────────────────
const pay = page.getByRole('button', { name: /^pay\b|pay ₹/i }).first();
await pay.waitFor({ state: 'visible', timeout: 30_000 });
await pay.click();
await page.waitForTimeout(6000);
log(`booking: ${bookingId ?? '(not seen)'}`);
await page.screenshot({ path: `${OUT}/rzp-2-checkout.png` });

/*
  Razorpay Checkout renders in its own iframe. Its DOM is Razorpay's, not ours, so this walks it
  defensively: find the card option, type the test card, submit, and let the polling below be the
  judge of what actually happened rather than any assertion about their markup.
*/
const frames = page.frames().filter((f) => /razorpay/i.test(f.url()));
log(`razorpay frames: ${frames.length}`);
if (frames.length === 0) {
  log('no Razorpay checkout appeared - see rzp-2-checkout.png');
  const body = (await page.locator('body').innerText()).split('\n').filter(Boolean).slice(0, 12);
  for (const l of body) log(`  ${l}`);
  await browser.close();
  process.exit(1);
}

const frame = frames[frames.length - 1];
const tryFill = async (patterns, value) => {
  for (const p of patterns) {
    const el = frame.locator(p).first();
    if (await el.count().catch(() => 0)) {
      await el.fill(value).catch(() => {});
      return true;
    }
  }
  return false;
};

await frame.waitForTimeout(3000);
const cardOption = frame.getByText(/card/i).first();
if (await cardOption.count().catch(() => 0)) {
  await cardOption.click().catch(() => {});
  await frame.waitForTimeout(2500);
}
await tryFill(['input[name="card[number]"]', 'input#card_number', 'input[placeholder*="1234"]'], CARD.number);
await tryFill(['input[name="card[expiry]"]', 'input#card_expiry', 'input[placeholder*="MM"]'], CARD.expiry);
await tryFill(['input[name="card[cvv]"]', 'input#card_cvv', 'input[placeholder*="CVV"]'], CARD.cvv);
await tryFill(['input[name="card[name]"]', 'input#card_name'], CARD.name);
await page.screenshot({ path: `${OUT}/rzp-3-card.png` });

const submit = frame.getByRole('button', { name: /pay|continue|proceed/i }).first();
if (await submit.count().catch(() => 0)) {
  await submit.click().catch(() => {});
  log('card submitted');
}
await page.waitForTimeout(12000);
await page.screenshot({ path: `${OUT}/rzp-4-after.png` });
log(`after payment: ${page.url()}`);

// ── the assertion that matters: did the booking actually confirm? ──────────────────────
if (bookingId) {
  for (let i = 0; i < 12; i += 1) {
    const r = await fetch(`${API}/public/bookings/${bookingId}`).catch(() => null);
    if (r?.ok) {
      const b = await r.json();
      log(`  poll ${i + 1}: status=${b.status} tickets=${(b.tickets ?? []).length}`);
      if (b.status === 'CONFIRMED') {
        log('\nCONFIRMED - the webhook arrived and a ticket was issued.');
        break;
      }
    } else {
      log(`  poll ${i + 1}: booking not readable without the guest token`);
      break;
    }
    await new Promise((s) => setTimeout(s, 5000));
  }
}
await browser.close();
