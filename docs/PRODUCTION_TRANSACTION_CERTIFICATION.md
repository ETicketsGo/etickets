# Production transaction certification

# NOT PRODUCTION READY

Dated 2026-10-04. Repeat the external evidence with
`node scripts/certification/production-transaction-probe.mjs`.

> **A second activation pass ran the same day. See [§20](#20-activation-pass-2026-10-04).** It
> **corrects the payment conclusion in §1 below** - the Razorpay bind failure is real but is not
> on the checkout path, so it does not stop a payment. It also settles the notification channels
> and the auth-throttle P1, finds that India GST is not actually applied in production, and fixes
> the storefront. **The verdict does not change**, for the reasons in §20.

---

## 1. Executive verdict

**If a real paying customer arrived at www.eticketsgo.com tomorrow morning, they could browse,
pick a ticket, see a correct price — and then not be able to pay.** The Razorpay adapter does not
bind in production, so payment creation fails before any money moves.

That is the right failure. Nobody is charged, nothing is half-booked, and no simulated gateway
silently issues a free ticket — the code forbids the mock outside LOCAL/DEV/QA. **The risk here is
commercial, not financial: we cannot sell, rather than we might lose money.**

Three things stand between us and a first sale, and none of them is a code defect:

1. **Payments cannot bind.** The production API authenticates to AWS Secrets Manager as
   `eticketsgo-ses-qa`, which has no permission to read `payments/razorpay/live/secret-key`.
2. **The storefront says it is a demo.** The live footer reads _"Demo build. The contact details
   and legal terms are placeholders."_ Contact details are `@eticketsgo.example` addresses and
   `+00 0000 000000`. We cannot take money behind that.
3. **Notifications are almost certainly undeliverable.** The evidence is in §9.

Underneath that, production is running code from **30 September** — between 138 and 157 commits
behind `main`, depending on the service.

---

## 2. SHAs

|                                    |                                                              |
| ---------------------------------- | ------------------------------------------------------------ |
| Repository `main` at start and end | `9f11d9f1b2bde54d1b6755f0b5b645f4d00ff527`                   |
| Baseline gate re-run at that SHA   | **407 API suites / 4801 tests**, prettier clean, `tsc` clean |

No production code was changed by this sprint. See §16.

---

## 3. Production deployment state

| Service         | Deployed commit      | Merged     | Behind `main`            |
| --------------- | -------------------- | ---------- | ------------------------ |
| `api`           | `a78f6d2a` (PR #155) | 2026-09-30 | **138 commits / 54 PRs** |
| `organizer-web` | `a78f6d2a` (PR #155) | 2026-09-30 | 138 / 54                 |
| `admin-web`     | `a78f6d2a` (PR #155) | 2026-09-30 | 138 / 54                 |
| `worker`        | `adf47a6b` (PR #152) | 2026-09-29 | **142 / 56**             |
| `customer-web`  | `46d00659` (PR #146) | 2026-09-29 | **157 / 63**             |

API uptime at the time of writing was ~3.5 days, matching the 30 September deploy — so the
running process is the one whose boot log is quoted below.

**Nothing from the Finance/payout workstream (#191–#211) is in production.** I did not deploy;
making the environments match is a decision with its own risk and is yours to take.

---

## 4. Certification matrix

Evidence levels are strict. A capability is never promoted without evidence of that kind.

| Capability               | Code | Auto test | Integration | Sandbox | Prod config            | Real provider      | Real txn         |
| ------------------------ | ---- | --------- | ----------- | ------- | ---------------------- | ------------------ | ---------------- |
| Catalogue / discovery    | ✅   | ✅        | ✅          | —       | ✅                     | n/a                | ✅ (served live) |
| Pricing, fees            | ✅   | ✅        | ✅          | —       | ✅                     | n/a                | ✅ (priced live) |
| Tax                      | ✅   | ✅        | ✅          | —       | ⚠️ inactive            | n/a                | ❌               |
| Seat lock / inventory    | ✅   | ✅        | ✅          | —       | ✅                     | n/a                | ❌               |
| Payment creation         | ✅   | ✅        | ✅          | ✅      | ❌ **adapter unbound** | ❌                 | ❌               |
| Payment webhook          | ✅   | ✅        | ✅          | —       | ✅ endpoint + secret   | ❌ never delivered | ❌               |
| Booking → ticket → QR    | ✅   | ✅        | ✅          | —       | ✅                     | n/a                | ❌               |
| Check-in                 | ✅   | ✅        | ✅          | —       | ✅                     | n/a                | ❌               |
| Email                    | ✅   | ✅        | ✅          | —       | ⚠️ see §9              | ❌                 | ❌               |
| SMS / WhatsApp           | ✅   | ✅        | ✅          | —       | ❌ no credentials      | ❌                 | ❌               |
| Refunds                  | ✅   | ✅        | ✅          | ✅      | ❌ depends on payments | ❌                 | ❌               |
| Finance / reconciliation | ✅   | ✅        | ✅          | —       | ⚠️ not deployed        | n/a                | ❌               |
| Payouts                  | ✅   | ✅        | ✅          | —       | ✅ **off by design**   | ❌                 | ❌               |

---

## 5. Buyer transaction result

Proven live against production, read-only:

| Step             | Result                                                                    |
| ---------------- | ------------------------------------------------------------------------- |
| Storefront loads | HTTP 200                                                                  |
| Catalogue        | 2 events (Hyderabad, MUSIC + COMEDY)                                      |
| Event detail     | 1 session, General ₹799 × 800, Gold ₹1499 × 200                           |
| Price a basket   | ₹1,598 + ₹20 booking + ₹32.36 payment = **₹1,650.36**, arithmetic correct |
| Pay              | **cannot proceed** — see §7                                               |

Everything up to the payment boundary works on real production infrastructure.

---

## 6. Organizer result

`organizer.eticketsgo.com` and `admin.eticketsgo.com` both answer HTTP 200. The full organizer
journey could not be certified: it needs a real organizer account on production, and creating one
would write production data, which this sprint deliberately avoided.

**Recorded as UNPROVEN, not as working.**

---

## 7. Payment provider result

### Razorpay — **BLOCKED, and this is the first thing to fix**

The production API's own boot log, from the currently running instance:

> `WARN [PaymentProviderFactory] Could not bind provider 'razorpay' in PRODUCTION: Secret
'payments/razorpay/live/secret-key' could not be resolved via aws: User:
arn:aws:iam::…:user/eticketsgo-ses-qa is not authorized to perform:
secretsmanager:GetSecretValue on resource: payments/razorpay/live/secret-key`

The production environment authenticates to AWS as the **SES QA user**, which has no Secrets
Manager policy for the live payment secret.

What is right about the surrounding state:

- the database payment config bootstrapped correctly — `razorpay:LIVE; routes INR->razorpay`
- `PAYMENTS_ACTIVATION_PENDING` must be `false`, because the API refuses to boot with that flag
  while a credential is present, and it is booting
- warmup failure is non-fatal **by design**, and `getProvider()` throws on a real payment attempt
- **the mock cannot be substituted**: `DUMMY_ALLOWED = {LOCAL, DEV, QA}`

So the failure is closed, not open. A buyer sees a failure; nobody is charged.

### Stripe — **not configured in production at all**

No `STRIPE_*` variable exists in the PROD environment. Stripe is not a production path today.

### Webhook

The endpoint is live and correct: an invalid signature returns `400 PAYMENT_WEBHOOK_INVALID`,
which proves the route is deployed **and** a webhook secret is configured.

**No Razorpay webhook has ever been delivered.** Production HTTP logs over the available window
contain only bots, vulnerability scanners and my own probes — no provider traffic, no buyer
traffic, no `/api/bookings` POST.

---

## 8. Ticket / QR / check-in result

`CODE EXISTS` + `AUTOMATED TESTED` + `INTEGRATION TESTED`. Not reachable in production because no
booking can be created without a payment. **No real-transaction evidence.**

---

## 9. Notification result

| Channel     | Status                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email (SES) | **UNPROVEN.** Configured (`EMAIL_PROVIDER`, `EMAIL_FROM`, `SES_*`), but no email has ever been sent from production — the worker log contains no notification activity at all. |
| SMS         | **NOT CONFIGURED.** No MSG91 or Twilio credentials exist in PROD.                                                                                                              |
| WhatsApp    | **NOT CONFIGURED.** Same.                                                                                                                                                      |
| Push        | **UNPROVEN.** Provider variable present, no credentials, no sends.                                                                                                             |

**The inference that matters.** `assertDeliverabilityHardening` refuses to boot a PRODUCTION
environment whose SMS provider is `log`, _unless_ `ALLOW_UNDELIVERABLE_NOTIFICATIONS=true`. There
are no SMS credentials in PROD, and the API boots. The only consistent explanation is that the
override is on — the flag whose own documentation says _"never to serve customers."_

Consequence if a sale did complete: **the buyer would be charged and receive no ticket email, and
phone sign-in codes would never arrive.**

---

## 10. Finance integration result

The frozen Finance internals were not re-certified and were not touched.

Producer → finance integration is proven by `payout-lifecycle.integration-postgres.spec.ts`
against real PostgreSQL through the production services: entitlement → release → attempt →
movement → Finance read → reversal → recovery shown correctly.

**Not proven in production**, because no booking has ever occurred there — and because none of
that code is deployed.

Payouts are off and stay off: `PAYOUT_EXECUTION_ENABLED` is absent from PROD, so it defaults
false — once that build is deployed. Today's build predates the switch, but
`RAZORPAY_ROUTE_ENABLED` is also absent, so Route transfers are refused either way.

---

## 11. Refund result

`CODE EXISTS` + `AUTOMATED TESTED` + `INTEGRATION TESTED`. Cannot be exercised in production:
there is nothing to refund. **No real-transaction evidence.**

---

## 12. Failure / recovery matrix

| Failure                              | Classification                            | Evidence                                                                                                                                                                                  |
| ------------------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment succeeds, booking unpayable  | **operator recoverable**                  | detected, `PaymentAttempt` recorded, `Payment.failureCode = CAPTURED_ON_UNPAYABLE_BOOKING`, finance discrepancy filed `PAYMENT_MISSING_INTERNALLY`, logged "refund the customer manually" |
| Duplicate capture                    | **operator recoverable**                  | `DUPLICATE_CAPTURE` discrepancy, same path                                                                                                                                                |
| Duplicate webhook                    | **automatic**                             | claim on stored row state; proven in `razorpay-webhook.service.spec.ts`                                                                                                                   |
| Webhook before/after redirect        | **automatic**                             | webhook is authoritative; redirect is cosmetic                                                                                                                                            |
| Payment succeeds, notification fails | **automatic (retry) → operator**          | notification retry + dead-letter                                                                                                                                                          |
| Transfer outcome unknown             | **operator recoverable**                  | `UNKNOWN` attempt, reconciliation finding, operator queue                                                                                                                                 |
| Redis unavailable                    | **degraded**                              | `/api/ready` reports it; seat locks are flag-gated                                                                                                                                        |
| Postgres unavailable                 | **hard outage**                           | `/api/ready` fails, pod derouted                                                                                                                                                          |
| Worker unavailable                   | **delayed**                               | holds expire late, notifications queue                                                                                                                                                    |
| Provider unavailable                 | **safe**                                  | fails closed — this is today's live state                                                                                                                                                 |
| **Provider unbound**                 | **unsafe commercially, safe financially** | **current production state**                                                                                                                                                              |

The hard requirement — _money captured with no recoverable booking_ — is **met**: every such case
is detected, persisted, and surfaced on `GET /api/admin/payments/finance/discrepancies`, which is
live in production.

---

## 13. Security findings

**P0 — none found.** No money-moving authorization flaw was identified.

**P1 — the auth throttle does not engage at its configured limit.** `@Throttle` on login is
10/60s on a single replica, yet 13 consecutive failed logins all returned 401. Pushing to 25 rapid
attempts produced only 4 × 429. Protection exists but is materially weaker than configured. I
could not diagnose the cause from outside; the lead is the throttler's tracker key under
`trust proxy`. Reproduce with the loop in §17.

**P2 — observations, not defects.**

- **A CI flake, found by this PR's own run.** `customer-secure-sharing` failed on
  `openPaidEvent` with _"No paid, quantity-sold event on this page. 0 listed"_ — the listing page
  had **zero** event cards, not the wrong kind. Re-running the identical commit passed, so it is
  intermittent rather than date rot (the seed uses relative dates). It is worth a look before it
  starts costing people re-runs; the helper already carries two comments about exactly this class
  of fixture rot.

- Swagger correctly **not** served in production despite `ENABLE_SWAGGER` being present — the code
  lets `APP_ENV` decide, which is the right design.
- `/api/metrics` correctly requires a token (401).
- Structured errors carry correlation IDs throughout — good for operator recovery.
- Node 20 with AWS SDK deprecation warnings; SDK will require Node ≥22 after January 2027.

---

## 14. Production website findings

All of these are **honest** — the site discloses its own state rather than misleading anyone,
which is to its credit. They are still blockers for accepting money.

| Finding                                                                                       | Where                                           |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| _"Demo build. The contact details and legal terms are placeholders."_                         | footer, every page                              |
| _"The prices below are placeholders while we set the real ones."_                             | homepage pricing                                |
| _"These quotes are placeholders. They are not from real customers."_                          | homepage testimonials, attributed "Placeholder" |
| `sales@eticketsgo.example`, `+00 0000 000000 (placeholder)`, `Bengaluru, India (placeholder)` | /contact                                        |
| Terms, Privacy, Refunds pages exist but carry the same demo disclosure                        | /terms /privacy /refunds                        |

No dead links, QA links or sandbox references were found. `/refund-policy` and `/legal` 404 but are
not linked; the live links are `/refunds` and the individual legal pages.

---

## 15. External blockers

Only blockers that actually exist:

1. **AWS IAM** — the production identity cannot read the live Razorpay secret.
2. **Razorpay webhook registration** — unproven; no delivery has ever been observed.
3. **SMS/WhatsApp provider** — no credentials in production; DLT registration still outstanding for
   India.
4. **Email** — SES configured but never exercised from production.
5. **Legal and contact content** — a business input, not an engineering one.

---

## 16. Changes made

**No production code was changed.** Nothing in this sprint justified it: every blocker is
configuration, deployment or content, and the frozen Finance/payout domain was not touched.

One addition — `scripts/certification/production-transaction-probe.mjs`: a read-only, repeatable
probe of everything in §5, §7, §14 and §13's public surface. It creates no booking, takes no
payment, sends no valid signature, prints no secret, and exits non-zero on a blocker.

---

## 17. Test evidence

```
# Baseline, at 9f11d9f1
cd apps/api && npx jest --config jest.config.js --silent
  → Test Suites: 407 passed, 407 total
  → Tests:       4801 passed, 4801 total

npx prettier --check "**/*.{ts,tsx,js,jsx,json,md}"   → clean
npx tsc --noEmit (all six packages)                   → clean

# External certification
node scripts/certification/production-transaction-probe.mjs
  → 2 blocker(s), 2 unproven, 8 ok   (exit 1)

# Payment boundary
curl -X POST https://api.eticketsgo.com/api/payments/webhooks/razorpay \
     -H 'x-razorpay-signature: invalid' -d '{"event":"probe"}'
  → 400 PAYMENT_WEBHOOK_INVALID

# Auth throttle (P1 reproduction)
for i in $(seq 1 25); do curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  https://api.eticketsgo.com/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"nobody@example.invalid","password":"x"}'; done | sort | uniq -c
  → 21 × 401, 4 × 429   (expected ~15 × 429 for a 10/min limit on 1 replica)
```

Local `lint` and `build` could not run: Windows Application Control blocks `turbo.exe` on this
machine. Not bypassed. CI remains authoritative for those two steps.

---

## 18. Remaining human actions

Concrete, in order:

1. **Owner → AWS IAM** → grant the production API's IAM identity
   `secretsmanager:GetSecretValue` on `payments/razorpay/live/secret-key`, **or** stop using a
   secret-manager reference and set `RAZORPAY_KEY_SECRET` directly in Railway PROD. The identity
   currently in use is `eticketsgo-ses-qa`, which looks like the wrong user for production.
2. **Owner → Razorpay dashboard** → register the live webhook at
   `https://api.eticketsgo.com/api/payments/webhooks/razorpay`, subscribe only the implemented
   events, and confirm the signing secret matches `RAZORPAY_WEBHOOK_SECRET`.
3. **Owner → decide and deploy** → production is 138–157 commits behind. Decide whether to deploy
   `9f11d9f1` before or after the first sale. Deploy **api first**, then worker, then the three web
   apps, and verify with `scripts/deploy/verify-deployed.mjs`.
4. **Owner → business** → supply real contact details, legal terms, refund policy and pricing, and
   remove the "Demo build" footer.
5. **Owner → notifications** → provide SES production proof (one real send) and either configure an
   SMS provider or accept that phone sign-in does not work, then **unset
   `ALLOW_UNDELIVERABLE_NOTIFICATIONS`** so the boot guard protects you again.
6. **Owner → decide on tax** → production currently prices with no tax line. Confirm that is
   intended for the first sales.
7. **Engineer → investigate the auth throttle** (P1) using the reproduction in §17.
8. **Owner → one controlled real transaction** → after 1–3, buy one real ticket end to end. That is
   the only thing that can move payments, webhook and email to `REAL TRANSACTION VERIFIED`.

---

## 19. GO / NO-GO checklist

Tick every box before enabling real customers.

- [ ] Razorpay adapter binds — API boot log shows `Bound payment provider 'razorpay'`, no warning
- [ ] Razorpay live webhook registered, and one signed delivery observed reaching `PROCESSED`
- [ ] One real end-to-end purchase: payment → booking → ticket → QR → email received
- [ ] That ticket scans successfully at check-in, and a second scan is refused
- [ ] One real refund processed and reflected in Finance
- [ ] "Demo build" footer removed; real contact details and legal terms published
- [ ] Real pricing published, or the pricing page removed
- [ ] Placeholder testimonials removed
- [ ] `ALLOW_UNDELIVERABLE_NOTIFICATIONS` unset, and the API still boots
- [ ] Tax position confirmed deliberately
- [ ] Production deployed from a known SHA and verified with `verify-deployed.mjs`
- [ ] Auth throttle P1 understood
- [ ] `PAYOUT_EXECUTION_ENABLED` remains unset/false — payouts stay manual for the pilot

**The first five boxes are the ones that matter.** Until a single real transaction completes end
to end, every payment, notification and refund capability in §4 stays at
`INTEGRATION TESTED` and no higher.

---

## 20. Activation pass, 2026-10-04

A second pass the same day, against `main = 2b42fb31`. The verdict is unchanged - **NOT
PRODUCTION READY** - but four things that were inferred are now settled, and one new blocker was
found that nobody had looked for.

### 20.1 The payment finding, corrected

**The earlier conclusion in this document was wrong, and this section replaces it.** The verdict
in §1 says a customer "could not pay" because the Razorpay adapter does not bind. That bind
failure is real, but it is **not on the checkout path**, so it does not stop a payment.

The running deployment does log it:

```
[PaymentProviderFactory] Could not bind provider 'razorpay' in PRODUCTION:
Secret 'payments/razorpay/live/secret-key' could not be resolved via aws:
User: arn:aws:iam::<account-id>:user/eticketsgo-ses-qa is not authorized to perform:
secretsmanager:GetSecretValue on resource: payments/razorpay/live/secret-key
because no identity-based policy allow...
```

Two different ways of getting a provider exist, and only one of them goes near AWS:

| Path                      | How it gets the key                                                                                                | Used by                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `PaymentProviderResolver` | `new RazorpayPaymentProvider(config)` - reads `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` from the **environment** | **checkout**: `payments.service`, `razorpay-order.service`, the orchestrator        |
| `PaymentProviderFactory`  | AWS Secrets Manager                                                                                                | sandbox certification, merchant onboarding, promotion, **live-readiness reporting** |

Both environment variables are set on the PROD api, and `[PaymentConfigService] bootstrapped
razorpay:LIVE; routes INR->razorpay` confirms the routing. A real live Razorpay order was created
from the live storefront on 2026-09-29 and read back from the live account, which is the strongest
check available without paying - creating an order moves no money.

**So payment creation works.** What the AWS failure actually breaks is the factory-backed
features, and one of those matters here: `payment-live-readiness.service` takes the factory, so
the readiness report can say "not ready" while checkout is perfectly able to take a payment. That
is a confusing pair of signals to launch into, and it is worth fixing for that reason rather than
because it blocks a sale.

Fixing it means either granting `secretsmanager:GetSecretValue` on
`payments/razorpay/live/{secret-key,webhook-secret}`, or pointing the factory at the environment
the same way the resolver does. **If IAM is the route, do not widen `eticketsgo-ses-qa`** - a
production payment credential should not be read by a principal named for QA email.

**The link that is still genuinely unproven is the webhook signature.**
`RAZORPAY_WEBHOOK_SECRET` was generated by us and typed into the dashboard by hand. Razorpay never
returns it, so nothing short of a real paid transaction can confirm the two match, and a mismatch
is silent and expensive: the payment succeeds and the booking stays `PENDING_PAYMENT`. The first
real purchase has to be watched through to `CONFIRMED`.

### 20.2 India GST is configured but NOT applied - new finding

The live production quote, read by the probe:

```
Checkout can price a basket - total 83028 INR (subtotal 79900, fees 3128, tax 0)
```

**`tax 0` on an INR sale.** The tax engine ships holding no rates, the Indian rules are written
inactive on purpose (`apps/api/prisma/seed-india-gst.ts`), and nobody has switched them on. So a
real Indian customer today would be charged `79900 + 3128` with **no GST line on the order and
none on the receipt** - and the Rs 31.28 convenience fee, which is the platform's own taxable
supply at 18%, carries no GST either.

This is a compliance exposure, not a rounding question. It is also the only blocker on this list
that is entirely ours: it needs no provider, no dashboard and no third party.

```
npx tsx apps/api/prisma/seed-india-gst.ts            # write the rules, still inactive
npx tsx apps/api/prisma/seed-india-gst.ts --activate # switch them on, deliberately
```

**Activation does not change what a customer pays.** Indian ticket prices are quoted inclusive of
GST, so switching the rules on changes what the receipt _says_, not what is charged. That property
is now asserted directly, in `apps/api/src/pricing/india-gst-activation.spec.ts`.

Until this pass the shipped rule table had **no test at all**. The engine was well covered, but
only against rules written inside the tests; the rows somebody types `--activate` against were
exercised by nothing. A wrong band edge or rate would have reached a customer's receipt with every
test still green. `INDIA_GST_RULES` is now exported for that reason, and 13 tests hold it to the
published table - including that the Rs 100.00 / Rs 100.01 band edge has no gap, that admission
rules share one tax group so a band and the catch-all cannot stack, and that no rate is invented
for the 40% categories.

**Still a business decision, not ours:** whether the table is correct. The guide says plainly that
it is not tax advice. An accountant has to read it before anybody types `--activate`.

### 20.3 Notifications: four of five channels cannot deliver

Settled from the PROD api variable list against what each transport requires in
`apps/api/src/config/configuration.ts`:

| Channel     | Credentials present                                          | Can deliver        |
| ----------- | ------------------------------------------------------------ | ------------------ |
| Email (SES) | `AWS_*`, `EMAIL_FROM`, `SES_CONFIGURATION_SET`               | **Probably** - yes |
| SMS         | no `TWILIO_*`, no `MSG91_*`                                  | **No**             |
| WhatsApp    | no `WHATSAPP_ACCESS_TOKEN`, no `MSG91_*`                     | **No**             |
| Mobile push | no `FCM_PROJECT_ID` / `FCM_CLIENT_EMAIL` / `FCM_PRIVATE_KEY` | **No**             |
| Web push    | no `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`                  | **No**             |

`ALLOW_UNDELIVERABLE_NOTIFICATIONS` is set on PROD, which is what lets the API boot in that state.
It is doing real work, and removing it today would stop production booting.

**The consequence nobody had written down: phone sign-in cannot work in production.** The platform
is phone-first for India, `POST /auth/phone/request-code` sends an SMS, and there is no SMS
transport. A customer who picks the phone route reaches a code-entry screen for a code that was
never sent. Email is the only channel a buyer can actually be reached on.

### 20.4 Razorpay webhook: the exact configuration a person has to enter

From source, not from the provider documentation:

|                  |                                                                             |
| ---------------- | --------------------------------------------------------------------------- |
| URL              | `https://api.eticketsgo.com/api/payments/webhooks/razorpay`                 |
| Events           | **`payment.captured` and `payment.failed` - these two only**                |
| Secret           | `RAZORPAY_WEBHOOK_SECRET`, which **must differ** from `RAZORPAY_KEY_SECRET` |
| Signature header | `X-Razorpay-Signature`, HMAC over the exact raw bytes                       |

The route is plural (`webhooks`), and it is deliberately exempt from the per-IP throttle so that a
sale spike cannot turn payment confirmations into 429s.

**Subscribe only those two events.** `razorpay-payment.provider.ts` rejects anything else with a
400 by design, so subscribing `order.paid` or `refund.processed` produces a stream of failed
deliveries and provider retry noise against an endpoint that is working correctly.

The endpoint is already live and already refusing correctly: the probe's deliberately invalid
signature returned `400 PAYMENT_WEBHOOK_INVALID`, which proves the route is deployed and a secret
is configured. A `501` would have meant no secret. **Zero real deliveries have ever arrived.**

### 20.5 The auth-throttle P1, classified

The previous pass recorded that the throttle did not appear to engage at its configured 10/min.
Five candidate explanations are now ruled out:

| Candidate             | Ruled out by                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| Misconfiguration      | `AUTH_THROTTLE_LIMIT` is **not set** on PROD, so the limit is 10       |
| Per-instance counters | PROD api runs **`numReplicas: 1`**                                     |
| Stale deployed code   | the throttle block at `a78f6d2` is **byte-identical** to `main`        |
| Decorator missing     | every credential handler carries `THROTTLER:LIMITdefault` (now tested) |
| Guard not registered  | `ThrottlerGuard` is an `APP_GUARD` in `app.module.ts`                  |

What remains is **storage durability, plus the measurement itself**. `@nestjs/throttler` defaults
to in-memory storage, so the counter lives in the API process and is lost on every restart or cold
start - and the original observation (13 sequential failed logins, all 401) is equally consistent
with a correctly working 10/60s limit whose window simply expired part-way through the run.

**Classification: not a defect in the limit; a durability weakness in where the count is kept.**
The fix is a shared store, and Redis is already provisioned (`REDIS_URL` is set on the PROD api).
That is a change to a live security control and a new dependency, so it is left as an owner
decision rather than made here - deliberately, during an activation sprint.

What was closed instead is the gap that would actually bite: there was **no test of any kind** on
the credential throttle. `apps/api/src/auth/auth-throttle.spec.ts` now enumerates the controller's
handlers rather than naming them, so a newly added auth route that ships without a limit fails the
suite. Nobody removes `@Throttle` from `login`; somebody adds a route and forgets. It also pins
the production default (10/60s with the variable unset), because a test that sets the variable
proves nothing about the deployed system.

### 20.6 The storefront, fixed

Fixed in this pass, with nothing invented:

- **The fabricated testimonials are gone.** Three invented quotes attributed to "Placeholder".
  Fake social proof has no honest replacement, so the section was removed rather than rewritten.
- **The contact form now delivers.** It posted nowhere: it opened the visitor's mail client
  addressed to `hello@eticketsgo.example` - a domain reserved by RFC 2606, which can never
  resolve - and then said that we would get back to them soon. A customer whose card was charged
  twice would have written to it and waited. It now posts to `POST /support`, which was **already
  there**: public, persisted, and visible in the admin support inbox. The mailto was a workaround
  for a missing endpoint that was not missing.
- **One source of truth for the business facts.** `packages/web-kit/src/business-details.ts` holds
  them, every field `null` until somebody publishes it, with a guard that refuses to render a
  reserved or placeholder-shaped value even if one is committed. The organizer console carried the
  same dead address (`organizers@eticketsgo.example`) and now reads from here too.
- **The demo notice is derived, not hardcoded.** It was a constant, which meant it could outlive
  the problem it described - or be deleted while the problem remained. It now follows the details
  themselves and retires itself.

**Still blocked on business decisions, and deliberately left visible:** the pricing figures
(`/pricing`, the landing preview, the FAQ), the operating legal entity on `/terms`, and a postal
address, phone number and support hours. Those are commitments only the business can make.

### 20.7 The probe result did not move

```
2 blocker(s), 2 unproven, 8 ok.
```

Identical to the previous pass, and correctly so: **the probe reads the deployed site, and
production still runs `a78f6d2` from 30 September - 141 commits behind `main`.** The storefront
fixes above are on a branch. The two blockers it still reports are the demo wording and the
`.example` contact details, both of which are fixed in code and neither of which is fixed in
production until somebody deploys.

That is the cleanest illustration of the gap this document exists to measure: every green tick in
the repository says nothing about what a customer meets.

### 20.8 Gate re-run at the end of this pass

**409 API suites / 4818 tests passing**, `tsc` clean across `api`, `web-kit`, `customer-web`,
`organizer-web` and `admin-web`, prettier clean. `lint` and `build` could not be run locally -
Windows Application Control blocks `turbo.exe` on this machine - so CI on Linux remains the
authority for those two, and that limitation was not worked around.
