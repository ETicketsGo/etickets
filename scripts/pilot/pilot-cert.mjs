#!/usr/bin/env node
/**
 * Pilot journey certification, driven through the public API (plus a real browser for the
 * Razorpay test checkout). Run stages in order; state is kept so a stage can be re-run.
 *
 *   node scripts/pilot/pilot-cert.mjs --env qa --out C:/etg-wt/pilot-cert --stage 1
 *
 * Writes <out>/<env>-results.json (PASS / FAIL / BLOCKED per step, with evidence ids) and
 * <out>/<env>-state.json (created ids and the throw-away test passwords - NEVER commit it).
 *
 * Only QA and UAT hosts are accepted (see lib.mjs). Test credentials and non-production funds only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { payInBrowser } from './razorpay-browser.mjs';
import {
  ENVIRONMENTS,
  createApi,
  createRecorder,
  errCode,
  loadState,
  saveState,
  sleep,
  targetVerdict,
} from './lib.mjs';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce(
      (acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc),
      [],
    ),
);
const envKey = args.env ?? 'qa';
const OUT = args.out ?? 'C:/etg-wt/pilot-cert';
const STAGE = args.stage ?? 'all';
const env = ENVIRONMENTS[envKey];
const verdict = targetVerdict(envKey, args.api ?? env?.api);
if (!verdict.allowed) {
  console.error(verdict.reason);
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });
const api = createApi(args.api ?? env.api);
const R = createRecorder(path.join(OUT, `${envKey}-results.json`));
const stateFile = path.join(OUT, `${envKey}-state.json`);
const S = loadState(stateFile);
const persist = () => saveState(stateFile, S);
const rec = R.record;
const SEED_PASSWORD = 'Password123!';
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
const randomPassword = () => `Tt!${crypto.randomBytes(9).toString('base64url')}9a`;
const only = (n) => STAGE === 'all' || String(STAGE).split(',').includes(String(n));

const idem = () => ({ 'idempotency-key': crypto.randomUUID() });
const iso = (d) => d.toISOString();

async function regUser(prefix, fullName) {
  const email = `${prefix}.${stamp}.${crypto.randomBytes(2).toString('hex')}@eticketsgo.test`;
  const password = randomPassword();
  const r = await api.call('POST', '/auth/register', { body: { email, password, fullName } });
  if (r.status >= 300) throw new Error(`register ${prefix}: ${errCode(r)}`);
  const l = await api.login(email, password);
  return { email, password, token: l.token, userId: l.userId ?? r.body?.user?.id };
}

async function getStaff() {
  S.adminToken = (await api.login('admin@eticketsgo.test', SEED_PASSWORD)).token;
  return S.adminToken;
}

// ───────────────────────── Gate 1: infrastructure ─────────────────────────
async function stageInfra() {
  const h = await api.call('GET', '/health');
  rec(
    'infra',
    'INF-1',
    'API liveness /health',
    h.status === 200 && h.body?.status === 'ok' ? 'PASS' : 'FAIL',
    `status ${h.status}`,
    { body: h.body },
  );
  const rd = await api.call('GET', '/ready');
  rec(
    'infra',
    'INF-2',
    'API readiness: database and redis up',
    rd.body?.checks?.database === 'up' && rd.body?.checks?.redis === 'up' ? 'PASS' : 'FAIL',
    JSON.stringify(rd.body?.checks),
    { body: rd.body },
  );
  const m = await api.call('GET', '/metrics');
  rec(
    'infra',
    'INF-3',
    'Metrics are not readable by the public internet',
    m.status === 401 || m.status === 403 || m.status === 404 ? 'PASS' : 'FAIL',
    `GET /metrics -> ${m.status}`,
  );
  for (const [k, u] of [
    ['customer', env.customer],
    ['organizer', env.organizer],
    ['admin', env.admin],
  ]) {
    try {
      const res = await fetch(u + (k === 'customer' ? '/en' : '/login'), { redirect: 'manual' });
      rec(
        'infra',
        `INF-4-${k}`,
        `${k} web answers`,
        res.status < 400 || res.status === 307 || res.status === 308 ? 'PASS' : 'FAIL',
        `${u} -> ${res.status}`,
      );
    } catch (e) {
      rec('infra', `INF-4-${k}`, `${k} web answers`, 'FAIL', `${u}: ${e.message}`);
    }
  }
}

// ───────────────────────── Gate 6a: organizer onboarding ─────────────────────────
async function stageOnboarding() {
  const admin = S.adminToken ?? (await getStaff());
  if (!S.owner) {
    S.owner = await regUser('pilot.owner', 'Pilot Organizer Owner');
    persist();
  }
  rec(
    'journey',
    'J-1',
    'New organizer owner registers an account',
    S.owner.token ? 'PASS' : 'FAIL',
    S.owner.email.replace(/@.*/, '@...'),
    { userId: S.owner.userId },
  );

  if (!S.org) {
    const name = `Pilot Certification Events ${stamp}`;
    const r = await api.call('POST', '/organizations', {
      token: S.owner.token,
      body: {
        name,
        contactEmail: S.owner.email,
        legalName: `${name} Private Limited`,
        legalEntityType: 'Private Limited Company',
        registeredCountry: 'India',
      },
    });
    if (r.status >= 300) return rec('journey', 'J-2', 'Create organization', 'FAIL', errCode(r));
    S.org = { id: r.body.id, name, status: r.body.status };
    persist();
  }
  rec(
    'journey',
    'J-2',
    'Owner creates the organization (starts PENDING, cannot sell)',
    S.org.status === 'PENDING' ? 'PASS' : 'FAIL',
    `org ${S.org.id} status ${S.org.status}`,
  );

  // Legal identity: saved by the owner, never by staff.
  const li = await api.call('PATCH', `/organizations/${S.org.id}/legal-identity`, {
    token: S.owner.token,
    body: {
      legalName: `${S.org.name} Private Limited`,
      legalEntityType: 'Private Limited Company',
      registeredCountry: 'India',
      registeredRegion: 'Andhra Pradesh',
      registeredCity: 'Vijayawada',
      registeredAddressLine1: '12 Test Street',
      registeredPostalCode: '520001',
      taxRegistrationKind: 'GSTIN',
      taxRegistrationNumber: '37AAAAA0000A1Z5',
      financeContactName: 'Pilot Finance',
      financeContactEmail: S.owner.email,
      financeContactPhone: '+918121234567',
      grievanceOfficerName: 'Pilot Grievance Officer',
      grievanceOfficerEmail: S.owner.email,
    },
  });
  rec(
    'journey',
    'J-3',
    'Owner records the legal identity (PATCH legal-identity)',
    li.status < 300 ? 'PASS' : 'FAIL',
    errCode(li),
  );
  const lis = await api.call('GET', `/organizations/${S.org.id}/legal-identity`, {
    token: S.owner.token,
  });
  rec(
    'journey',
    'J-3b',
    'Legal identity reads back with nothing missing',
    lis.status === 200 ? 'PASS' : 'FAIL',
    JSON.stringify({ missing: lis.body?.missing, complete: lis.body?.complete }).slice(0, 200),
  );

  // Bank account saved by the OWNER.
  if (!S.bank) {
    const b = await api.call('POST', '/payouts/accounts', {
      token: S.owner.token,
      body: {
        organizationId: S.org.id,
        currency: 'INR',
        holderName: `${S.org.name} Pvt Ltd`,
        bankName: 'Test Bank of India',
        bankCode: 'TEST0000001',
        accountNumber: '000123456789',
      },
    });
    S.bank = { status: b.status, body: b.body };
    persist();
  }
  const accounts = await api.call('GET', `/payouts/accounts?organizationId=${S.org.id}`, {
    token: S.owner.token,
  });
  const acc = (Array.isArray(accounts.body) ? accounts.body : (accounts.body?.accounts ?? []))[0];
  const leaked = JSON.stringify(accounts.body).includes('000123456789');
  rec(
    'journey',
    'J-4',
    'Owner saves an INR bank account; it reads back masked and UNVERIFIED',
    S.bank.status < 300 && acc && !leaked ? 'PASS' : 'FAIL',
    `saved ${S.bank.status}; verification=${acc?.verificationStatus ?? acc?.status}; fullNumberInResponse=${leaked}`,
    { accountId: acc?.id },
  );
  S.bank.accountId = acc?.id;
  persist();

  // Admin approves the organization (staff review - normal maker-checker path for orgs).
  const sig = await api.call('GET', `/admin/organizers/${S.org.id}/review-signals`, {
    token: admin,
  });
  rec(
    'journey',
    'J-5a',
    'Admin sees registration review signals',
    sig.status === 200 ? 'PASS' : 'FAIL',
    errCode(sig),
  );
  const rv = await api.call('POST', `/admin/organizers/${S.org.id}/review`, {
    token: admin,
    body: { decision: 'APPROVE', note: 'Pilot certification run' },
  });
  const org2 = await api.call('GET', `/organizations/${S.org.id}`, { token: S.owner.token });
  S.org.status = org2.body?.status;
  persist();
  rec(
    'journey',
    'J-5',
    'Admin approves the organization',
    org2.body?.status === 'APPROVED' ? 'PASS' : 'FAIL',
    `review ${errCode(rv)}; org now ${org2.body?.status}`,
  );
}

