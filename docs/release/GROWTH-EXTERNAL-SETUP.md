# Growth release: external setup the owner must do (2026-10-27)

Code for follows, consent, campaigns, fee policies, entitlements and organizer billing is merged
(`main` b9d9355c) and certified on QA. Paid billing and campaigns are OFF in production and stay off
until each item below is done and separately approved. No credential goes in chat or in the
repository: secrets go straight into Railway variables (or a local file the deploy kit reads without
printing it).

## 1. SES: allow `updates@eticketsgo.com` (QA and production)

Today the QA SES user `eticketsgo-ses-qa` may send only as the transactional address, so a
campaign from `updates@eticketsgo.com` is refused with `AccessDeniedException` (QA certification
D2). QA campaigns currently fall back to the transactional sender. Production uses its own user
(`eticketsgo-ses-prod`, see `docs/go-live/PROD-SES-SNS-CHECKLIST.md` Gate 7).

In the AWS console (region `ap-south-1`), for EACH of `eticketsgo-ses-qa` and `eticketsgo-ses-prod`:

1. IAM > Users > the user > Permissions > edit the inline send policy.
2. Add the marketing address to the `ses:FromAddress` condition and, when a marketing
   configuration set is created (step 4), add it to `Resource`:

```json
"Resource": [
  "arn:aws:ses:ap-south-1:<account-id>:identity/eticketsgo.com",
  "arn:aws:ses:ap-south-1:<account-id>:configuration-set/<existing transactional set>",
  "arn:aws:ses:ap-south-1:<account-id>:configuration-set/<marketing set, e.g. eticketsgo-marketing-prod>"
],
"Condition": {
  "StringEquals": {
    "ses:FromAddress": ["tickets@eticketsgo.com", "updates@eticketsgo.com"]
  }
}
```

3. If `updates@eticketsgo.com` is ever verified as its own SES identity, also add
   `identity/updates@eticketsgo.com` to `Resource` (SES then authorizes against that identity).
4. Recommended (required before production marketing): SES > Configuration sets > create
   `eticketsgo-marketing-qa` / `eticketsgo-marketing-prod` with the same SNS event destination as
   the transactional set (bounce, complaint, delivery, delivery delay, reject) so campaign events
   reach `POST /api/notifications/webhooks/ses/<secret>`. Keeping marketing on its own set protects
   the transactional sending reputation.
5. Tell engineering when done. Engineering then sets, with skipDeploys, on api AND worker:
   `MARKETING_EMAIL_FROM=updates@eticketsgo.com` and `SES_MARKETING_CONFIGURATION_SET=<set name>`,
   redeploys the same commit, and sends one QA test to `success@simulator.amazonses.com`.

## 2. Footer mailing addresses (production blocker for campaigns)

Production refuses to send a campaign until the verified DeepTrics business mailing address for the
organizer's country is configured: `MARKETING_POSTAL_ADDRESS_IN` (Indian entity) and
`MARKETING_POSTAL_ADDRESS_US` (US entity). They are not secrets; provide the exact postal text when
verified. `UNSUBSCRIBE_SIGNING_SECRET` must also be set in production (engineering generates it
inside Railway; it never leaves Railway). Campaigns stay disabled in production
(`CAMPAIGNS_ENABLED` unset) until both are set and a production release is approved.

## 3. Stripe (test mode) for US organizer plans

Prices in the catalogue are BEFORE tax (USD):

| Plan    | Monthly | Yearly (10x) |
| ------- | ------- | ------------ |
| Pro     | 19.00   | 190.00       |
| Premium | 49.00   | 490.00       |

1. Stripe dashboard, TEST mode. Products: "ETicketsGo Pro", "ETicketsGo Premium". For each, two
   recurring Prices in USD at exactly the amounts above (monthly, yearly), tax behavior
   **exclusive**, no trial.
2. Send engineering the four Price ids (`price_...`, not secret). Engineering writes them into
   `BillingPrice.providerPriceRefTest` through admin (Plans & prices).
