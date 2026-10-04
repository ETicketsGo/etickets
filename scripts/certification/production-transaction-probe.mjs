#!/usr/bin/env node
/**
 * Can a real customer give ETicketsGo money, and would anything good happen if they did?
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * "Production is up" and "production can take a payment" are different claims, and the gap
 * between them is where a launch goes wrong. A green `/api/ready` says the database and Redis
 * answered; it says nothing about whether the payment provider bound, whether a buyer can get a
 * price, or whether the webhook that turns money into a ticket is reachable.
 *
 * This asks the questions a launch decision actually rests on, from outside, over HTTPS, as a
 * stranger. Every check is READ-ONLY: it browses, prices a basket, and sends one deliberately
 * invalid webhook signature. It creates no booking, takes no payment and writes nothing.
 *
 * ── WHAT IT WILL NOT DO ────────────────────────────────────────────────────────────────
 * It never prints a secret, never sends a valid webhook signature, and never creates production
 * data. Anything that would need a credential is reported as NOT PROVEN rather than skipped
 * quietly, because a missing check that looks like a passing one is how this kind of report
 * stops being worth reading.
 *
 * Usage:
 *   node scripts/certification/production-transaction-probe.mjs
 *   node scripts/certification/production-transaction-probe.mjs --json
 *   API=https://api.example.com WEB=https://www.example.com node ... (defaults are production)
 *
 * Exit code is 1 when a BLOCKER is found, so it can gate a go-live.
 */

const API = process.env.API ?? 'https://api.eticketsgo.com';
const WEB = process.env.WEB ?? 'https://www.eticketsgo.com';
const JSON_OUT = process.argv.includes('--json');

const results = [];

/**
 * One finding.
 *
 * `level` is deliberately coarse: a launch decision is not helped by five shades of amber.
 *   OK       - works, and we watched it work
 *   NOTE     - true and worth knowing, not a blocker
 *   BLOCKER  - a real customer would be harmed, misled, or unable to buy
 *   UNPROVEN - could not be established from outside without a credential
 */
function record(area, check, level, detail) {
  results.push({ area, check, level, detail });
}