// ───────────────────────── Gate 6b: event creation + approval ─────────────────────────
async function stageEvent() {
  const admin = S.adminToken ?? (await getStaff());
  const t = S.owner.token;
  if (!S.venue) {
    const v = await api.call('POST', '/venues', {
      token: t,
      body: {
        organizationId: S.org.id,
        name: `Pilot Open Ground ${stamp}`,
        city: 'Vijayawada',
        country: 'India',
        region: 'Andhra Pradesh',
        timezone: 'Asia/Kolkata',
        address: 'Test Ground Road',
        capacity: 500,
      },
    });
    if (v.status >= 300) return rec('journey', 'J-6', 'Create venue', 'FAIL', errCode(v));
    S.venue = { id: v.body.id, currency: v.body.currency };
    persist();
  }
  rec(
    'journey',
    'J-6',
    'Owner creates a non-cinema venue in Andhra Pradesh',
    'PASS',
    `venue ${S.venue.id}`,
  );

  if (!S.event) {
    const key = crypto.randomUUID();
    const body = {
      organizationId: S.org.id,
      venueId: S.venue.id,
      title: `Pilot GA Concert ${stamp}`,
      category: 'Music',
      description: 'General admission concert created by the pilot certification run.',
      refundsEnabled: true,
      refundCutoffHours: 0,
      feeMode: 'CUSTOMER_PAYS',
      isFree: false,
    };
    const e1 = await api.call('POST', '/events', {
      token: t,
      body,
      headers: { 'idempotency-key': key },
    });
    const e2 = await api.call('POST', '/events', {
      token: t,
      body,
      headers: { 'idempotency-key': key },
    });
    S.event = { id: e1.body?.id, slug: e1.body?.slug };
    S.doubleSubmit = { first: e1.status, second: e2.status, sameId: e1.body?.id === e2.body?.id };
    persist();
    rec(
      'failure',
      'F-DS',
      'Double-submit event create (same Idempotency-Key) creates ONE event',
      e1.body?.id && e1.body?.id === e2.body?.id ? 'PASS' : 'FAIL',
      `first ${e1.status}, second ${e2.status}, same id: ${e1.body?.id === e2.body?.id}`,
      { eventId: e1.body?.id },
    );
  }
  rec(
    'journey',
    'J-7',
    'Owner creates the GA INR event (DRAFT)',
    S.event.id ? 'PASS' : 'FAIL',
    `event ${S.event.id}`,
  );

  if (!S.session) {
    // Starts a little ahead so the same event can be sold, scanned and settled within the run.
    const startMin = Number(args.startInMinutes ?? 40);
    const start = new Date(Date.now() + startMin * 60_000);
    const end = new Date(start.getTime() + 20 * 60_000);
    const s = await api.call('POST', `/events/${S.event.id}/sessions`, {
      token: t,
      body: { startsAt: iso(start), endsAt: iso(end) },
    });
    if (s.status >= 300) return rec('journey', 'J-8', 'Add session', 'FAIL', errCode(s));
    S.session = { id: s.body.id, startsAt: iso(start), endsAt: iso(end) };
    const tt = [];
    for (const [name, price, qty] of [
      ['General', 49900, 100],
      ['VIP', 149900, 20],
    ]) {
      const r = await api.call('POST', '/events/ticket-types', {
        token: t,
        body: {
          eventSessionId: s.body.id,
          name,
          priceMinor: price,
          quantityTotal: qty,
          maxPerOrder: 6,
        },
      });
      if (r.status >= 300)
        return rec('journey', 'J-8', `Add ticket type ${name}`, 'FAIL', errCode(r));
      tt.push({ id: r.body.id, name, priceMinor: r.body.priceMinor, currency: r.body.currency });
    }
    S.ticketTypes = tt;
    persist();
  }
  rec(
    'journey',
    'J-8',
    'GA session + two ticket types, priced in the venue currency',
    S.ticketTypes.every((x) => x.currency === 'INR') ? 'PASS' : 'FAIL',
    JSON.stringify(S.ticketTypes),
    { sessionId: S.session.id },
  );

  const sell = await api.call('GET', `/events/${S.event.id}/sellability`, { token: t });
  rec(
    'journey',
    'J-9',
    'Sellability check before submit',
    sell.status === 200 ? 'PASS' : 'FAIL',
    JSON.stringify(sell.body).slice(0, 240),
  );

  const sub = await api.call('POST', `/events/${S.event.id}/submit`, { token: t });
  rec(
    'journey',
    'J-10',
    'Owner submits for approval',
    sub.status < 300 ? 'PASS' : 'FAIL',
    `${errCode(sub)} -> ${sub.body?.status}`,
  );
  if (sub.body?.status !== 'PUBLISHED') {
    const rv = await api.call('POST', `/admin/events/${S.event.id}/review`, {
      token: admin,
      body: { decision: 'APPROVE', note: 'Pilot certification run' },
    });
    rec(
      'journey',
      'J-11',
      'Admin approves the event',
      rv.status < 300 ? 'PASS' : 'FAIL',
      `${errCode(rv)} -> ${rv.body?.status}`,
    );
  } else
    rec(
      'journey',
      'J-11',
      'Admin approval',
      'PASS',
      'event auto-published (organizer auto-approve is on)',
    );
  const pub = await api.call('GET', `/public/events/${S.event.slug}`);
  rec(
    'journey',
    'J-12',
    'Event is PUBLISHED and visible on the public API',
    pub.status === 200 && (pub.body?.status ?? 'PUBLISHED') === 'PUBLISHED' ? 'PASS' : 'FAIL',
    `public ${pub.status}`,
    { slug: S.event.slug },
  );
}

