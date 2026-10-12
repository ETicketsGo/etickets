# Razorpay (India) payment readiness for the pilot

Pilot scope: 3-5 real organizers, about 10 general-admission events, INR through Razorpay. Regulated
cinema ticketing stays off. Production is NO-GO until section 3 passes.

Written 2026-10-12 against `origin/main` e3e289e. Nothing in this document was executed against
production, Razorpay or any dashboard. Evidence labels used below:

- **code** - read in the repository at the file and line shown.
- **QA** - read on QA on 2026-10-12 through admin GET endpoints (`admin@eticketsgo.test`) or a public
  Razorpay endpoint that needs no secret.
- **note** - from an older dated record. A lead to re-verify, not a fact.
- **UNKNOWN** - nothing available to this review can answer it. The owner step that answers it is named.

## 0. Summary

| Area                     | Verdict for the pilot                                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| KYC / account activation | UNKNOWN for production. Live orders and one captured live payment exist (note), settlement to the bank was never proven.                   |
| Route / linked accounts  | Not needed. The pilot runs with Route OFF and manual bank-transfer payouts from our ledger.                                                |
| Webhook signing secret   | **Blocker.** Proven wrong on 2026-10-06 (note). Rotation and a post-rotation delivery have not been done (UNKNOWN).                        |
| Payment capture          | Code never sets a capture mode. The account's capture setting decides, and it is UNKNOWN everywhere. If it is manual, no booking confirms. |
| Refunds                  | Work end to end in code. Human approved only. Never exercised against live Razorpay.                                                       |
| Reconciliation           | Exists. Cannot give a useful answer on QA today because QA's Razorpay key is revoked.                                                      |
| Settlement and payouts   | Pilot-safe by default: payouts held 7 days after the event, bank must be verified by a second person, provider transfers off.              |
| Readiness report / gate  | Misleading in three ways (section 1.9). The certification in section 3 does not rely on the launch gate's GO.                              |

Blockers, in the order the owner must clear them: B1 webhook secret, B2 capture setting, B3 production
secret store (so the readiness report can see credentials), B4 the stranded 2026-10-06 payment, B5 a
watched small live transaction with a refund. QA key (B6) blocks rehearsal only.

## 1. Findings per area

### 1.1 KYC and account activation

- **code**: nothing in the repository reads the platform account's KYC state. The only KYC-aware code is for
  organizer Linked Accounts (`razorpay-payment.provider.ts` `getConnectedAccount`).
- **note** (2026-09-29, `docs/ops/PRODUCTION-READINESS-2026-10.md` item 7): live keys exist, a live order was created
  and read back with the live key. On 2026-10-06 a real UPI payment was captured on production. A captured live
  payment shows the account could take money; it does not show the settlement bank is verified or that a
  settlement ever reached it.
- **UNKNOWN**: activation status, settlement bank, settlement cycle, enabled live methods, whether
  international cards are on. Owner steps S1 and S3 below answer these.

### 1.2 Route and linked accounts - can the pilot run without them?

Yes, and the code is built for it.

- `RAZORPAY_ROUTE_ENABLED` defaults false (`apps/api/src/config/configuration.ts:444`). While false,
  `createTransfer` refuses (`razorpay-payment.provider.ts:297`) and a settlement release is set BLOCKED with the reason
  "Razorpay Route is not enabled; organizer payout is on hold." (`settlement/settlement.service.ts:431`). No transfer
  is made.
- Checkout does not need an organizer Linked Account. Charges land on the platform account and the organizer is paid
  later (`razorpay-order.service.ts:48-52`).
- Payouts for the pilot go through the platform payout ledger, not Route: a `Payout` is generated per organizer and a
  staff member records the bank transfer they made by hand with `markPaid` (`payouts/payouts.service.ts:1170`).
  `PAYOUT_EXECUTION_ENABLED` (default false, `settlement.service.ts:299`) separately keeps provider-executed transfers off.
- Owner's standing gate (note, 2026-10-01): Route and Connect transfer execution stay off until the post-transfer
  reversal evidence is complete. Nothing in this document asks to change that.
- **QA**: `GET /admin/payments/unresolved-money` returns empty lists; `GET /admin/settlements` shows pilot settlements in
  `HELD` with `payableMinor 0` and no provider transfer id (2026-10-12).