async function get(path, base = API) {
  try {
    const res = await fetch(`${base}${path}`, { redirect: 'follow' });
    const text = await res.text();
    return { status: res.status, text, json: safeJson(text) };
  } catch (err) {
    return { status: 0, text: String(err), json: null };
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function main() {
  // ── is anything there at all ────────────────────────────────────────────────────────
  const ready = await get('/api/ready');
  record(
    'Platform',
    'API answers /api/ready',
    ready.status === 200 && ready.json?.status === 'ok' ? 'OK' : 'BLOCKER',
    ready.status === 200 ? JSON.stringify(ready.json?.checks ?? {}) : `HTTP ${ready.status}`,
  );

  const web = await get('/', WEB);
  record(
    'Platform',
    'Storefront answers',
    web.status === 200 ? 'OK' : 'BLOCKER',
    `HTTP ${web.status}`,
  );

  // ── can a stranger find something to buy ────────────────────────────────────────────
  const events = await get('/api/public/events');
  const list = events.json?.data ?? events.json ?? [];
  record(
    'Buyer',
    'Catalogue returns something purchasable',
    events.status === 200 && list.length > 0 ? 'OK' : 'BLOCKER',
    `HTTP ${events.status}, ${list.length} event(s)`,
  );

  // ── can a stranger get a price ──────────────────────────────────────────────────────
  let quoted = null;
  const slug = list[0]?.slug;
  if (slug) {
    const detail = await get(`/api/public/events/${slug}`);
    const ev = detail.json?.data ?? detail.json;
    const session = (ev?.sessions ?? ev?.shows ?? [])[0];
    const tt = (session?.ticketTypes ?? [])[0];

    if (session && tt) {
      try {
        const res = await fetch(`${API}/api/bookings/quote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            eventSessionId: session.id,
            items: [{ ticketTypeId: tt.id, quantity: 1 }],
          }),
        });
        quoted = safeJson(await res.text());
        const fees = quoted?.fees;
        record(
          'Buyer',
          'Checkout can price a basket',
          res.ok && fees?.totalMinor > 0 ? 'OK' : 'BLOCKER',
          fees
            ? `total ${fees.totalMinor} ${fees.currency} (subtotal ${fees.subtotalMinor}, fees ${fees.customerFeeMinor}, tax ${fees.taxMinor})`
            : `HTTP ${res.status}`,
        );
        /*
          Tax is reported rather than judged. Zero is a legitimate configuration - the tax
          engine ships inactive and holds no rate - but selling in a tax jurisdiction with no
          tax line is a business decision somebody has to have made on purpose.
        */
        record(
          'Buyer',
          'Tax is charged on a sale',
          fees?.taxMinor > 0 ? 'OK' : 'NOTE',
          fees?.taxMinor > 0
            ? `${fees.taxMinor} minor units`
            : 'No tax line on this basket. Deliberate if the tax engine is meant to be inactive.',
        );
      } catch (err) {
        record('Buyer', 'Checkout can price a basket', 'BLOCKER', String(err).slice(0, 120));
      }
    } else {
      record('Buyer', 'Checkout can price a basket', 'UNPROVEN', 'No session/ticket type found');
    }
  }

  // ── the thing that turns money into a ticket ────────────────────────────────────────
  try {
    const res = await fetch(`${API}/api/payments/webhooks/razorpay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'probe-invalid' },
      body: JSON.stringify({ event: 'probe', payload: {} }),
    });
    const body = safeJson(await res.text());
    /*
      A 400 with PAYMENT_WEBHOOK_INVALID is the RIGHT answer: the endpoint exists, a secret is
      configured, and it refuses an unsigned caller. A 501 would mean no secret; a 404 would mean
      the route is not deployed; a 2xx would mean it accepts anything, which is the worst case.
    */
    const good = res.status === 400 && body?.code === 'PAYMENT_WEBHOOK_INVALID';
    record(
      'Payments',
      'Webhook endpoint exists and refuses an invalid signature',
      good ? 'OK' : 'BLOCKER',
      `HTTP ${res.status} ${body?.code ?? ''}`.trim(),
    );
  } catch (err) {
    record('Payments', 'Webhook endpoint reachable', 'BLOCKER', String(err).slice(0, 120));
  }

  /*
    The one thing this probe cannot establish from outside. Whether the provider ADAPTER bound is
    visible only in the service log, and whether the provider is configured to SEND to that
    webhook is visible only in the provider dashboard. Both are stated as unproven rather than
    assumed from the endpoint answering.
  */
  record(
    'Payments',
    'Provider adapter is bound and can create a payment',
    'UNPROVEN',
    'Needs the API boot log (PaymentProviderFactory) — not observable without a credential.',
  );
  record(
    'Payments',
    'Provider actually delivers webhooks here',
    'UNPROVEN',
    'Needs the provider dashboard or one real paid transaction.',
  );

  // ── would anybody hand money to this page ───────────────────────────────────────────
  const home = web.text ?? '';
  const demoish = [
    ['Demo build', /demo build/i],
    ['placeholder legal terms', /legal terms are placeholders/i],
    ['placeholder prices', /prices (below )?are placeholders/i],
    ['placeholder testimonials', /quotes are placeholders/i],
  ].filter(([, re]) => re.test(home));
  record(
    'Storefront',
    'Page does not describe itself as a demo',
    demoish.length === 0 ? 'OK' : 'BLOCKER',
    demoish.length ? `found: ${demoish.map(([n]) => n).join(', ')}` : 'no demo wording',
  );

  const contact = await get('/contact', WEB);
  const fakeContact = /@eticketsgo\.example|\+00 0000 000000/i.test(contact.text ?? '');
  record(
    'Storefront',
    'Contact details are real',
    fakeContact ? 'BLOCKER' : 'OK',
    fakeContact
      ? 'contact page still uses .example addresses / placeholder phone'
      : 'no placeholders found',
  );

  // ── things that should not be open to the world ─────────────────────────────────────
  for (const [path, what] of [
    ['/api/docs', 'API docs not public'],
    ['/api/docs-json', 'API schema not public'],
  ]) {
    const r = await get(path);
    record('Security', what, r.status === 404 ? 'OK' : 'BLOCKER', `HTTP ${r.status}`);
  }
  const metrics = await get('/api/metrics');
  record(
    'Security',
    'Metrics require a token',
    metrics.status === 401 ? 'OK' : 'BLOCKER',
    `HTTP ${metrics.status}`,
  );

  // ── report ──────────────────────────────────────────────────────────────────────────
  const blockers = results.filter((r) => r.level === 'BLOCKER');
  if (JSON_OUT) {
    console.log(
      JSON.stringify({ api: API, web: WEB, results, blockers: blockers.length }, null, 2),
    );
  } else {
    let area = '';
    for (const r of results) {
      if (r.area !== area) {
        area = r.area;
        console.log(`\n${area}`);
      }
      console.log(`  ${r.level.padEnd(8)} ${r.check}${r.detail ? ` — ${r.detail}` : ''}`);
    }
    console.log(
      `\n${blockers.length} blocker(s), ` +
        `${results.filter((r) => r.level === 'UNPROVEN').length} unproven, ` +
        `${results.filter((r) => r.level === 'OK').length} ok.`,
    );
  }
  process.exit(blockers.length > 0 ? 1 : 0);
}

await main();