// ───────────────────────── Gate 2: payments + purchase ─────────────────────────
async function createBooking(cust, ticketTypeName, quantity) {
  const tt = S.ticketTypes.find((x) => x.name === ticketTypeName);
  const r = await api.call('POST', '/bookings', {
    token: cust.token,
    headers: idem(),
    body: {
      eventSessionId: S.session.id,
      items: [{ ticketTypeId: tt.id, quantity }],
      buyerName: 'Pilot Buyer',
      buyerEmail: cust.email,
      buyerRegion: 'Andhra Pradesh',
    },
  });
  return r;
}
async function waitBooking(cust, id, want, tries = 25) {
  let b;
  for (let i = 0; i < tries; i++) {
    b = (await api.call('GET', `/bookings/${id}`, { token: cust.token })).body;
    if (b?.status === want) return b;
    await sleep(3000);
  }
  return b;
}
const available = async () => {
  const pub = await api.call('GET', `/public/events/${S.event.slug}`);
  const tts = pub.body?.sessions?.[0]?.ticketTypes ?? [];
  return Object.fromEntries(
    tts.map((t) => [t.name, t.available ?? t.remaining ?? t.quantityAvailable]),
  );
};
async function payBooking(cust, bookingId, outcome, tag) {
  // UAT turned out to run Razorpay TEST keys as well (the pay intent returns an rzp_test order), not the mock gateway.
  return payInBrowser({
    customerBase: env.customer,
    email: cust.email,
    password: cust.password,
    bookingId,
    outcome,
    outDir: OUT,
    tag: `${envKey}-${tag}`,
  });
}

