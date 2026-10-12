/**
 * Pays (or fails) a booking in a REAL browser through Razorpay TEST-mode Netbanking.
 *
 * The storefront opens Razorpay's hosted checkout in an iframe; the test bank page that follows
 * offers "Success" and "Failure". Test mode only - the account behind QA holds TEST keys and
 * moves no real money. The contact number is the documented test contact.
 *
 * Playwright is resolved from apps/e2e so nothing new is installed.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('apps/e2e/package.json'));
const { chromium } = require('playwright');

export async function payInBrowser({
  customerBase,
  email,
  password,
  bookingId,
  outcome = 'success',
  outDir,
  tag,
}) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const shot = (n) =>
    page.screenshot({ path: path.join(outDir, `${tag}-${n}.png`), fullPage: true }).catch(() => {});
  const result = { outcome, steps: [] };
  try {
    await page.goto(`${customerBase}/en/login`, { waitUntil: 'networkidle', timeout: 90000 });
    const tab = page.getByRole('tab', { name: /email/i });
    if (await tab.count()) await tab.click();
    await page.getByLabel(/email/i).first().fill(email);
    await page
      .getByLabel(/password/i)
      .first()
      .fill(password);
    await page
      .getByRole('button', { name: /sign in|log in/i })
      .first()
      .click();
    await page.waitForURL((u) => !u.pathname.endsWith('/login'), {
      timeout: 90000,
      waitUntil: 'commit',
    });
    await page.waitForTimeout(2500);
    await page.goto(`${customerBase}/en/booking/${bookingId}/payment`, {
      waitUntil: 'networkidle',
      timeout: 90000,
    });
    await page.waitForTimeout(2500);
    await shot('1-payment-page');
    await page.getByRole('button', { name: /^Pay ₹/ }).click();
    await page.waitForTimeout(6000);
    const frame = page.frames().find((f) => f.url().includes('api.razorpay.com/v1/checkout'));
    if (!frame) throw new Error('Razorpay checkout frame did not open');
    await shot('2-razorpay-open');
    const tel = frame.locator('input[type="tel"]').first();
    if (await tel.count()) {
      await tel.fill('8121234567');
      await frame.getByRole('button', { name: /^Continue$/ }).click();
      await page.waitForTimeout(3000);
    }
    // Razorpay changes this screen now and then; the recommended bank row is the shortest path,
    // the Netbanking tab the fallback.
    const popupP = ctx.waitForEvent('page', { timeout: 90000 });
    const recommended = frame
      .getByText(/State Bank of India Netbanking|Bank of Baroda - Retail Banking Netbanking/)
      .first();
    if (await recommended.count()) {
      await recommended.click({ timeout: 30000 });
    } else {
      await frame.getByText('Netbanking', { exact: true }).first().click({ timeout: 30000 });
      await page.waitForTimeout(2500);
      await frame
        .getByText(/Bank of Baroda|State Bank|SBI|HDFC|ICICI|Axis/)
        .first()
        .click();
    }
    await page.waitForTimeout(2000);
    const payBtn = frame.getByRole('button', { name: /^Pay/ });
    if (await payBtn.count())
      await payBtn
        .last()
        .click()
        .catch(() => {});
    const popup = await popupP;
    await popup.waitForLoadState('domcontentloaded');
    await popup.screenshot({ path: path.join(outDir, `${tag}-3-test-bank.png`) }).catch(() => {});
    await popup
      .getByRole('button', { name: outcome === 'success' ? /Success/i : /Failure/i })
      .click();
    if (outcome === 'success') {
      await page.waitForURL(/confirmation|success/, { timeout: 120000 });
      await page.waitForTimeout(3000);
      result.landedOn = new URL(page.url()).pathname;
    } else {
      await page.waitForTimeout(8000);
      result.landedOn = new URL(page.url()).pathname;
      result.pageText = (
        await page
          .locator('body')
          .innerText()
          .catch(() => '')
      )
        .replace(/\s+/g, ' ')
        .slice(0, 400);
    }
    await shot('4-after');
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = e.message.split('\n')[0];
    await shot('X-stopped');
  }
  await browser.close();
  return result;
}
