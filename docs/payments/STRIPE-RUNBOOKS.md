# Stripe — Operational Runbooks

Operator procedures for the ETicketsGo Stripe + Connect integration. Assumes the
Separate Charges and Transfers model (the **platform is the merchant of record**);
see `STRIPE-ARCHITECTURE.md` for the model and `STRIPE-ENVIRONMENT.md` for config.

Key admin surfaces:

- `GET /admin/settlements`, `GET /admin/settlements/:id`
- `POST /admin/settlements/:id/approve` · `…/release` · `…/block` (ADMIN / SUPER_ADMIN)
- `GET /organizers/:id/payments/status`
- Worker sweeps: `process-webhooks` (webhook retry/dead-letter, ~15s) and settlement
  promotion (`promoteCompletedEvents`) in `apps/worker/src/main.ts`.

---

## 1. Refund handling (incl. post-transfer reversal)

**How refunds flow.** A refund is issued against the **platform** PaymentIntent
(`refunds.create`, `stripe-payment.provider.ts`) — via the app's refund flow or the
Stripe dashboard. Stripe then emits `charge.refunded`, and the processor
(`handleChargeRefunded`) reconciles it:

- It computes `delta = charge.amount_refunded − Payment.refundedMinor`; if
  `delta <= 0` it is an idempotent no-op (already accounted).
- It updates `Payment.refundedMinor` and sets `REFUNDED` (full) or
  `PARTIALLY_REFUNDED`.
- It deducts the organizer's **proportional** share
  (`round(delta × organizerNet / amount)`) from the event's settlement via
  `applyRefund`.

**Pre-transfer refund** (settlement not yet `TRANSFERRED`): the share is added to
`Settlement.refundsMinor` and simply reduces what will be transferred — the release
recomputes payable with `computeSettlementPayable` immediately before moving funds.
No clawback needed.

**Post-transfer refund** (settlement already `TRANSFERRED`): `applyRefund` claws the
money back with `transfers.createReversal` for `min(share, transferredMinor)`
(idempotency key `reverse_<settlementId>_<refundsMinor>`). The settlement becomes
`PARTIALLY_REFUNDED`, or `REVERSED` if fully clawed back; `transferredMinor` is
decremented.

**Operator steps.**

1. Issue the refund through the app's refund flow (preferred) or the dashboard.
2. Confirm `charge.refunded` was received and `PROCESSED`
   (`WebhookEvent` where `eventType = charge.refunded`).
3. Check `GET /admin/settlements/:id` — `refundsMinor` should reflect the organizer
   share; for a post-transfer refund confirm a reversal and the updated status.
4. If a reversal fails, ops are notified (`TRANSFER_FAILED`); investigate the
   connected account's balance (a reversal can fail if the connected account has
   already paid out and lacks balance) and retry.

---

## 2. Dispute response (platform is merchant of record)

**How disputes flow.** Because charges land on the platform, **disputes settle
against the platform account**. `charge.dispute.created/updated/closed` →
`DisputeService.syncFromWebhook`:

- Mirrors the dispute into the `Dispute` model (mapped `status`, raw `stripeStatus`,
  `amountMinor`, `evidenceDueBy`), linking payment/booking/organization/event.
- While **open** (`NEEDS_RESPONSE` / `UNDER_REVIEW`): flags the booking `DISPUTED`,
  **blocks** the event's settlement if it is still transitionable to `BLOCKED`
  (un-transferred proceeds are held), and notifies admins.
- On **lost**: records the loss into `Settlement.disputesMinor`; if funds were
  already transferred, claws them back (via `applyRefund` → transfer reversal).

**Operator steps.**

1. Triage from the admin dispute notification. Note `evidenceDueBy` — Stripe's
   deadline is hard.
2. Gather evidence (ticket delivery, check-in/scan records, buyer comms, the signed
   QR issuance) and submit it in the **Stripe dashboard** (Payments → Disputes).
3. Keep the settlement **blocked** until the dispute closes. To unblock manually,
   `POST /admin/settlements/:id/block` is for blocking; a blocked settlement returns
   to the flow via the allowed transitions (`BLOCKED → ELIGIBLE / HELD / PENDING`)
   once the dispute resolves and the ledger re-syncs.
4. On **won**: `charge.dispute.closed` (won) updates the record; re-evaluate the
   settlement for release.
5. On **lost**: the loss is recorded (and reversed if already paid out). Reconcile
   `disputesMinor` before the next release.

---

## 3. Settlement reconciliation + release approval flow

**Lifecycle.** `PENDING → HELD → ELIGIBLE → APPROVED → TRANSFER_PROCESSING →
TRANSFERRED` (with `PARTIALLY_REFUNDED` / `REVERSED` after transfer, and `BLOCKED` /
`FAILED` branches). Transitions are guarded by `canTransitionSettlement`.

**Accrual.** On each successful payment, `onPaymentSucceeded → syncForEvent`
aggregates `organizerNetMinor` / `platformFeeMinor` across the event's `SUCCEEDED`
payments into the settlement and links those payments to it (idempotent). Before the
event completes the settlement sits at `HELD`.

**Promotion.** When the event is `COMPLETED`, the worker's settlement sweep
(`promoteCompletedEvents`) moves `PENDING/HELD → ELIGIBLE`.

**Approval + release (admin).**

1. `GET /admin/settlements?status=ELIGIBLE` — review each: `grossSalesMinor`,
   `refundsMinor`, `disputesMinor`, `transferredMinor`, linked payments, and any open
   disputes.