- **UNKNOWN (production)**: production Postgres had 0 Settlements and 0 Payouts on 2026-10-12 (PILOT-BRIEF), so the
  payout path has never run in production at all.

### 1.3 Webhook signing-secret mismatch

What happened (note, 2026-10-06, `docs/incidents/2026-10-06-payment-capture-without-confirmation.md`): a real UPI
payment `pay_TkVxCS4BmDljlf` (Rs 519.18) was captured. Every webhook delivery was answered
`400 PAYMENT_WEBHOOK_INVALID`, and the same 400s appear from 2026-10-04. Ten minutes later the worker expired the
booking as an abandoned cart. Money taken, no ticket, no record. The verification code is correct (raw body, hex
HMAC-SHA256, timing-safe compare: `razorpay-payment.provider.ts:269`, controller reads `req.rawBody`:
`razorpay-webhook.controller.ts:29`). The secret value held by the API did not equal the one in the dashboard.
Razorpay never returns a webhook secret, so nothing but a signed delivery can compare the two.

What the code does now:

- A rejected delivery is logged at ERROR and counted as `payment_webhooks{result="signature_invalid"}`
  (`razorpay-webhook.service.ts:59`). No alert rule on that counter exists anywhere in the repository
  (`docs/ops/PRODUCTION-READINESS-2026-10.md` item 17).
- The expiry job asks Razorpay before releasing a held booking, so a captured payment is no longer discarded
  (`recovery/pending-payment-recovery.service.ts`). A late capture on an unpayable booking is recorded as a finance
  discrepancy and audit entry instead of throwing (`payments.service.ts:1064`).
- The route is not throttled (`razorpay-webhook.controller.ts:19`), so a sale spike cannot 429 Razorpay's deliveries.
- Readiness check `webhook-delivered` (`readiness/payment-live-readiness.service.ts:190`) passes when any
  `WebhookEvent` row exists for the provider. Rows are written only after the signature verified.

Gaps in that check - read them before relying on it:

1. **It is sticky.** It passes if any verified delivery ever existed. After the secret is rotated it stays green while
   proving nothing about the new secret. The proof after a rotation is a `WebhookEvent` row with a `createdAt` later than the
   rotation, plus a booking confirmed from a delivery made after it.
2. **Any event type counts**, including events the processor ignores. That is acceptable for proving the secret, but it
   is not proof that `payment.captured` confirms a booking.
3. **QA**: `webhook-delivered` is `passed: true` for both razorpay and stripe on QA (2026-10-12), so the check works
   where deliveries have happened.
4. **UNKNOWN (production)**: whether it is green. The owner step S4 produces the evidence.

How to rotate and prove it: owner step S4.

### 1.4 Payment capture: order, payment, webhook, booking confirmation

The path (all **code**):

1. `RazorpayOrderService.createOrder` (`razorpay-order.service.ts:76`) calls the adapter `createPayment`
   (`razorpay-payment.provider.ts:124`). The Razorpay order carries `receipt = bookingId` and notes `bookingId`,
   `eventId`, `organizerId`. No buyer PII goes into notes. The order is idempotent per booking.
2. The buyer pays in Razorpay Checkout. The browser callback goes to `verify`, which checks the
   `order_id|payment_id` signature with the key secret and records the payment id. It never issues tickets
   (`razorpay-order.service.ts:122`).
3. Razorpay posts `payment.captured` (or `order.paid`). Ingest verifies the signature and stores a `WebhookEvent`
   (idempotent on `X-Razorpay-Event-Id`, else a body hash). Processing runs inline and again from a worker sweep every
   15 s (`WEBHOOK_SWEEP_INTERVAL_MS`, `apps/worker/src/main.ts:295`) with six attempts before dead-letter
   (`razorpay-webhook.processor.ts:15`).
4. `processVerifiedEvent` (`payments.service.ts:427`) refuses a paid amount that differs from the booking total
   (`payments.service.ts:716`, audited `PAYMENT_AMOUNT_MISMATCH`) and only then flips the booking to CONFIRMED
   in one transaction. Redelivery and recovery cannot double-issue.

**Auto-capture is not set by us.** `orders.create` is called with no capture parameter
(`razorpay-payment.provider.ts:124-140`), so the Razorpay account's own capture setting decides. If that setting
is manual capture, the payment stays `authorized`. The code then has two consequences:

