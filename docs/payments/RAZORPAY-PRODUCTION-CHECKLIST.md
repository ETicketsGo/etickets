# Razorpay (India) — Production Go-Live Checklist

Gates that must all pass before accepting live INR payments and paying Indian organizers.
Do not enable live payments until every box is checked.

---

## 1. KYC & Route activation

- [ ] Platform Razorpay account **fully activated** (business KYC + bank verification
      complete; live settlements to the platform bank are configured).
- [ ] **Razorpay Route activated** on the platform account.
- [ ] `RAZORPAY_ROUTE_ENABLED=true` set **only after** Route is live.
- [ ] Each paying organizer has an **activated Linked Account** (India KYC + bank verified),
      linked in ETicketsGo via `POST /api/organizers/:id/payments/razorpay/account`, and
      `GET .../status` reports `payoutReady: true`.

> **Route-disabled rule (explicit):** while `RAZORPAY_ROUTE_ENABLED=false`, or when an
> organizer has no active Linked Account, India organizer payouts are **HELD** — the
> settlement is set **BLOCKED** with a clear reason and **no transfer is made** (never a
> fake transfer). Document the manual policy for that state (see below) and monitor for
> BLOCKED settlements.

---

## 2. Live keys & test/live isolation

- [ ] **Live keys generated** in Live Mode (`rzp_live_…`), separate from Test keys.
- [ ] `RAZORPAY_MODE=live` and `RAZORPAY_KEY_ID` is a `rzp_live_` key (boot cross-check
      passes; test/live cannot be mixed).
- [ ] The **exposed Test key was regenerated** and the leaked pair is invalid.
- [ ] Live and Test use **separate** keys, webhook secrets, and Linked Accounts.
- [ ] `RAZORPAY_WEBHOOK_SECRET` (live) is **distinct** from `RAZORPAY_KEY_SECRET` (boot
      check passes).

---

## 3. Webhook (Live)

- [ ] Live-Mode webhook registered at `{API_URL}/api/payments/webhooks/razorpay` with a
      **new** strong secret (not reused from Test).
- [ ] Subscribed to **only the implemented events** (see the dashboard runbook §3):
      `order.paid`, `payment.captured`, `payment.failed`, `refund.created`,
      `refund.processed`, `payment.dispute.created/won/lost`, `transfer.failed`,
      `transfer.reversed` (+ acknowledged: `payment.authorized`, `transfer.processed`,
      `refund.failed`, `settlement.processed`, `settlement.failed`).
- [ ] A **live signature delivery verified** (event reaches `PROCESSED`; a bad signature is
      rejected 400).
- [ ] Endpoint reachable over HTTPS with the **raw body preserved** (no proxy re-encoding —
      the HMAC is over exact bytes).

---

## 4. Secret management

- [ ] Secrets in the **deployment secret manager**, not `.env`, not source control
      (`SECRET_MANAGER_PROVIDER` is `azure`/`aws`/`gcp`; `env` is rejected in
      STAGING/PRODUCTION).
- [ ] `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` **never** sent to any client or
      log; only `RAZORPAY_KEY_ID` may reach approved clients.
- [ ] No key/CSV in the repo (`.gitignore` blocks `*.csv`, `razorpay_*api*key*`).

---

## 5. Platform live switches

- [ ] `APP_ENV=PRODUCTION` (or `STAGING`) — production hardening checks active.
- [ ] `PAYMENT_LIVE_ENABLED=true` (master switch; ADR-028) once ready.
- [ ] `STRIPE_SETTLEMENT_RESERVE_BPS` reviewed (shared reserve config; also applies to
      Razorpay releases).
- [ ] Currency routing verified: INR → Razorpay, USD → Stripe, mismatched country rejected.

---

## 6. Ops readiness — runbook links

- [ ] Settlement / release / BLOCKED-hold policy — see `INDIA-PAYMENTS-RUNBOOK.md` §Route.
- [ ] Refund + transfer-reversal handling — `INDIA-PAYMENTS-RUNBOOK.md` §Refunds.
- [ ] Dispute handling — `INDIA-PAYMENTS-RUNBOOK.md` §Disputes.
- [ ] Reconciliation + dead-letter monitoring — `INDIA-PAYMENTS-RUNBOOK.md` §Reconciliation.
- [ ] Key rotation procedure — `INDIA-PAYMENTS-RUNBOOK.md` §Key rotation.

---

## 7. Known follow-ups (not blockers, but tracked)

- [ ] **GST computation exists; the RATES have not been reviewed.** Confirm the table in
      `docs/guides/INDIA-GST.md` with your accountant BEFORE activating any rule at
      admin → Tax rules. Nothing is taxed until one is switched on. Separately confirm who
      owns filing — the platform records what was charged and files nothing.
