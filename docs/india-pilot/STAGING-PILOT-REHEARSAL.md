# Staging pilot rehearsal

How to rehearse an India pilot against Razorpay sandbox, and what has to exist first.

**Status: BLOCKED on owner action.** The Railway CLI is not authenticated, no `uat` GitHub
Environment exists, and no Razorpay credentials are reachable from this repository. Nothing in
sections 3–7 below has been executed against a real environment, and none of it is claimed.

Everything that does not need those credentials has been done, including one thing worth
calling out: **the webhook receiver is now proven over real HTTP**, which is where the
integration risk actually lives.

### What has been proven without Razorpay

Delivered to a running API at `POST /api/payments/webhooks/razorpay` with a synthetic,
test-shaped webhook secret. This is **not** sandbox proof — no Razorpay service was contacted
— but it exercises the half of the contract a unit test with a mocked provider cannot reach:

| Delivery                            | Result                                                               |
| ----------------------------------- | -------------------------------------------------------------------- |
| Correctly signed `payment.captured` | `201 {received: true, duplicate: false}`, persisted                  |
| Same `X-Razorpay-Event-Id` again    | `201 {duplicate: true}` — claimed once, not reprocessed              |
| Wrong signature                     | `400 PAYMENT_WEBHOOK_INVALID`, nothing written                       |
| Body edited after signing           | `400` — the amount cannot be altered in flight                       |
| Identical JSON, keys re-ordered     | `400` — verification is over the **raw bytes**, not the parsed value |
| `payment.pending` (not acted on)    | `201`, persisted as `IGNORED` — never dropped, and no retry storm    |

The re-ordered-keys case is the one that matters most. If anything re-serialised the payload
before the HMAC check, every genuine Razorpay webhook would fail signature verification in
production, and no unit test that hands `verifyWebhook` a string could catch it.

**Still unproven, and only Razorpay can prove it:** that a real order can be created, that
Razorpay's own signature format matches on live traffic, its retry cadence, and a real refund.

---

## Which environment

**UAT.** Not a new environment — the promotion flow already has one:

```
feature → develop (QA) → release/* (UAT) → main (PRODUCTION, dispatch-only)
```

UAT is the right slot for three reasons that already hold, rather than because it was
convenient:

1. `isDummyAllowed` is `LOCAL | DEV | QA` — **UAT already forbids the simulated gateway**, so
   a pilot rehearsal there cannot silently run on a stub.
2. `isLiveAllowed` is `STAGING | PRODUCTION` — **UAT cannot hold live keys**, so a sandbox
   rehearsal cannot accidentally charge a real customer.
3. `.github/workflows/deploy-railway.yml` already targets `uat` from `release/*`, with its own
   `RAILWAY_TOKEN_UAT` and a `DEPLOY_ENABLED_UAT` fail-closed lock.

**No new environment name was invented, and none should be.** `PaymentEnv` also has STAGING;
using it would mean a fourth Railway project, a fourth token, and — because `isLiveAllowed`
includes STAGING — an environment where a mistyped key prefix could take real money. UAT is
strictly safer for a sandbox rehearsal.

> Using QA instead would work mechanically but is a bad idea: QA is shared, and a Razorpay
> webhook rehearsal creating and refunding orders would destabilise ordinary QA runs. It is
> also the one environment where the mock is still permitted, so a misconfiguration would
> degrade quietly to a stub rather than failing loudly.

---

## Owner actions required before step 3

| #   | Action                                                                                                                                 | Where                                                       | Why it cannot be done here                              |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------- |
| 1   | Create the Railway **UAT** environment and its Postgres + Redis                                                                        | Railway dashboard                                           | Needs account access; must not share a database with QA |
| 2   | Add `RAILWAY_TOKEN_UAT` to the `uat` GitHub Environment                                                                                | GitHub settings                                             | Repository secret                                       |
| 3   | Set repository variable `DEPLOY_ENABLED_UAT=true`                                                                                      | `gh variable set DEPLOY_ENABLED_UAT --body true`            | Deliberate fail-closed switch                           |
| 4   | Generate Razorpay **test** API keys                                                                                                    | Razorpay Dashboard → Test Mode → API Keys                   | Needs a Razorpay account                                |
| 5   | Create the webhook and choose its secret                                                                                               | Razorpay Dashboard → Webhooks                               | Needs the public UAT API hostname from step 1           |
| 6   | Set `APP_ENV=UAT`, `PAYMENT_PROVIDER_NAME=razorpay`, `RAZORPAY_MODE=test` and the three secrets on the UAT API **and worker** services | Railway variables                                           | Secrets must never enter git                            |
| 7   | Add a DNS record if a custom API hostname is wanted                                                                                    | GoDaddy / Cloudflare                                        | Domain control                                          |
| 8   | Create the INR `PaymentRoute` row for UAT                                                                                              | Admin Payments screen, or `POST /api/admin/payments/routes` | Runtime data, needs the deployed environment            |