- `payment.authorized` is acknowledged and ignored (`razorpay-webhook.processor.ts:248`), so nothing confirms the booking.
- The expiry guard treats only `CAPTURED` and `SUCCEEDED` as paid (`recovery/captured-payment-verdict.ts:20`), so an
  authorized payment reads as "nobody paid" and the hold is released. Razorpay releases uncaptured authorizations on its
  own after a period (verify the exact period in the dashboard documentation), so the buyer is not charged, but they see
  a failed purchase.

The capture setting is UNKNOWN on QA and on production (no note records it). Owner step S2. Whether the
`payment_capture` order parameter is still honoured by Razorpay for this account should be confirmed with Razorpay
support or the dashboard; this review did not test it.

Other findings:

- `payment.failed` is processed and maps to a plain-language reason for the buyer (`razorpay-webhook.processor.ts`
  `toPaymentEvent`). Domestic-only accounts refuse international cards; the reason is shown.
- **QA** methods: the QA key `rzp_test_...aILA` is rejected by Razorpay's public preferences endpoint
  (`GET /v1/preferences?key_id=...` returned `401 Authentication failed`, 2026-10-12). That matches the revoked-key
  note of 2026-09-25..29 (note: Razorpay keeps one active test pair per account; regenerating it revokes the old one).
  QA therefore cannot create orders or reconcile today. Rehearsal needs the owner to put the current test pair on QA (B6).

### 1.5 Refunds (full and partial)

- A refund is requested (buyer, guest link, organizer, or automatically as a REQUESTED row when a show is cancelled).
  Nothing moves money until an authorised person approves it: the approval takes an atomic claim
  (`refunds/refunds.service.ts:895`), checks the tickets are still live, then calls Razorpay
  `payments.refund` (`refunds.service.ts:1022` to `razorpay-payment.provider.ts:199`).
- Auto-refund is off: `BOOKING_REFUND_POLICY_MODE` defaults `MANUAL_ONLY` and the money automation is production-forbidden
  (`bookings/compensation/booking-refund-policy.ts:59`, `config/configuration.ts:1309`).
- Partial refunds are per ticket. The amount is tickets plus tax added on top; booking and payment fees are not returned
  unless the show was cancelled, when the whole remaining total returns (`refunds.service.ts:440-470`). The sum can never
  exceed the booking total.
- Provider status is honest. Razorpay `pending` stays `PROCESSING`; only `refund.processed` completes the row and issues the
  credit note path (`razorpay-webhook.processor.ts:202`). `refund.failed` marks the row `FAILED`, audits
  `REFUND_FAILED_AT_PROVIDER` and logs ERROR (`razorpay-webhook.processor.ts:206`, handler near line 381). Its tickets were
  already cancelled, so the customer must be refunded by hand.
- `refund.created` is deliberately ignored (it carries the same entity as `refund.processed` and used to double count).
- **A refund on an EXPIRED booking is impossible through the platform.** Only CONFIRMED and PARTIALLY_REFUNDED are
  eligible. The 2026-10-06 payment can only be refunded in the Razorpay dashboard (owner step S7).
- **Doc drift fixed in this PR**: `RAZORPAY-DASHBOARD-SETUP.md` listed `refund.failed` as "acknowledged only" and
  `INDIA-PAYMENTS-RUNBOOK.md` said `refund.created` moves the ledger. Both were wrong. **`refund.failed` must be
  subscribed**, or a refund Razorpay rejects stays `PROCESSING` for ever.
- **UNKNOWN**: no refund has ever been executed against live Razorpay. A refund issued from the Razorpay dashboard (not from
  our app) has no `Refund` row; its ledger effect was not traced in this review. Owner step S8 exercises a full and a partial
  refund from the app.

### 1.6 Reconciliation

What exists:

