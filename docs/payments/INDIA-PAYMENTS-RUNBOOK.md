# India Payments (Razorpay + Route) — Operations Runbook

Day-2 operations for the India payment path. Grounded in the implementation; see
`RAZORPAY-ARCHITECTURE.md` for the full design and diagrams.

| Area                      | Source                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Routing + money math      | `packages/shared-types/src/marketplace.ts`                                          |
| Adapter                   | `apps/api/src/payments/provider/razorpay-payment.provider.ts`                       |
| Order / Checkout / verify | `apps/api/src/payments/razorpay/razorpay-order.service.ts`                          |
| Webhook pipeline          | `apps/api/src/payments/razorpay/razorpay-webhook.{controller,service,processor}.ts` |
| Linked Account onboarding | `apps/api/src/payments/razorpay/razorpay-connect.service.ts`                        |
| Settlement / refunds      | `apps/api/src/payments/settlement/settlement.service.ts`                            |
| Config / boot guards      | `apps/api/src/config/configuration.ts`                                              |

---

## Routing

Provider is chosen server-side from **trusted business data** (`routeProviderForBooking`):
`INR → razorpay`, `USD → stripe`, else rejected (400 `No payment provider supports
currency …`). Country is a consistency guard only (India tokens: `IN`/`IND`/`INDIA`).
Never trust a client-supplied provider. The Order flow engages only when the booking is INR
**and** `RAZORPAY_KEY_ID` is configured. US/Stripe and IN/Razorpay run simultaneously
because adapters are constructed lazily per provider and cached.

## Order + Checkout

- `createIntent` (INR) → `orders.create` with `amount` in **paise**, `receipt = bookingId`,
  `notes = { bookingId, eventId?, organizerId? }` — **internal ids only, never buyer PII**.
- Charges land on the **platform** account. The client gets a signature-free payload
  (`keyId`, `orderId`, `amount`, `prefill`, `callbackUrl`) — **never** the key secret.
- **Retry-safe:** a pending order already stored is returned as-is; a second payable order
  is never created.

## Signature verification (two secrets)

- **Checkout:** `verifyCheckoutSignature` = HMAC-SHA256 of `order_id|payment_id` with
  **`RAZORPAY_KEY_SECRET`**, timing-safe. The verify endpoint also requires the returned
  order id to match the stored order. Verify records a `PaymentAttempt` and stores the
  payment id — it **never issues tickets**.
- **Webhook:** `verifySignedEnvelope` = HMAC-SHA256 of the **raw body** with
  **`RAZORPAY_WEBHOOK_SECRET`** (distinct secret), timing-safe vs `X-Razorpay-Signature`.
  The browser redirect is never proof of payment.

## Ticket issuance (authoritative, webhook-only)

The processor maps `order.paid`/`payment.captured` → `payment.succeeded` and calls the
**shared** `PaymentsService.confirm`, which requires: booking `PENDING_PAYMENT`, provider
`amountMinor == booking.totalMinor` (mismatch → `PAYMENT_AMOUNT_MISMATCH`, no tickets,
flagged for reconciliation), and an **atomic** `PENDING_PAYMENT → CONFIRMED` claim so only
the first delivery issues tickets. Idempotent across re-deliveries.

### Webhook pipeline internals

- Dedup key = `X-Razorpay-Event-Id` header if present, else SHA-256 of the raw body
  (Razorpay event ids are not guaranteed unique). Stored as `WebhookEvent`
  (`provider=razorpay`); a PROCESSED/PROCESSING duplicate short-circuits.
- Processing: atomic `RECEIVED/FAILED → PROCESSING` claim, `attempts++`; on error → `FAILED`
  and retried by the sweep (30s backoff); **`DEAD_LETTER` after 6 attempts** (audited
  `WEBHOOK_DEAD_LETTER`). Unknown/no-op events are recorded **IGNORED**, never dropped.
- **Handled → processed:** `order.paid`, `payment.captured`, `payment.failed`,
  `refund.created`, `refund.processed`, `payment.dispute.created/won/lost`,
  `transfer.failed`, `transfer.reversed`.
- **Acknowledged → ignored:** `payment.authorized`, `transfer.processed`, `refund.failed`,
  `settlement.processed`, `settlement.failed` (these are Razorpay's own bank settlements to
  the platform / precede-capture / surfaced elsewhere).

## Route + Linked Accounts + settlement release

- Settlements are one per `(eventId, currency)`; `provider` derives from the payments
  (INR → razorpay). Lifecycle `PENDING → HELD → ELIGIBLE → APPROVED →
TRANSFER_PROCESSING → TRANSFERRED` (+ `PARTIALLY_REFUNDED/BLOCKED/FAILED/REVERSED`).
- Release recomputes payable immediately before transfer (− refunds, disputes, prior
  transfers, reserve `STRIPE_SETTLEMENT_RESERVE_BPS`), then `transfers.create` to the
  organizer's Linked Account (INR), atomic single-release claim, deterministic idempotency
  key.