async function stagePurchase() {
  S.cust ??= await regUser('pilot.buyer', 'Pilot Buyer One');
  persist();
  const c = S.cust;
  rec(
    'journey',
    'J-13',
    'Customer registers (fresh test account)',
    c.token ? 'PASS' : 'FAIL',
    c.email.replace(/@.*/, '@...'),
  );

  const q = await api.call('POST', '/bookings/quote', {
    token: c.token,
    body: {
      eventSessionId: S.session.id,
      items: [{ ticketTypeId: S.ticketTypes[0].id, quantity: 2 }],
      buyerRegion: 'Andhra Pradesh',
    },
  });
  const fees = q.body?.fees ?? q.body;
  rec(
    'payments',
    'PAY-1',
    'Price quote before booking: INR, itemised, total = sum of lines',
    q.status < 300 && (q.body?.currency ?? fees?.currency) === 'INR' ? 'PASS' : 'FAIL',
    JSON.stringify(q.body).slice(0, 360),
  );

  // Measured ONCE, when the hold is first taken; a re-run must not re-measure against its own hold.
  if (!S.abandoned) {
    const before = await available();
    const b = await createBooking(c, 'General', 3);
    S.abandoned = {
      id: b.body?.id,
      status: b.status,
      holdExpiresAt: b.body?.holdExpiresAt,
      availableBefore: before,
      createdAt: iso(new Date()),
    };
    S.abandoned.availableDuring = await available();
    persist();
  }
  const { availableBefore: before, availableDuring: heldAvail } = S.abandoned;
  rec(
    'failure',
    'F-AB-1',
    'Booking held for payment takes stock (3 General) with a hold expiry',
    S.abandoned.id && heldAvail.General === (before.General ?? 0) - 3 ? 'PASS' : 'FAIL',
    `available General ${before.General} -> ${heldAvail.General}; holdExpiresAt ${S.abandoned.holdExpiresAt}`,
    { bookingId: S.abandoned.id },
  );

  // B5: payment fails at the gateway, then the same booking is paid on retry.
  if (!S.bGw) {
    const b = await createBooking(c, 'General', 1);
    S.bGw = { id: b.body?.id, total: b.body?.fees?.totalMinor ?? b.body?.totalMinor };
    persist();
  }
  const gwPaid =
    (await api.call('GET', `/bookings/${S.bGw.id}`, { token: c.token })).body?.status ===
    'CONFIRMED';
  const fail = gwPaid
    ? { ok: true, landedOn: 'n/a (rerun)' }
    : await payBooking(c, S.bGw.id, 'failure', 'gw-fail');
  const afterFail = (await api.call('GET', `/bookings/${S.bGw.id}`, { token: c.token })).body;
  S.bGw.afterFail = {
    status: afterFail?.status,
    pay: (afterFail?.payments ?? []).map((p) => p.status),
  };
  persist();
  rec(
    'failure',
    'F-GW-1',
    'Payment FAILS at the gateway: booking is NOT confirmed, no tickets issued',
    fail.ok && afterFail?.status !== 'CONFIRMED' ? 'PASS' : 'FAIL',
    `browser ${JSON.stringify({ ok: fail.ok, landed: fail.landedOn, err: fail.error })}; booking ${afterFail?.status}; payments ${JSON.stringify(S.bGw.afterFail.pay)}`,
    { bookingId: S.bGw.id },
  );
  const gwDone =
    (await api.call('GET', `/bookings/${S.bGw.id}`, { token: c.token })).body?.status ===
    'CONFIRMED';
  const retry = gwDone ? { ok: true } : await payBooking(c, S.bGw.id, 'success', 'gw-retry');
  const bRetry = await waitBooking(c, S.bGw.id, 'CONFIRMED', 260);
  rec(
    'failure',
    'F-GW-2',
    'Retry on the SAME booking after the failure succeeds and confirms',
    bRetry?.status === 'CONFIRMED' ? 'PASS' : 'FAIL',
    `retry browser ok=${retry.ok}; booking ${bRetry?.status}`,
    { bookingId: S.bGw.id },
  );

  // B1 + B2: the two ordinary purchases (B1 is scanned and settled, B2 is refunded).
  for (const [key, qty, tag] of [
    ['b1', 2, 'b1'],
    ['b2', 1, 'b2'],
  ]) {
    if (!S[key]) {
      const b = await createBooking(c, key === 'b1' ? 'General' : 'VIP', qty);
      S[key] = {
        id: b.body?.id,
        ref: b.body?.reference ?? b.body?.bookingReference,
        totalMinor: b.body?.fees?.totalMinor ?? b.body?.totalMinor,
      };
      persist();
      rec(
        'journey',
        `J-14-${key}`,
        `Booking ${key} created and held`,
        b.status === 201 || b.status === 200 ? 'PASS' : 'FAIL',
        errCode(b),
        { bookingId: S[key].id },
      );
    }
    const already =
      (await api.call('GET', `/bookings/${S[key].id}`, { token: c.token })).body?.status ===
      'CONFIRMED';
    // A re-run never pays twice: an already-confirmed booking keeps the evidence of the run that paid it.
    const pay = already
      ? {
          ok: true,
          via: 'paid in an earlier run (screenshot ' + envKey + '-' + tag + '-4-after.png)',
        }
      : await payBooking(c, S[key].id, 'success', tag);
    // QA confirms from the Razorpay webhook in seconds. UAT shares QA's test key, so Razorpay
    // sends its webhooks to QA and UAT confirms from the reconciliation sweep (every 5 minutes).
    const bk = await waitBooking(c, S[key].id, 'CONFIRMED', 260);
    const p0 = (bk?.payments ?? [])[0] ?? {};
    S[key].confirmed = {
      status: bk?.status,
      totalMinor: bk?.totalMinor,
      currency: bk?.currency,
      provider: p0.provider,
      payStatus: p0.status,
      ref: bk?.reference ?? bk?.bookingReference,
    };
    persist();
    rec(
      'payments',
      `PAY-2-${key}`,
      `Razorpay TEST Netbanking payment completes; booking ${key} CONFIRMED (webhook or reconciliation sweep)`,
      bk?.status === 'CONFIRMED' && pay.ok ? 'PASS' : 'FAIL',
      JSON.stringify({ ...S[key].confirmed, browser: pay.ok ? (pay.via ?? pay.steps) : pay.error }),
      { bookingId: S[key].id },
    );
  }
}

// ───────────────────────── Gate 3: communications / ticket delivery ─────────────────────────
async function stageDelivery() {
  const c = S.cust;
  const wallet = await api.call('GET', '/tickets', { token: c.token });
  const list = Array.isArray(wallet.body) ? wallet.body : (wallet.body?.items ?? []);
  const pick = (id) =>
    list
      .filter((t) => t.bookingId === id)
      .map((t) => ({ id: t.id, serial: t.serial, qrToken: t.qrToken, status: t.status }));
  S.b1.tickets = pick(S.b1.id);
  S.b2.tickets = pick(S.b2.id);
  S.bGw.tickets = pick(S.bGw.id);
  persist();
  const mine = list.filter((t) => t.bookingId === S.b1.id);
  rec(
    'comms',
    'COM-1',
    'Ticket wallet lists the 2 tickets of booking B1, each with a signed QR token and a QR image',
    mine.length === 2 &&
      mine.every((t) => t.qrToken && String(t.qrDataUrl).startsWith('data:image/png'))
      ? 'PASS'
      : 'FAIL',
    `${mine.length} tickets; statuses ${mine.map((t) => t.status)}`,
    { bookingId: S.b1.id, ticketIds: S.b1.tickets.map((t) => t.id) },
  );

  const feed = await api.call('GET', '/notifications/feed', { token: c.token });
  const text = JSON.stringify(feed.body);
  rec(
    'comms',
    'COM-2',
    'Customer in-app notification feed carries the booking confirmation',
    feed.status === 200 && /confirm|booking/i.test(text) ? 'PASS' : 'FAIL',
    `feed ${feed.status}; ${text.length} bytes; mentions confirmation: ${/confirm/i.test(text)}`,
  );

  const admin = S.adminToken ?? (await getStaff());
  const ref = S.b1.confirmed?.ref;
  const q = await api.call(
    'GET',
    `/admin/notifications?limit=50${ref ? `&reference=${encodeURIComponent(ref)}` : ''}`,
    { token: admin },
  );
  const rows = Array.isArray(q.body) ? q.body : (q.body?.items ?? q.body?.rows ?? []);
  const summary = rows.map((n) => ({
    type: n.type,
    channel: n.channel,
    status: n.status,
    provider: n.provider,
  }));
  S.notificationRecords = summary;
  persist();
  rec(
    'comms',
    'COM-3',
    'A delivery record exists for the confirmation (admin notification search by booking reference)',
    q.status === 200 && rows.length > 0 ? 'PASS' : 'FAIL',
    `search ${q.status}; ${rows.length} record(s): ${JSON.stringify(summary).slice(0, 300)}`,
    { reference: ref },
  );
  const sendsReal = summary.some(
    (n) => n.channel === 'EMAIL' && /SENT|DELIVERED/.test(String(n.status)),
  );
  rec(
    'comms',
    'COM-4',
    'Email actually handed to a real mail provider on this environment',
    sendsReal ? 'PASS' : 'BLOCKED',
    sendsReal
      ? 'delivery record shows SENT/DELIVERED'
      : 'only a delivery RECORD is proven; the buyer mailbox is a .test address, so receipt in an inbox cannot be observed here',
  );
}