Exact variable names and their meanings: [RAZORPAY-SANDBOX.md](./RAZORPAY-SANDBOX.md).

**Nothing above requires production credentials, and none should be used.**

---

## The rehearsal

Run it as an operator would, with the Launch Readiness page as the only guide. Use disposable
accounts throughout.

### 1 — Environment readiness (before any theater exists)

`GET /api/ready` → database and Redis up.
`GET /api/admin/payments/health` → Razorpay resolves. **It must report presence, never a
value; if a key appears in that response, stop and fix that first.**

### 2 — Readiness reports the right payment state

Open any cinema's readiness page. Expect `RAZORPAY_SANDBOX_READY`, not `PAYMENT_MOCK_ONLY`.
If it says `PAYMENT_MOCK_ONLY`, `PAYMENT_PROVIDER_NAME` is still `mock` and **the rehearsal
would prove nothing** — a mock confirms every booking it is asked to.

### 3 — Onboard a theater

Organization → admin approval → cinema (`Asia/Kolkata`) → screen → seat layout with at least
two priced categories → publish → film → publish → schedule a future show → set its price
through **Pricing** on the schedule day view.

Record blockers at the start and after each step. On a correctly configured UAT the expected
end state is **0 blockers**.

> Local evidence for the equivalent walk on the mock gateway: 5 blockers → 1, the survivor
> being `NO_INR_ROUTE`. See [QA-PILOT-GAP-REGISTER.md](./QA-PILOT-GAP-REGISTER.md).

### 4 — Buy a ticket

Customer app → film → showtime → seat map → select → hold → checkout → **Razorpay Checkout in
test mode** (Razorpay's published test cards; never a real card).

**The browser return is not the confirmation.** Verify from the server:

- `Booking.status` = `CONFIRMED`
- `Payment.status` = `SUCCEEDED`, with the Razorpay payment id as `providerRef`
- a `Ticket` row exists with a QR
- a `WebhookEvent` row for `payment.captured` is `PROCESSED`

Record the booking id, the provider reference, and both states.

### 5 — Failure and recovery

| Case                              | Expected                                                                   |
| --------------------------------- | -------------------------------------------------------------------------- |
| Cancel at the Razorpay screen     | Booking stays `PENDING_PAYMENT`; the hold expires normally                 |
| Test-card failure                 | `payment.failed` recorded; booking not confirmed; seats released on expiry |
| Close the tab before returning    | The **webhook** still confirms it — this is the case that matters most     |
| Replay the same webhook           | Second delivery no-ops via the atomic claim; exactly one ticket            |
| Tampered signature                | Refused; nothing written                                                   |
| Retry payment on the same booking | One confirmation, one ticket                                               |

### 6 — Refund

Refund a confirmed booking through the trusted API boundary (**there is no organizer refund
UI — do not build one here**). Expect the sandbox refund to reach `refund.processed`, the
refund row to complete, and the original booking's money to remain intact in history.

### 7 — Operations and audit

Live occupancy reflects the sale · the seat shows as sold on the live map · the audit log
records the reprice, the sale and the refund.

---

## Security checks to run in UAT

- The client never chooses a provider — it follows the server's `clientActionUrl`.
- A booking request carrying `unitPriceMinor` / `subtotalMinor` / `totalMinor` is ignored
  (already proven locally and in CI; re-confirm against the real gateway).
- A Razorpay order belongs to exactly one booking.
- A replayed callback is harmless; an invalid signature is refused.
- One user cannot read another's booking or payment.
- **No secret appears in any log line, error body, or client bundle.** Grep the deployed
  customer bundle for `rzp_` — only the public key id may ever appear, and only there.

---

## What "ready" will and will not mean afterwards

A green rehearsal here establishes **SANDBOX PILOT READY**: the mechanics work end to end
against a real gateway with no real money.

It does **not** establish production readiness. Still outstanding regardless of how well this
goes: live credentials and the `PAYMENT_LIVE_ENABLED` switch, settlement and payout wiring,
the **tax gap** (`Booking` has no tax column and no GST percentage exists anywhere in this
repository), an organizer refund UI, and a signed agreement with a real theater.