3. Settings > Billing > Customer portal: allow updating payment methods and cancelling at period
   end; turn OFF plan switching and proration.
4. Developers > Webhooks > Add endpoint: `https://api-qa.eticketsgo.com/api/billing/webhooks/stripe`,
   events exactly:
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
   `invoice.payment_failed`, `invoice.finalized`, `charge.dispute.created`.
   This must be a DIFFERENT endpoint from the ticket webhook.
5. Put the endpoint's signing secret (`whsec_...`) directly into Railway QA variables as
   `STRIPE_BILLING_WEBHOOK_SECRET` on api and worker (do not paste it in chat). Billing uses the
   existing `STRIPE_SECRET_KEY` test key unless `STRIPE_BILLING_SECRET_KEY` is set.
6. Tax (US): either turn on Stripe Tax for the account (origin address, registrations) and tell
   engineering to set `STRIPE_BILLING_AUTOMATIC_TAX=true`, or create US `TaxRule` rows (section 5).
   Without either, a US checkout is refused (`BILLING_TAX_NOT_CONFIGURED`).

## 4. Razorpay (test mode) for Indian organizer plans

1. Ask Razorpay support to enable **Subscriptions** on the account (test and later live). Until
   then checkout says paying for a plan through Razorpay is not switched on.
2. Decide the tax question in section 5 FIRST: Razorpay does not compute tax, so a Razorpay Plan's
   amount is the full amount the organizer is charged.
3. Create Plans (INR, `period` monthly or yearly, `interval` 1) for Pro and Premium, monthly and
   yearly, at the amounts that follow from section 5. Send engineering the plan ids (`plan_...`).
4. Webhooks > Add: `https://api-qa.eticketsgo.com/api/billing/webhooks/razorpay` with its own
   secret, events exactly:
   `subscription.authenticated`, `subscription.activated`, `subscription.charged`,
   `subscription.pending`, `subscription.halted`, `subscription.cancelled`,
   `subscription.completed`, `payment.failed`, `payment_link.paid`.
5. Put that secret directly into Railway QA as `RAZORPAY_BILLING_WEBHOOK_SECRET` on api and worker.
   Billing uses the existing `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` test keys unless the
   `RAZORPAY_BILLING_*` overrides are set.
6. Mandate limit: the default refuses a recurring debit above INR 15,000 (all current plans are
   below it). Tell engineering whether UPI Autopay is enabled on the account (default: assumed off).

## 5. Tax configuration (decisions first, then admin rows)

Nothing in code holds a tax rate; checkout is refused until a rule exists for the organizer's
jurisdiction.

Owner decisions needed:

- **Is the published price before tax or tax-inclusive?** The system is built as BEFORE tax: a
  Pro organizer in India would pay INR 999 + GST. If INR 999 must be the total, the catalogue
  prices must be lowered to the pre-tax amount instead (engineering change to the loaded prices,
  no code change). This has NOT been assumed approved.
- **India:** the GST rate and SAC code for the platform's service (confirm with your CA), and the
  state DeepTrics is GST-registered in (`PLATFORM_TAX_REGION`, decides CGST+SGST vs IGST). Each
  Indian organizer must have its registered state on its profile, or its checkout is refused.
- **USA:** Stripe Tax (recommended) or per-state rules for the states where you must collect.

Then, in admin > Tax rules, a `BILLING_MANAGE`/tax-capable admin creates rules with
"Organizer plans and credit packs" (`PLATFORM_SERVICES`): one India GST rule (split CGST_SGST) and,
if not using Stripe Tax, one rule per US state.

Razorpay plan amounts follow from the rate: for example, IF the decision is "before tax" and the
confirmed GST rate is R%, the Pro monthly plan is `999 x (1 + R/100)` rupees. Create plans only
after the rate is confirmed. A later rate change needs new Razorpay plans.

## 6. Still owner-only

- Credit pack prices (1,000 / 5,000 / 10,000) stay unpublished until you approve prices; then a
  `BILLING_MANAGE` admin sets and publishes them.
- Production release of this code, and switching on billing or campaigns in production, each need
  separate explicit approval.