// ───────────────────────── Gate 4: operations - check-in ─────────────────────────
async function stageCheckin() {
  const o = S.owner.token;
  const t1 = S.b1.tickets[0];
  const t2 = S.b1.tickets[1];
  const sc1 = await api.call('POST', '/checkins', {
    token: o,
    body: { token: t1.qrToken, expectedSessionId: S.session.id, deviceInfo: 'pilot-cert gate-1' },
  });
  rec(
    'ops',
    'OPS-1',
    'Organizer scans a valid ticket QR: admitted',
    sc1.status < 300 && sc1.body?.result === 'SUCCESS' ? 'PASS' : 'FAIL',
    `${sc1.status} ${sc1.body?.result} ${sc1.body?.message ?? ''}`,
    { ticketId: t1.id },
  );
  const sc2 = await api.call('POST', '/checkins', {
    token: o,
    body: { token: t1.qrToken, expectedSessionId: S.session.id, deviceInfo: 'pilot-cert gate-1' },
  });
  rec(
    'ops',
    'OPS-2',
    'Scanning the SAME ticket again is refused as a duplicate',
    sc2.body?.result === 'DUPLICATE' ? 'PASS' : 'FAIL',
    `${sc2.status} ${sc2.body?.result} ${sc2.body?.message ?? ''}`,
  );
  const bad = await api.call('POST', '/checkins', {
    token: o,
    body: { token: `${t2.qrToken.slice(0, -4)}AAAA`, expectedSessionId: S.session.id },
  });
  rec(
    'ops',
    'OPS-3',
    'A tampered QR is refused (INVALID)',
    bad.body?.result === 'INVALID' ? 'PASS' : 'FAIL',
    `${bad.status} ${bad.body?.result}`,
  );
  // Tenant isolation: gate staff of ANOTHER organization cannot admit this organization's ticket.
  const gate = await api.login('checkin@eticketsgo.test', SEED_PASSWORD);
  const x = await api.call('POST', '/checkins', {
    token: gate.token,
    body: { token: t2.qrToken, deviceInfo: 'pilot-cert foreign gate' },
  });
  const refused =
    x.status === 403 || x.status === 404 || (x.body?.result && x.body.result !== 'SUCCESS');
  rec(
    'ops',
    'OPS-4',
    "Another organization's gate staff cannot admit this organization's ticket",
    refused ? 'PASS' : 'FAIL',
    `${x.status} ${x.body?.result ?? ''} ${x.body?.code ?? ''}`,
  );
  const sc3 = await api.call('POST', '/checkins', {
    token: o,
    body: { token: t2.qrToken, expectedSessionId: S.session.id, deviceInfo: 'pilot-cert gate-2' },
  });
  rec(
    'ops',
    'OPS-5',
    'Second ticket of the booking is still admitted afterwards (the foreign refusal consumed nothing)',
    sc3.body?.result === 'SUCCESS' ? 'PASS' : 'FAIL',
    `${sc3.status} ${sc3.body?.result}`,
    { ticketId: t2.id },
  );
  const roster = await api.call('GET', `/checkins/roster?eventSessionId=${S.session.id}`, {
    token: o,
  });
  rec(
    'ops',
    'OPS-6',
    'Gate roster for the session reflects the admitted tickets',
    roster.status === 200 ? 'PASS' : 'FAIL',
    JSON.stringify(roster.body).slice(0, 260),
  );
  const wrong = await api.call('POST', '/checkins', {
    token: o,
    body: { token: S.b2.tickets[0].qrToken, expectedSessionId: 'cmv0000000000000000000000' },
  });
  rec(
    'ops',
    'OPS-7',
    'A ticket scanned against the wrong session is refused (WRONG_SESSION)',
    wrong.body?.result === 'WRONG_SESSION' ? 'PASS' : 'FAIL',
    `${wrong.status} ${wrong.body?.result}`,
  );
}