| Report                                                           | Where                                                                             | What it detects                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Payment vs provider (7-day window by default)                    | `GET /admin/payments/reconciliation` (`payment-reconciliation.service.ts:73`)     | status or amount disagreement with Razorpay's `payments.fetch`: `matched` / `mismatched` / `unverifiable`            |
| Finance discrepancies                                            | `POST /admin/payments/finance/detect`, `GET .../discrepancies(.csv)`, `.../aging` | missing at provider or internally, amount, currency, duplicate capture, refund mismatch, chargeback, settlement, fee |
| Daily worker run of the above                                    | worker `reconcile-finance`, every `RECONCILE_INTERVAL_MS` (default 24 h)          | opens discrepancy rows; a captured payment that could not confirm a booking lands here                               |
| Unresolved money (transfers, open findings, blocked settlements) | `GET /admin/payments/unresolved-money`                                            | transfer and reversal evidence gaps (Route; empty while Route is off)                                                |
| Settlement summary per provider/currency                         | `GET /admin/payments/settlement`                                                  | gross, refunded, net from our own tables                                                                             |

- **QA, 2026-10-12**: reconciliation `checked 9, matched 0, mismatched 0, unverifiable 9` (the QA key is revoked, so every
  provider call fails). Finance discrepancies: only the mock-provider artefacts closed `IGNORED` on 2026-09-25; aging buckets
  all zero; `unresolved-money` empty. So QA cannot demonstrate a clean reconciliation until B6 is fixed.
- **Not covered**: nothing reads Razorpay's own settlements (the `settlement.processed` and `settlement.failed` events are
  acknowledged and ignored, `razorpay-webhook.processor.ts:246`). Matching the bank credit to our books is a manual step for
  the pilot (owner step S9).
- A `mismatched` or `unverifiable` result is a reason to stop, not a warning: an unverifiable payment is one we cannot prove.

### 1.7 Settlement and payout eligibility

- **Hold period**: `PAYOUT_HOLD_DAYS` default 7 (`config/configuration.ts:157`), 0 to 90, counted from the end of the
  event's last session. It can be set per organizer or platform-wide in admin payout settings
  (`payouts/payout-settings.service.ts`, order: organizer, platform, environment). 7 days covers the 48-hour refund window
  with room for a dispute to surface. For the pilot, leave it at 7 or more.
- **Verified-bank hold**: `markPaid` refuses unless the organizer's bank account for that currency exists and has been
  verified by a different staff member than the one who entered it, in its current version
  (`payouts.service.ts:1181`, `payouts/payout-account-safety.ts:84`). A refusal is audited and the payout stays as it was.
  PILOT-BRIEF fact: the only back-office account on QA is the super admin, so a second authorised person is an owner
  decision before any payout can be marked PAID.
- **Provider transfers**: gated off by `RAZORPAY_ROUTE_ENABLED=false` and `PAYOUT_EXECUTION_ENABLED=false` (both default
  false). Release also refuses organizers with no linked account (`settlement.service.ts:423-431`).
- **Refunds and disputes reduce the payable** before any payout. An open dispute blocks an un-transferred settlement
  (`settlement.service.ts:1052`).
- **UNKNOWN (production)**: the live values of these switches. The owner must read the production variable names and values
  in the Railway dashboard (this review never read production variables).

### 1.8 Production state the pilot inherits

- note (2026-09-29 to 2026-10-06): production serves live INR payments (`PAYMENTS_ACTIVATION_PENDING=false`); PROD
  Razorpay is a live key pair; the webhook secret mismatch is open; no PROD backup is current (`docs/ops` and
  `database-backups` notes). Re-verify each; none was read for this document.
- Production payment secrets reach the checkout path from environment variables (`PaymentProviderResolver`), but the
  readiness report and sandbox certification use the AWS-backed factory, which cannot bind Razorpay on production
  (`docs/ops/PRODUCTION-READINESS-2026-10.md` item 1). Two paths, two answers.

### 1.9 The readiness report and launch gate say less than they appear to

1. **`PAYMENT_LIVE_ENABLED` blocks no payment.** It is read only by the readiness report
   (`payment-live-readiness.service.ts:50`) and the cinema pilot-readiness report (`cinemas/pilot-readiness.service.ts:80`).
   Checkout never reads it. What actually stops a payment: `PAYMENTS_ACTIVATION_PENDING` (an adapter that refuses every
   payment), key and mode consistency checks at boot (`assertRazorpayConsistency`, `configuration.ts:993`), and the route
   table. "Enabling live payments" is therefore not one switch. Production is already past the activation-pending state (note).
