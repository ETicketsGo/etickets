# Production transaction certification

# NOT PRODUCTION READY

Dated 2026-10-04. Repeat the external evidence with
`node scripts/certification/production-transaction-probe.mjs`.

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