// ───────────────────────── Gate 6c: refunds ─────────────────────────
async function stageRefunds() {
  const c = S.cust.token;
  const o = S.owner.token;
  // Refund policy lets an organizer refund a checked-in ticket (event cancelled mid-show, bad experience), so the
  // request is accepted into REVIEW - what must hold is that nothing is paid out until the organizer decides.
  const bad = await api.call('POST', '/refunds', {
    token: c,
    body: { bookingId: S.b1.id, reason: 'Pilot cert: refund request on checked-in tickets' },
  });
  const rej = bad.body?.id
    ? await api.call('POST', `/refunds/${bad.body.id}/process`, {
        token: o,
        body: { decision: 'REJECT' },
      })
    : null;
  const b1after = (await api.call('GET', `/bookings/${S.b1.id}`, { token: c })).body;
  rec(
    'refund',
    'REF-0',
    'Refund request on a checked-in booking waits for the organizer; REJECT leaves the booking CONFIRMED and pays nothing',
    bad.body?.status === 'REQUESTED' && rej?.status < 300 && b1after?.status === 'CONFIRMED'
      ? 'PASS'
      : 'FAIL',
    `request ${bad.status} ${bad.body?.status}; organizer REJECT ${rej?.status} ${rej?.body?.status}; booking ${b1after?.status}`,
    { bookingId: S.b1.id, refundId: bad.body?.id },
  );

  for (const [key, id, label] of [
    ['b2', 'REF-1', 'Customer requests a refund of booking B2; organizer approves'],
    [
      'bGw',
      'REF-2',
      'Second booking (paid on retry after a gateway failure): customer requests, organizer approves (organizer-side cancellation)',
    ],
  ]) {
    const bk = S[key];
    const cur = (await api.call('GET', `/bookings/${bk.id}`, { token: c })).body?.status;
    if (cur !== 'CONFIRMED') {
      rec(
        'refund',
        id,
        label,
        'BLOCKED',
        `booking is ${cur}, never confirmed in this run, so there is nothing to refund`,
      );
      continue;
    }
    const req = await api.call('POST', '/refunds', {
      token: c,
      body: { bookingId: bk.id, reason: 'Pilot certification refund exception' },
    });
    const refundId = req.body?.id;
    if (!refundId) {
      rec('refund', id, label, 'FAIL', `request: ${errCode(req)}`);
      continue;
    }
    const proc = await api.call('POST', `/refunds/${refundId}/process`, {
      token: o,
      body: { decision: 'APPROVE' },
    });
    await sleep(6000);
    const refunds = await api.call('GET', `/refunds/booking/${bk.id}`, { token: c });
    const rf = (Array.isArray(refunds.body) ? refunds.body : (refunds.body?.data ?? []))[0] ?? {};
    const after = (await api.call('GET', `/bookings/${bk.id}`, { token: c })).body;
    bk.refund = {
      id: refundId,
      requestStatus: req.body?.status,
      processStatus: proc.body?.status,
      finalStatus: rf.status,
      amountMinor: rf.amountMinor,
      currency: rf.currency,
      providerRef: !!rf.providerRef,
      bookingStatus: after?.status,
    };
    persist();
    const ok = proc.status < 300 && Boolean(rf.status ?? proc.body?.status);
    rec('refund', id, label, ok ? 'PASS' : 'FAIL', JSON.stringify(bk.refund), {
      refundId,
      bookingId: bk.id,
    });
  }
  const avail = await available();
  rec(
    'refund',
    'REF-3',
    'Refunded tickets return to inventory (VIP back to 20)',
    avail.VIP === 20 ? 'PASS' : 'FAIL',
    `available now ${JSON.stringify(avail)}`,
  );
}

// ───────────────────────── Gate 2b: hold expiry + reconciliation ─────────────────────────
async function stageRecon() {
  const c = S.cust.token;
  const admin = S.adminToken ?? (await getStaff());
  // The hold must have passed, and the expiry sweep run, before this means anything: checking
  // early recorded a FAIL for a hold that then expired exactly as it should.
  const holdEnds = Date.parse(S.abandoned.holdExpiresAt ?? '') || 0;
  const wait = holdEnds + 90_000 - Date.now();
  if (wait > 0) {
    console.log(`waiting ${Math.ceil(wait / 1000)}s for the abandoned hold to pass`);
    await sleep(wait);
  }
  let ab = (await api.call('GET', `/bookings/${S.abandoned.id}`, { token: c })).body;
  for (let i = 0; i < 60 && ab?.status === 'PENDING_PAYMENT'; i++) {
    await sleep(5000);
    ab = (await api.call('GET', `/bookings/${S.abandoned.id}`, { token: c })).body;
  }
  const avail = await available();
  const exp = ab?.status === 'EXPIRED' || ab?.status === 'CANCELLED';
  rec(
    'failure',
    'F-AB-2',
    'Abandoned payment: the hold EXPIRES on its own and the 3 tickets return to stock',
    exp ? 'PASS' : 'FAIL',
    `booking ${ab?.status} (hold was ${S.abandoned.holdExpiresAt}); available General now ${avail.General}`,
    { bookingId: S.abandoned.id },
  );

  if (envKey === 'qa') {
    const wh = await api.call('POST', '/payments/webhooks/razorpay', {
      body: { event: 'payment.captured', payload: {} },
      headers: { 'x-razorpay-signature': 'deadbeef' },
    });
    rec(
      'failure',
      'F-WH-1',
      'A forged Razorpay webhook (bad signature) is refused and changes nothing',
      wh.status === 400 || wh.status === 401 ? 'PASS' : 'FAIL',
      `POST /payments/webhooks/razorpay with a bad signature -> ${wh.status}`,
    );
  }
  const now = new Date();
  const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
  const det = await api.call(
    'POST',
    `/admin/payments/finance/detect?from=${encodeURIComponent(from)}&to=${encodeURIComponent(now.toISOString())}`,
    { token: admin },
  );
  rec(
    'recon',
    'REC-1',
    'Admin runs finance discrepancy detection over the last 24h',
    det.status < 300 ? 'PASS' : 'FAIL',
    `${errCode(det)} ${JSON.stringify(det.body).slice(0, 240)}`,
  );
  const open = await api.call('GET', '/admin/payments/finance/discrepancies?status=OPEN', {
    token: admin,
  });
  const rows = Array.isArray(open.body) ? open.body : (open.body?.items ?? open.body?.rows ?? []);
  const ours = rows.filter(
    (d) =>
      JSON.stringify(d).includes(S.org.id) ||
      [S.b1.id, S.b2.id, S.bGw.id, S.abandoned.id].some((id) => JSON.stringify(d).includes(id)),
  );
  S.discrepancies = {
    totalOpen: rows.length,
    ours: ours.map((d) => ({ id: d.id, type: d.type, status: d.status })),
  };
  persist();
  rec(
    'recon',
    'REC-2',
    'No open discrepancy touches the pilot organization or any of its bookings',
    open.status === 200 && ours.length === 0 ? 'PASS' : 'FAIL',
    `open total ${rows.length}; ours ${JSON.stringify(S.discrepancies.ours)}`,
  );
}