2. **`GO` is unreachable for a real provider.** The launch gate needs a recent `PASS` sandbox certification
   (`readiness` check `certification`). For a real provider the certification run is `PARTIAL` by design because only the mock
   can sign an event, so the webhook and confirm steps `SKIP` (`certification/certification.spec.ts:55`,
   `certification-steps.ts:262`). `merchant-active` and `webhook-verified` are admin bookkeeping flags
   (`launch-gate.service.ts:100`). So the gate reads NO-GO for Razorpay however well production is configured.
   **QA, 2026-10-12**: `overall NO-GO`; razorpay failing `mode-live, credentials, health, merchant-active, webhook-verified,
certification`.
3. **Credentials and health come from the factory path.** On QA, `credentials` fails with
   "Secret 'payments/razorpay/test/secret-key' could not be resolved via env: not set in environment" while the app's own
   checkout path uses different variable names. The same split exists on production (note, item 1).
   `webhook-delivered`, `route` and `circuit` do not depend on that path and are the usable signals today.

Do not run sandbox certification against live keys without reading `certification-steps.ts` first: it creates a real
Razorpay order of 100 paise through the live key.

## 2. Owner action checklist

Order matters. Nothing here was executed. "Evidence" is what the owner saves in the pilot folder so another person can
check it. Do not paste secret values anywhere; record names, last four characters, dates and screenshots with secrets hidden.

Pre-condition P0: no pilot sale is open. Steps S1 to S6 run with no live checkout traffic.

