#!/usr/bin/env node
/**
 * How does the REAL Razorpay TEST API treat our refund keys? Re-runnable evidence for the
 * refund lookup that settles a lost answer (apps/api/src/refunds/refund-provider-call.ts).
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────
 * Every refund test in the suite runs against a fake adapter. The rules those fakes encode -
 * "the key comes back on the lookup", "a duplicate receipt is refused", "a refund is listed as
 * soon as it exists" - are claims about Razorpay, and only Razorpay can confirm them. Run on
 * 2026-10-16 (workstream H2) this found that the third one is false while a create is in
 * flight, which is how a timed-out refund could be paid twice. See RECHECK_AFTER_MS.
 *
 *   key        create a refund with receipt + notes.etg_refund_key; list the payment's
 *              refunds and check the key is intact on both
 *   duplicate  a second (and a racing third..seventh) create with the same receipt; and the
 *              same receipt on another payment
 *   listing    fire a create and poll the list from the same instant: when does it appear,
 *              relative to the create's answer?
 *
 * MOVES TEST MONEY ONLY: every probe refunds a small part of a CAPTURED test payment you
 * name. It refuses anything but a `rzp_test_` key. Never point it at live keys.
 *
 * Usage (keys from the environment, never printed):
 *   RAZORPAY_KEY_ID=rzp_test_... RAZORPAY_KEY_SECRET=... \
 *     node scripts/payments/razorpay-refund-probe.mjs <key|duplicate|listing> <pay_id> [other_pay_id]
 *
 * Not part of CI: it needs real TEST credentials and a captured test payment.
 */

const [probe, paymentId, otherPaymentId] = process.argv.slice(2);
const id = process.env.RAZORPAY_KEY_ID ?? '';
const secret = process.env.RAZORPAY_KEY_SECRET ?? '';
if (!id.startsWith('rzp_test_') || !secret) {
  console.error('Refusing: set RAZORPAY_KEY_ID (rzp_test_...) and RAZORPAY_KEY_SECRET.');
  process.exit(2);
}
if (!['key', 'duplicate', 'listing'].includes(probe) || !/^pay_/.test(paymentId ?? '')) {
  console.error('Usage: razorpay-refund-probe.mjs <key|duplicate|listing> <pay_id> [other_pay_id]');
  process.exit(2);
}

const auth = 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
async function rz(method, path, body) {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { authorization: auth, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
const say = (label, value) => console.log(`${label}: ${JSON.stringify(value)}`);
const key = (tag) => `etg-rf-probe${tag}${Date.now().toString(36)}`;
const create = (pay, k, amount) =>
  rz('POST', `/payments/${pay}/refund`, {
    amount,
    receipt: k,
    notes: { etg_refund_key: k, reason: 'razorpay-refund-probe' },
  });
const listed = async (pay) =>
  (await rz('GET', `/payments/${pay}/refunds?count=100`)).json.items ?? [];
const brief = (r) => ({
  status: r.status,
  id: r.json.id ?? null,
  error: r.json.error?.description ?? null,
});

const pay = await rz('GET', `/payments/${paymentId}`);
if (pay.status !== 200 || !['captured', 'refunded'].includes(pay.json.status)) {
  console.error(`Refusing: ${paymentId} is not a captured test payment (HTTP ${pay.status}).`);
  process.exit(2);
}

if (probe === 'key') {
  const k = key('k');
  const r = await create(paymentId, k, 1000);
  say('create', brief(r));
  const item = (await listed(paymentId)).find((x) => x.id === r.json.id);
  say('listed with receipt intact', item?.receipt === k);
  say('listed with notes.etg_refund_key intact', item?.notes?.etg_refund_key === k);
}

if (probe === 'duplicate') {
  const k = key('d');
  say('first', brief(await create(paymentId, k, 1000)));
  say('same receipt again', brief(await create(paymentId, k, 1000)));
  const k2 = key('r');
  const race = await Promise.all([0, 1, 2, 3, 4].map(() => create(paymentId, k2, 1000)));
  say('five racing creates, one receipt', race.map(brief));
  say(
    'refunds Razorpay holds for that receipt',
    (await listed(paymentId)).filter((x) => x.receipt === k2).length,
  );
  if (otherPaymentId)
    say('same receipt, other payment', brief(await create(otherPaymentId, k, 1000)));
}

if (probe === 'listing') {
  for (let n = 1; n <= 5; n += 1) {
    const k = key(`l${n}`);
    const t0 = Date.now();
    let answeredAt = null;
    const pending = create(paymentId, k, 1000).then((r) => ((answeredAt = Date.now()), r));
    let firstListed = null;
    let emptyWhileInFlight = 0;
    while (Date.now() - t0 < 20_000) {
      const asked = Date.now();
      const hit = (await listed(paymentId)).some((x) => x.receipt === k);
      if (hit) {
        firstListed = asked - t0;
        break;
      }
      if (answeredAt === null) emptyWhileInFlight += 1;
    }
    await pending;
    const asked = Date.now();
    const afterAnswer = (await listed(paymentId)).some((x) => x.receipt === k);
    say(`try ${n}`, {
      createAnsweredMs: answeredAt - t0,
      firstListedMs: firstListed,
      lookupsShowingNothingWhileInFlight: emptyWhileInFlight,
      listedStraightAfterAnswer: afterAnswer,
      msSinceAnswer: asked - answeredAt,
    });
  }
}