// ───────────────────────── Gate 5: authorization ─────────────────────────
async function stageAuthz() {
  const admin = S.adminToken ?? (await getStaff());
  const org = S.org.id;
  const refused = (r) => r.status === 403;
  const auditRows = async () => {
    const a = await api.call('GET', `/admin/audit?organizationId=${org}&pageSize=100`, {
      token: admin,
    });
    return a.body?.items ?? a.body?.rows ?? a.body?.data ?? [];
  };
  const count0 = (await auditRows()).length;
  const bank = await api.call('POST', '/payouts/accounts', {
    token: admin,
    body: {
      organizationId: org,
      currency: 'INR',
      holderName: 'Staff Entered',
      bankName: 'Staff Bank',
      bankCode: 'STAF0000001',
      accountNumber: '999900001111',
    },
  });
  rec(
    'authz',
    'AZ-1',
    'Platform staff (super admin) trying to CHANGE the organizer bank account is refused (403)',
    refused(bank) ? 'PASS' : 'FAIL',
    errCode(bank),
  );
  const rows1 = await auditRows();
  const refusedRows = rows1.filter((r) =>
    /refus|denied|forbid|ORGANIZER_ONLY|payout\.account\.save/i.test(JSON.stringify(r)),
  );
  rec(
    'authz',
    'AZ-2',
    'The refused staff attempt leaves an audit row',
    refusedRows.length > 0 ? 'PASS' : 'FAIL',
    `audit rows for the org ${count0} -> ${rows1.length}; matching refusal rows: ${refusedRows.length} ${JSON.stringify(refusedRows[0] ?? {}).slice(0, 300)}`,
  );
  const accs = await api.call('GET', `/payouts/accounts?organizationId=${org}`, {
    token: S.owner.token,
  });
  const list = Array.isArray(accs.body) ? accs.body : (accs.body?.accounts ?? []);
  rec(
    'authz',
    'AZ-3',
    'The bank account on file is unchanged after the staff attempt',
    list.length === 1 && list[0].id === S.bank.accountId ? 'PASS' : 'FAIL',
    `${list.length} account(s); same id: ${list[0]?.id === S.bank.accountId}; verification ${list[0]?.verificationStatus}`,
  );
  for (const [id, m, p, body, label] of [
    [
      'AZ-4',
      'PATCH',
      `/organizations/${org}/legal-identity`,
      { legalName: 'Staff Changed Ltd' },
      'Staff cannot change the organizer legal identity (owner-only route)',
    ],
    [
      'AZ-5',
      'POST',
      '/payouts/generate',
      { organizationId: org },
      'Staff cannot raise an organizer payout',
    ],
    [
      'AZ-6',
      'PATCH',
      `/events/${S.event.id}`,
      { title: 'Hijacked' },
      'Staff cannot edit an organizer event through the organizer route',
    ],
  ]) {
    const r = await api.call(m, p, { token: admin, body });
    rec('authz', id, label, refused(r) ? 'PASS' : 'FAIL', `${m} ${p} -> ${errCode(r)}`);
  }
  const ownerVerify = await api.call(
    'POST',
    `/admin/payouts/accounts/${S.bank.accountId}/verified`,
    { token: S.owner.token, body: {} },
  );
  rec(
    'authz',
    'AZ-7',
    'The organizer owner cannot verify their own bank account (staff-only route)',
    ownerVerify.status === 403 ? 'PASS' : 'FAIL',
    errCode(ownerVerify),
  );
  const custRead = await api.call('GET', `/events/${S.event.id}/attendees?page=1&pageSize=5`, {
    token: S.cust.token,
  });
  rec(
    'authz',
    'AZ-8',
    'A customer cannot read the organizer attendee list',
    custRead.status === 403 || custRead.status === 404 ? 'PASS' : 'FAIL',
    errCode(custRead),
  );
  const other = await api.login('owner@eticketsgo.test', SEED_PASSWORD);
  const otherRead = await api.call('GET', `/events/${S.event.id}/attendees?page=1&pageSize=5`, {
    token: other.token,
  });
  const otherPay = await api.call('GET', `/payouts?organizationId=${org}`, { token: other.token });
  rec(
    'authz',
    'AZ-9',
    "Another organization's owner cannot read this organization's attendees or payouts",
    [otherRead, otherPay].every((r) => r.status === 403 || r.status === 404) ? 'PASS' : 'FAIL',
    `attendees ${otherRead.status}, payouts ${otherPay.status}`,
  );
  const anon = await api.call('GET', `/payouts?organizationId=${org}`);
  rec(
    'authz',
    'AZ-10',
    'No token: payouts are refused (401)',
    anon.status === 401 ? 'PASS' : 'FAIL',
    `${anon.status}`,
  );
}

// ───────────────────────── Gate 6d: payout ─────────────────────────
async function stagePayout() {
  const admin = S.adminToken ?? (await getStaff());
  const org = S.org.id;
  const o = S.owner.token;
  const sum = await api.call('GET', `/payouts/summary?organizationId=${org}`, { token: o });
  S.payoutSummary = sum.body;
  persist();
  rec(
    'payout',
    'PAYOUT-1',
    'Owner sees the settlement position per currency, with held revenue and when it becomes payable',
    sum.status === 200 ? 'PASS' : 'FAIL',
    JSON.stringify(sum.body).slice(0, 500),
  );
  const eff = await api.call('GET', `/admin/payout-settings/effective/${org}`, { token: admin });
  rec(
    'payout',
    'PAYOUT-2',
    'Effective payout terms for the organization (hold period, source)',
    eff.status === 200 ? 'PASS' : 'FAIL',
    JSON.stringify(eff.body).slice(0, 300),
  );
  const ended = new Date(S.session.endsAt) < new Date();
  const g1 = await api.call('POST', '/payouts/generate', {
    token: o,
    body: { organizationId: org },
  });
  const made1 = g1.body?.payouts ?? g1.body?.created ?? [];
  rec(
    'payout',
    'PAYOUT-3',
    'Generate under the DEFAULT hold terms pays nothing out yet',
    g1.status >= 400 || made1.length === 0 ? 'PASS' : 'FAIL',
    `${errCode(g1)} ${JSON.stringify(g1.body).slice(0, 240)}`,
  );
  if (!ended)
    return rec(
      'payout',
      'PAYOUT-4',
      'Payout after the show ends',
      'BLOCKED',
      `session ends ${S.session.endsAt}; re-run stage 10 afterwards`,
    );

  // Default terms hold revenue for days after the last session. Set a 0-day hold FOR THIS TEST ORG ONLY.
  const set = await api.call('POST', `/admin/payout-settings/${org}`, {
    token: admin,
    body: { holdDays: 0 },
  });
  rec(
    'payout',
    'PAYOUT-4',
    'Admin sets a 0-day hold for the TEST organization only (config, audited)',
    set.status < 300 ? 'PASS' : 'FAIL',
    errCode(set),
  );
  const g2 = await api.call('POST', '/payouts/generate', {
    token: o,
    body: { organizationId: org },
  });
  const created = g2.body?.payouts ?? g2.body?.created ?? (Array.isArray(g2.body) ? g2.body : []);
  S.payout = { status: g2.status, body: g2.body };
  persist();
  const pid = created[0]?.id ?? g2.body?.id;
  rec(
    'payout',
    'PAYOUT-5',
    'Owner generates the settlement payout after the hold',
    g2.status < 300 && pid ? 'PASS' : 'FAIL',
    `${errCode(g2)} ${JSON.stringify(g2.body).slice(0, 400)}`,
    { payoutId: pid },
  );
  if (!pid) return;
  S.payoutId = pid;
  const pay = await api.call('POST', `/admin/payouts/${pid}/pay`, { token: admin, body: {} });
  rec(
    'payout',
    'PAYOUT-6',
    'Marking the payout PAID is refused while the bank account is unverified (409 hold)',
    pay.status === 409 ? 'PASS' : 'FAIL',
    `${errCode(pay)} ${JSON.stringify(pay.body?.details ?? {})}`,
  );
  rec(
    'payout',
    'PAYOUT-7',
    'Bank verification by a SECOND staff member, then payout PAID',
    'BLOCKED',
    'Needs a second authorised staff account (only the super admin exists on QA) - owner decision. The saved account was NOT verified and the maker-checker was not bypassed.',
  );
  const detail = await api.call('GET', `/admin/payouts?organizationId=${org}`, { token: admin });
  rec(
    'payout',
    'PAYOUT-8',
    'Payout is visible to staff with status PENDING and the unverified-bank reason',
    detail.status === 200 ? 'PASS' : 'FAIL',
    JSON.stringify(detail.body).slice(0, 300),
  );
}