| #   | Step (owner)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Acceptance evidence                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Razorpay LIVE dashboard: confirm the account is fully activated (business KYC complete, settlement bank verified, live mode on).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Screenshot of the activation status and the settlement bank (account number masked), dated.                                                                                                                                                                                                                                                                                                                                                                   |
| S2  | Razorpay LIVE dashboard: set payment capture to automatic (menu wording varies; look under payment capture or payment settings). Ask Razorpay support to confirm in writing that orders created without a capture parameter are auto-captured for this account.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Screenshot of the setting and the support reply. A later watched transaction (S6) shows the payment as `captured`, not `authorized`.                                                                                                                                                                                                                                                                                                                          |
| S3  | Razorpay LIVE dashboard: confirm enabled methods for the pilot (UPI, domestic cards, netbanking) and decide on international cards. Public check with the live key id only: `GET https://api.razorpay.com/v1/preferences?key_id=<rzp_live key id>&currency=INR` (no secret).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Saved JSON `methods` block, dated. UPI must be true if the storefront is to lead with UPI (the storefront asks this same endpoint, `razorpay-methods.service.ts`).                                                                                                                                                                                                                                                                                            |
| S4  | Rotate the webhook secret. (a) Generate a new random secret, different from `RAZORPAY_KEY_SECRET`. (b) Razorpay LIVE: Settings, Webhooks, the endpoint `https://api.eticketsgo.com/api/payments/webhooks/razorpay` (plural `webhooks`): set the new secret and subscribe to exactly: `payment.captured`, `order.paid`, `payment.failed`, `refund.processed`, `refund.failed`, `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost` (plus the acknowledged `payment.authorized`, `refund.created` if wanted; Route events are not needed while Route is off). (c) Set the same value as `RAZORPAY_WEBHOOK_SECRET` on the api and worker services. Note that a Railway variable change redeploys the latest main, so check what main contains first. (d) Record the time of the dashboard save. | After (c): a `WebhookEvent` row for provider `razorpay` with `createdAt` after (d) and status `PROCESSED` or `IGNORED` (admin webhook/ops view or database read-only query); log line `razorpay webhook processed event=...`; metric `payment_webhooks{result="signature_invalid"}` unchanged at 0. The old "send test event" button is unverified (see section 4): if the dashboard offers a resend of a recent delivery, use it; otherwise S6 is the proof. |
| S5  | Alert: create an alert on any increase of `payment_webhooks{result="signature_invalid"}`, and on `WebhookEvent` rows in `DEAD_LETTER` or `FAILED` older than 15 minutes. Name the person who is paged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Screenshot of the rule and one test page received.                                                                                                                                                                                                                                                                                                                                                                                                            |
| S6  | First live INR transaction, smallest real amount. Use a paid ticket on a platform-owned test event (not a Telangana cinema, not a USD event). Pay by UPI. Watch it to CONFIRMED. Razorpay's minimum order amount is believed to be Rs 1: confirm in the dashboard; the ticket price plus fees is what is charged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Razorpay payment id and order id, status `captured`. Booking CONFIRMED with an `ETG-IN-2026-...` reference. Ticket email received. A `payment.captured` `WebhookEvent` in `PROCESSED` created after S4(d). Screenshot of each.                                                                                                                                                                                                                                |
| S7  | Refund the stranded 2026-10-06 payment `pay_TkVxCS4BmDljlf` (Rs 519.18) in the Razorpay dashboard. The platform cannot (the booking is EXPIRED). Record the buyer contact decision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Razorpay refund id and `processed` status; a note against the finance discrepancy (resolve it as "refunded in dashboard", it moves no money by itself).                                                                                                                                                                                                                                                                                                       |
| S8  | Refund drill from the app, on S6's booking: (a) book 2 tickets, refund 1 (partial) from the organizer or admin refund screen; (b) refund the rest (full). Check the buyer's notice and credit note.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | For each: `Refund` row `COMPLETED` after `refund.processed` arrived, Razorpay refund `processed`, ticket status REFUNDED, credit note issued, booking `PARTIALLY_REFUNDED` then `REFUNDED`. Amount equals tickets plus added tax.                                                                                                                                                                                                                             |
| S9  | Settlement proof: when Razorpay settles the S6 payment, match the bank credit to the Razorpay settlement report, and to `GET /admin/payments/settlement` (gross minus refunded). Razorpay deducts its fee; our books do not model it (see section 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Bank statement line, Razorpay settlement id, and the arithmetic written out.                                                                                                                                                                                                                                                                                                                                                                                  |
| S10 | Secret store (decision plus action): give production a principal that can read `payments/razorpay/live/secret-key` and `webhook-secret` in the managed store, or accept that `credentials` and `health` stay red on the readiness report and rely on S11 (script plus S6) instead. Do not move checkout to the store without a separate change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Either: `GET /admin/payments/live-readiness` shows `credentials` and `health` passed. Or: a signed note that the owner accepts them red, with the date.                                                                                                                                                                                                                                                                                                       |
| S11 | Run the certification (section 3). `ADMIN_TOKEN=<admin token> node scripts/certification/razorpay-payment-certification.mjs` and `node scripts/certification/production-transaction-probe.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Both outputs saved. The first must end `CERTIFIED`. The second must have no `BLOCKER`.                                                                                                                                                                                                                                                                                                                                                                        |
| S12 | Payout dry run (no live organizer money): confirm Route and execution flags are false in the production variables; decide who the second verifier is; generate one payout for the S6 event after the hold; verify the bank account as the second person; try `markPaid` as the first (must refuse); then mark it paid.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Audit rows `PAYOUT_PAID` outcome `REFUSED` (reason `DESTINATION_PENDING_VERIFICATION`) then a successful one with the bank reference. Names of the two people.                                                                                                                                                                                                                                                                                                |
| S13 | Take the decision to open the pilot only when section 3 is fully green. Record who decided and when.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | A one-page sign-off listing each certification line, its evidence file and the date.                                                                                                                                                                                                                                                                                                                                                                          |

Rehearsal first, on QA (needs B6): the owner puts the current Razorpay TEST key pair on QA (the pair shown in the dashboard now;
regenerating it again revokes whatever QA holds), then S3 to S5, S6 to S8 with Netbanking (it gives an explicit success page and
needs no card number; note 2026-09-11) and `--allow-non-production` in S11. Rehearsal proves the code path and the procedure; it
proves nothing about the production secret.

## 3. "Complete payment certification" - the definition

Live INR payments may be enabled for the pilot only when every line below holds on production, on the same day, and the evidence is
saved. Lines marked (script) are checked by `scripts/certification/razorpay-payment-certification.mjs`, which reads four admin GET
endpoints, writes nothing, never calls Razorpay, and fails on anything it cannot read. Lines marked (probe) are checked by the
existing `scripts/certification/production-transaction-probe.mjs`. Lines marked (owner) need the evidence from section 2.

**A. Account and configuration**

1. (owner, S1) Razorpay LIVE account activated; settlement bank verified.
2. (owner, S2) Capture is automatic, proven by a `captured` payment.
3. (owner, S3) Pilot payment methods confirmed against the live account.
4. (script) API reports `PRODUCTION`. (script) Provider row mode is `LIVE`. (script) Credentials resolve and are live (needs S10 or its signed acceptance).
5. (script) Razorpay answers an authenticated read with these credentials (`health`).
6. (script) An active INR route points at Razorpay; circuit breaker closed.
7. (script) Secret manager healthy; maintenance mode off; `PAYMENT_LIVE_ENABLED` true.
8. (owner, S12) Route and provider-execution flags are false; payout hold days are 7 or more; a second verifier exists.

**B. Webhook**

9. (probe) The endpoint exists and refuses an invalid signature with `400 PAYMENT_WEBHOOK_INVALID`.
10. (script) A signed delivery has been accepted. (owner, S4) That delivery is newer than the last secret rotation. The script cannot see time, so the owner attaches the row's `createdAt`.
11. (owner, S5) The `signature_invalid` and dead-letter alerts exist and a test page was received.

**C. A real transaction**

12. (owner, S6) A real small INR payment went order, payment, webhook, CONFIRMED, ticket delivered, with the payment `captured`.
13. (owner, S8) A partial refund and a full refund both reached `COMPLETED` through `refund.processed`, with credit notes.
14. (owner, S7) The stranded 2026-10-06 payment is refunded.
15. (owner, S9) A Razorpay settlement for the test payment reached the bank and matches our settlement summary.

**D. Books agree**

16. (script) Reconciliation checked at least one payment in the window, with zero mismatched and zero unverifiable.
17. (script) No unresolved transfers, open findings or blocked settlements; no open finance discrepancies.

**Advisory, reported but not decisive** (script prints `ADVISE`): `merchant-active`, `webhook-verified` and `certification`. They are
admin bookkeeping or unreachable for a real provider (section 1.9, item 2). If the owner wants the launch gate to read GO,
that needs a code change that is not part of this PR.

Re-run the script and the probe immediately before the pilot opens and after any change to a payment variable, the webhook, or a key.

New in this PR: `scripts/certification/razorpay-payment-certification.mjs` and its test
`razorpay-payment-certification.test.mjs` (`node --test scripts/certification/razorpay-payment-certification.test.mjs`, 8 tests).
Falsified by removing the advisory exemption (3 failed) and by dropping the `unverifiable` condition (1 failed), then restored. The
repository's CI does not run `node --test` for `scripts/`, so the test is run by hand. It was also run in rehearsal against QA
(`--allow-non-production`) on 2026-10-12 and printed `NOT CERTIFIED`, correctly: `mode-live`, `credentials`, `health`,
`PAYMENT_LIVE_ENABLED` and `reconcile-clean` failed.

## 4. What this review could not determine

- Production: every flag, variable, secret and webhook delivery. The production Razorpay account state. Whether the dashboard
  offers a webhook test event or resend (an earlier document says "send test event"; the Razorpay webhook screen was not
  inspected, so S4 does not depend on it).
- Capture mode, enabled live methods, minimum order amount, authorization expiry period: all dashboard facts.
- Razorpay's fee on payments and refunds is not modelled anywhere in our books; the platform fee shown to organizers is ours.
  Whether Razorpay returns its fee on a refund is a Razorpay policy to confirm before pricing the pilot.
- The ledger effect of a refund issued from the Razorpay dashboard rather than the app.
- Whether maintenance mode stops checkout. There is no verified instant "stop taking payments" switch: `PAYMENTS_ACTIVATION_PENDING`
  is refused at boot when credentials are present (`configuration.ts:1044`). Decide the emergency stop (for example unpublishing the
  pilot events) before the pilot opens and write it into `INCIDENT-RESPONSE.md`.
- Stale pilot text: `LAUNCH-CHECKLIST.md` names the webhook path `/api/payments/webhook`; the real path is
  `/api/payments/webhooks/razorpay` (corrected in this PR).

## 5. QA reads used as evidence (2026-10-12, read-only)

`GET /ready` ok; `GET /admin/payments/live-readiness`, `launch-gate`, `health`, `config`, `reconciliation`, `settlement`,
`unresolved-money`, `finance/discrepancies`, `finance/aging`, `GET /admin/settlements`; one public Razorpay call,
`GET /v1/preferences?key_id=<QA public key id>` (401). One login request was needed to obtain the admin token. No POST other than that
login, no booking, no payment, no key or variable change.