2. `POST /admin/settlements/:id/approve` → `APPROVED` (records `approvedByUserId`).
3. `POST /admin/settlements/:id/release`:
   - Atomically claims `APPROVED/FAILED → TRANSFER_PROCESSING` (concurrent releases
     cannot both transfer).
   - **Recomputes payable immediately before transfer** via
     `computeSettlementPayable` (gross − refunds − disputes − priorTransferred −
     reserve). Reserve = `STRIPE_SETTLEMENT_RESERVE_BPS`.
   - If `payable <= 0`, closes out cleanly as `TRANSFERRED` with `payableMinor = 0`.
   - Otherwise `transfers.create` to the connected account (idempotency key
     `settlement_<id>_<transferredMinor>`), records `providerTransferId`, sets
     `TRANSFERRED`, and notifies the organizer.
4. **Reconcile:** the sum of settlement `payableMinor` (net of reserves) plus retained
   `platformFeesMinor` plus refunds/disputes should reconcile against the platform
   Stripe balance for the event. After transfer, the organizer's **bank** payout is
   Stripe's standard connected-account payout schedule (visible in their Express
   dashboard) — not something ETicketsGo schedules.

Release is idempotent: a settlement already `TRANSFERRED` returns unchanged, and the
Stripe idempotency key prevents a duplicate transfer even under a double call.

---

## 4. Key rotation

Two secrets rotate: `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Both live in the
secret store (git-ignored `.env` locally; secret manager in staging/prod).

**Secret key (`sk_…`).**

1. Dashboard → Developers → API keys → **Roll** (or create an additional restricted
   key). Rolling supports a short overlap where the old key still works.
2. Update the secret reference (e.g. `payments/stripe/live/secret-key`) in the secret
   manager.
3. Roll the API (the adapter reads the key at construction; `SECRET_CACHE_TTL_MS`
   bounds how long a resolved secret is cached).
4. Verify: `healthCheck` (Stripe balance retrieve) succeeds, a test checkout and a
   `GET /organizers/:id/payments/status` work.
5. Once confirmed, **revoke** the old key in the dashboard.

**Webhook signing secret (`whsec_…`).**

1. This is per-endpoint. Prefer creating/rotating the endpoint secret in the dashboard
   (Developers → Webhooks → the endpoint → **Roll secret**), which offers a rollover
   window where both old and new secrets verify.
2. Update `STRIPE_WEBHOOK_SECRET` in the secret manager and roll the API within the
   window.
3. Verify a `stripe trigger`/live event is accepted (`WebhookEvent` recorded, not a
   400). Then expire the old secret.

Never mix test and live secrets across environments during a rotation.

---

## 5. Troubleshooting

### Bad signature (HTTP 400 `PAYMENT_WEBHOOK_INVALID`)

`verifySignedEnvelope` rejected the event. Common causes:

- Wrong `STRIPE_WEBHOOK_SECRET` for this endpoint/environment (test secret on a live
  endpoint or vice-versa) — the #1 cause.
- The raw body was altered before verification (a proxy/body-parser re-serialized it).
  The controller reads `req.rawBody` exactly; ensure nothing upstream mutates it.
- Using the Stripe CLI locally without setting `STRIPE_WEBHOOK_SECRET` to the
  `whsec_…` that `stripe listen` printed.
  Fix: align the secret to the endpoint, redeploy, and replay the event from the
  dashboard (Developers → Webhooks → the event → **Resend**).

### Duplicate events

Expected and safe. Ingestion keys on the unique `(provider, providerEventId)` and
returns `{received, duplicate:true}` for anything already `PROCESSED`/`PROCESSING`;
ticket issuance additionally uses an atomic `PENDING_PAYMENT → CONFIRMED` claim, and
transfers/refunds use deterministic idempotency keys. No action needed.

### Dead-lettered webhooks

After `MAX_ATTEMPTS` (6) failed attempts an event is set `DEAD_LETTER` and an audit
`WEBHOOK_DEAD_LETTER` is recorded. Investigate:

1. Find the row: `WebhookEvent` where `processingStatus = DEAD_LETTER` — read
   `errorMessage`, `eventType`, `providerEventId`.
2. Fix the root cause (e.g. a booking/payment the event referenced, a downstream
   outage).
3. Re-drive it: the sweep only retries `RECEIVED`/`FAILED` under the cap, so to
   reprocess a dead-lettered event reset its `processingStatus` to `FAILED` (and
   `attempts` below the cap) so `process-webhooks` picks it up — or resend the event
   from the Stripe dashboard, which arrives with the same event id and is handled
   idempotently.

### Transfer failures (settlement `FAILED`)

On `transfers.create` error, release sets the settlement `FAILED` with
`failureMessage` and notifies admins (`TRANSFER_FAILED`); a `transfer.failed` webhook
is a backstop (`onTransferFailed`). Common causes: connected account not
`payouts_enabled`, currency mismatch, or insufficient platform balance. Fix the
account/config, then simply **re-release** — `FAILED` is releasable
(`isReleasableSettlementStatus`) and the idempotency key
`settlement_<id>_<transferredMinor>` prevents a double transfer.

### Organizer not `charges_enabled`

Checkout is gated: if the organizer has no connected account or `chargesEnabled` is
false, `createIntent` throws `PAYMENT_PROVIDER_UNAVAILABLE` (409) — the organizer
cannot sell paid tickets. Resolve by having the organizer finish onboarding:

1. `GET /organizers/:id/payments/status` — inspect `onboardingStatus`,
   `requirementsDue`, `disabledReason`.
2. `POST /organizers/:id/payments/stripe/onboarding-link` and have them complete the
   Stripe-hosted flow (submit the outstanding `requirementsDue`).
3. `account.updated` syncs the account (`syncByProviderAccountId`); once
   `chargesEnabled` is true, checkout works. `getStatus` also does a live
   `accounts.retrieve` refresh, so status is current even before the webhook lands.
