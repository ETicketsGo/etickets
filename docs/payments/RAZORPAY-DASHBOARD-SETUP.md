# Razorpay Dashboard Setup (Owner Runbook)

Exact steps the account owner performs in the **Razorpay Dashboard** to make the India
integration work. Do these first for **Test Mode**, verify end-to-end, then repeat the
credential + webhook steps for **Live Mode** after activation.

> **Nothing here is stored in the repo.** Keys and webhook secrets live in an ignored
> `.env` (local) or the deployment secret manager. `.gitignore` blocks `*.csv` and
> `razorpay_*api*key*`, but do not rely on that — never paste a secret anywhere tracked.

---

## 0. Regenerate the exposed Test key (do this first)

A previously-downloaded Razorpay **Test Mode** key was exposed. Before any use:

1. Dashboard → **Settings → API Keys** (Test Mode).
2. **Regenerate** the Test key. This invalidates the leaked pair.
3. Copy the new **Key Id** (`rzp_test_…`) and **Key Secret** shown **once**.
4. Store them outside source control (step 2). Delete any downloaded CSV immediately.

---

## 1. Enable Test-Mode payment methods

Dashboard (Test Mode) → **Settings → Payment Methods**. Enable at least:

- **UPI**
- **Cards**
- **Netbanking**
- **Wallets**

These match the adapter's declared capabilities (CARD, UPI, NETBANKING, WALLET).

---

## 2. Store the credentials (outside source control)

The integration reads three values (`configuration.ts`):

| Variable                  | Classification         | Notes                                                        |
| ------------------------- | ---------------------- | ------------------------------------------------------------ |
| `RAZORPAY_KEY_ID`         | **Public**             | `rzp_test_…` / `rzp_live_…`; may be sent to approved clients. |
| `RAZORPAY_KEY_SECRET`     | **Server secret**      | Signs the Checkout result. Never to any client/log.          |
| `RAZORPAY_WEBHOOK_SECRET` | **Server secret**      | Verifies webhooks. **Must differ from the key secret.**      |

Also set: `RAZORPAY_MODE=test` (must match the key prefix — boot fails on a mismatch),
`RAZORPAY_CURRENCY=INR`, and the Checkout branding (`RAZORPAY_CHECKOUT_NAME`,
`RAZORPAY_CHECKOUT_DESCRIPTION`, `RAZORPAY_CALLBACK_URL`).

Put them in an ignored `.env` locally, or the secret manager (`SECRET_MANAGER_PROVIDER`)
in shared environments. `env` resolution is rejected in STAGING/PRODUCTION.

---

## 3. Configure the webhook endpoint

Dashboard (Test Mode) → **Settings → Webhooks → Add New Webhook**.

1. **URL:** `{API_URL}/api/payments/webhooks/razorpay`
   (e.g. `https://api.staging.eticketsgo.example/api/payments/webhooks/razorpay`).
2. **Secret:** generate a **strong, random** secret that is **DIFFERENT** from
   `RAZORPAY_KEY_SECRET`. Paste it into `RAZORPAY_WEBHOOK_SECRET`.
   (If they match, the API refuses to boot.)
3. **Active events — subscribe ONLY to the implemented events:**

   Drive ticket issuance / refunds / disputes / Route (processed):
   - `order.paid`
   - `payment.captured`
   - `payment.failed`
   - `refund.created`
   - `refund.processed`
   - `payment.dispute.created`
   - `payment.dispute.won`
   - `payment.dispute.lost`
   - `transfer.failed`
   - `transfer.reversed`

   Acknowledged (accepted and recorded as IGNORED — safe to subscribe):
   - `payment.authorized`
   - `transfer.processed`
   - `refund.failed`
   - `settlement.processed`
   - `settlement.failed`

   Any other event the endpoint receives is recorded as IGNORED (never dropped), so an
   accidental extra subscription is harmless — but keep the list tight.

4. Save. Razorpay signs the **exact raw body** with the webhook secret.

---

## 4. Verify signature delivery

1. From the webhook's **Recent Deliveries** (or by running a Test-Mode payment), trigger a
   `payment.captured`.
2. Confirm the API returns `{ received: true }` and a `WebhookEvent` row is created and
   moves to `PROCESSED`.
3. A `401/400 Invalid webhook signature` means the dashboard secret and
   `RAZORPAY_WEBHOOK_SECRET` differ, or a proxy altered the raw body — fix before going on.

---

## 5. Apply for / activate Razorpay Route

Organizer payouts require **Route**:

1. Dashboard → **Route** (or contact Razorpay) → request activation for the platform account.
2. Complete any Route-specific onboarding Razorpay requires.
3. Only once Route is live, set `RAZORPAY_ROUTE_ENABLED=true` (default is `false`).
   While it is `false`, organizer settlements are **BLOCKED / HELD** — never a fake transfer.
4. (Optional) set `RAZORPAY_ACCOUNT_NUMBER` (platform account number) if your Route
   transfer flow requires it. This is a reference, not a secret.

---

## 6. Configure Linked Accounts + settlement

Organizers are paid via **Linked Accounts**:

1. For each organizer, create a **Linked Account** in the dashboard and complete their
   India **KYC** + **bank verification** (Linked Account status must reach `activated`).
2. The organizer links the resulting account id in ETicketsGo via
   `POST /api/organizers/:id/payments/razorpay/account`.
3. The API maps status: `created` → onboarding, `needs_clarification` → restricted,
   `activated` → enabled, `suspended` → disabled. Payout is ready only when Route is
   enabled **and** the account is active.
4. Confirm the platform account's own **bank account + settlement schedule** are configured
   so Razorpay settles platform funds to your bank.

---

## 7. Sandbox smoke test

Run the full Test-Mode flow before Live (see `RAZORPAY-LOCAL-TESTING.md` for the exact
sequence): booking → Order → Checkout (Test UPI/card) → verify → webhook `payment.captured`
→ tickets issued **once** → settlement `HELD` → refund. Confirm idempotency by
re-delivering the webhook (no double issuance).

---

## 8. Go Live

Only after Test-Mode passes and KYC/Route are activated:

1. Dashboard → switch to **Live Mode** → **Settings → API Keys** → **generate Live keys**
   (`rzp_live_…`). These are **separate** from Test keys.
2. Set `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` to the live pair and `RAZORPAY_MODE=live`
   (the prefix/mode cross-check is enforced in every environment).
3. **Repeat the webhook config in Live Mode** (§3) with a **new** strong webhook secret —
   **never reuse the Test secret in Live**, and keep it distinct from the live key secret.
4. Verify a Live signature delivery (§4).
5. Flip the platform-level live switches per the production checklist
   (`PAYMENT_LIVE_ENABLED`, secret manager, etc.).

> **Never mix Test and Live.** The boot check fails if `RAZORPAY_MODE` disagrees with the
> key prefix. Test and Live have separate keys, separate webhook secrets, and separate
> Linked Accounts.