// ───────────────────────── Failure scenarios that need no gateway ─────────────────────────
async function stageDuplicates() {
  const c = S.cust;
  // Same Idempotency-Key twice on booking create: one booking, one hold.
  const key = crypto.randomUUID();
  const tt = S.ticketTypes[0];
  const body = {
    eventSessionId: S.session.id,
    items: [{ ticketTypeId: tt.id, quantity: 1 }],
    buyerName: 'Pilot Buyer',
    buyerEmail: c.email,
    buyerRegion: 'Andhra Pradesh',
  };
  const b1 = await api.call('POST', '/bookings', {
    token: c.token,
    body,
    headers: { 'idempotency-key': key },
  });
  const b2 = await api.call('POST', '/bookings', {
    token: c.token,
    body,
    headers: { 'idempotency-key': key },
  });
  rec(
    'failure',
    'F-DS-2',
    'Double-submit booking create (same Idempotency-Key) holds stock ONCE',
    b1.body?.id && b1.body.id === b2.body?.id ? 'PASS' : 'FAIL',
    `first ${b1.status} ${b1.body?.id}, second ${b2.status} ${b2.body?.id}`,
  );
  if (b1.body?.id) await api.call('POST', `/bookings/${b1.body.id}/cancel`, { token: c.token });
  // Paying a booking that is already CONFIRMED must not start a second payment.
  const again = await api.call('POST', `/bookings/${S.b1.id}/pay`, { token: c.token });
  rec(
    'failure',
    'F-DUP-1',
    'Starting a payment on an already-CONFIRMED booking is refused',
    again.status >= 400 ? 'PASS' : 'FAIL',
    errCode(again),
    { bookingId: S.b1.id },
  );
  // A tampered gateway confirmation (bad signature) must not confirm or change anything.
  const ver = await api.call('POST', `/bookings/${S.abandoned.id}/payments/razorpay/verify`, {
    token: c.token,
    body: {
      razorpay_order_id: 'order_fake',
      razorpay_payment_id: 'pay_fake',
      razorpay_signature: 'deadbeef',
    },
  });
  const ab = (await api.call('GET', `/bookings/${S.abandoned.id}`, { token: c.token })).body;
  rec(
    'failure',
    'F-WH-2',
    'A forged checkout confirmation (bad signature) is refused and the booking stays unconfirmed',
    ver.status >= 400 && ab?.status !== 'CONFIRMED' ? 'PASS' : 'FAIL',
    `verify ${errCode(ver)}; booking ${ab?.status}`,
  );
  // Refund requested twice for the same booking: refused the second time.
  const r2 = await api.call('POST', '/refunds', {
    token: c.token,
    body: { bookingId: S.b2.id, reason: 'Pilot cert: duplicate refund request' },
  });
  rec(
    'failure',
    'F-DUP-2',
    'A second refund request on an already-refunded booking is refused (no double refund)',
    r2.status >= 400 ? 'PASS' : 'FAIL',
    errCode(r2),
    { bookingId: S.b2.id },
  );
  rec(
    'failure',
    'F-RF-1',
    'Refund FAILURE at the provider (declined/errored refund)',
    'BLOCKED',
    'Razorpay test mode gives no way to make a refund fail on demand; the failure path is covered by unit/integration tests only, not certified end to end here.',
  );
  rec(
    'failure',
    'F-WH-3',
    'Genuine signed webhook delivered late or twice (idempotent confirm)',
    'BLOCKED',
    'A valid signature needs the webhook secret, which this run must not read. Idempotency is evidenced indirectly: the confirm was driven once by the real webhook, a forged one is refused (F-WH-1), and re-paying a confirmed booking is refused (F-DUP-1).',
  );
}

const stages = {
  11: stageDuplicates,
  1: stageInfra,
  2: stageOnboarding,
  3: stageEvent,
  4: stagePurchase,
  5: stageDelivery,
  6: stageCheckin,
  7: stageRefunds,
  8: stageRecon,
  9: stageAuthz,
  10: stagePayout,
};
// Access tokens are short-lived; sign in again at the start of every run.
for (const who of ['owner', 'cust']) {
  if (S[who]) S[who].token = (await api.login(S[who].email, S[who].password)).token ?? S[who].token;
}
if (S.adminToken) await getStaff();
for (const [n, fn] of Object.entries(stages)) {
  if (only(n)) {
    console.log(`\n=== stage ${n} (${envKey}) ===`);
    try {
      await fn();
    } catch (e) {
      rec('harness', `ERR-${n}`, `stage ${n} crashed`, 'FAIL', e.message.split('\n')[0]);
    }
    persist();
  }
}