- **Route gate:** if `RAZORPAY_ROUTE_ENABLED=false` → settlement **BLOCKED**
  _"Razorpay Route is not enabled; organizer payout is on hold."_ If enabled but no
  `connectedAccountId` → **BLOCKED** _"No active Razorpay linked account for this
  organizer."_ No fake transfer, no FAILED (this is a policy hold).
- **Onboarding:** Linked Account creation + KYC happen in the Razorpay dashboard; the
  organizer links the id via `POST /organizers/:id/payments/razorpay/account` and the API
  syncs status (`created`→onboarding, `needs_clarification`→restricted, `activated`→enabled,
  `suspended`→disabled). `payoutReady = routeEnabled && payoutsEnabled`.

## Refunds + transfer reversal

- `refund.created`/`refund.processed` → match the `Payment` by `providerPaymentIntentId`,
  accumulate `refundedMinor` (capped at capture; per-refund amounts are additive and
  idempotent via the cap), set `PARTIALLY_REFUNDED`/`REFUNDED`, and deduct the organizer's
  proportional share from the settlement (`applyRefund`).
- If the settlement was **already TRANSFERRED**, `applyRefund` reverses the proportional
  amount via Route (`transfers.reverse`) → `PARTIALLY_REFUNDED`/`REVERSED`. A failed
  reversal alerts admins (`TRANSFER_FAILED`); it does not silently pass.

## Disputes

`payment.dispute.created/won/lost` → shared `DisputeService.syncFromWebhook` (mapped to
open/won/lost). An open dispute blocks an un-transferred settlement; a **lost** dispute
records the loss and, if funds already moved, claws it back via reversal.

## Reconciliation

- Amount mismatches are refused and audited `PAYMENT_AMOUNT_MISMATCH` — investigate before
  manual issuance.
- Monitor `WebhookEvent` rows in `DEAD_LETTER` (audited `WEBHOOK_DEAD_LETTER`) and `FAILED`
  past max attempts.
- Monitor settlements in `BLOCKED` (Route/linked-account holds) and `FAILED` (transfer
  errors; a `transfer.failed` webhook also marks FAILED for ops retry).
- `getPayment` fetches a payment's authoritative state for reconcile/verify.

## Test / live separation

Enforced in **every** environment (`assertRazorpayConsistency`): `RAZORPAY_MODE` must match
the key prefix (`rzp_test_`↔`test`, `rzp_live_`↔`live`) — mixing fails boot;
`RAZORPAY_WEBHOOK_SECRET` must be **distinct** from `RAZORPAY_KEY_SECRET`. Test and Live
have separate keys, webhook secrets, and Linked Accounts. Never reuse Test secrets in Live.

## Key regeneration / rotation

- The previously-exposed **Test key was regenerated** and the leaked pair is dead. If any
  key is suspected exposed: regenerate in the dashboard, update the secret manager, redeploy;
  the old pair stops working immediately.
- Rotate the **webhook secret** by updating the dashboard webhook + `RAZORPAY_WEBHOOK_SECRET`
  together (they must stay in sync, and distinct from the key secret).

## Secret storage

- `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` are **server secrets** — never to any
  client or log. `RAZORPAY_KEY_ID` is public (may reach approved clients).
- Store secrets in the deployment secret manager (`SECRET_MANAGER_PROVIDER`; `env` rejected
  in STAGING/PRODUCTION), not in tracked files. `.gitignore` blocks `*.csv` and
  `razorpay_*api*key*`, but never paste secrets into tracked files regardless.

## Dashboard webhook config

Endpoint `{API_URL}/api/payments/webhooks/razorpay`; subscribe only to the implemented
events (above). Requires the raw body preserved end-to-end (HMAC over exact bytes). See
`RAZORPAY-DASHBOARD-SETUP.md`.

## Route activation requirements

Route must be activated by Razorpay on the platform account, `RAZORPAY_ROUTE_ENABLED=true`,
and each organizer must have an **activated** Linked Account before any payout executes.
Until then payouts are HELD/BLOCKED with a clear reason.

## Known manual steps

- Linked Account creation + India KYC/bank verification: **Razorpay dashboard** (not fully
  API-onboardable here) — the organizer then links the id.
- Route activation and the platform's own live activation are manual dashboard/partner steps.
- Settlement **approve** and **release** are admin actions.
- **GST computation EXISTS and ships switched off.** Rates are `TaxRule` rows, editable at
  admin → Tax rules; see `docs/guides/INDIA-GST.md`. Tax invoices are issued once the seller
  records a GSTIN. **No rate here has been confirmed by an accountant, nothing is filed, and
  state entertainment duty on convenience fees is not modelled.** Activating the rules is a
  deliberate act, not a consequence of deploying.
