# Razorpay reconciliation worksheet: four unresolved production payments (2026-10-12)

Owner worksheet. Engineering filled the application side from a read-only production query on 2026-10-12. The
owner fills the Razorpay side from the LIVE dashboard. Do not paste keys, secrets or customer contact details here.
Do not start a refund from this worksheet; each refund needs its own authorization (column "Proposed action").

## What the application knows

All four rows have the same shape: an order was created at Razorpay, and nothing came back that the application
accepted. There is no payment id, no Razorpay status, no payment attempt, no paid time and no refund. The booking
expired after its hold. "PROCESSING" here means "order created", **not** "captured".

| #   | Razorpay order id      | Created (UTC)    | Amount (INR) | Event (test)                   | App payment status | App booking status | Tickets issued |
| --- | ---------------------- | ---------------- | ------------ | ------------------------------ | ------------------ | ------------------ | -------------- |
| 1   | `order_Ti0ZgG4TUERr8s` | 2026-09-29 21:54 | 830.28       | Hyderabad Live: Music Festival | PROCESSING         | EXPIRED            | 0              |
| 2   | `order_Ti9ywwxLCj7NHY` | 2026-09-30 07:07 | 830.28       | Hyderabad Live: Music Festival | PROCESSING         | EXPIRED            | 0              |
| 3   | `order_TiB668NA23wep9` | 2026-09-30 08:12 | 830.28       | Hyderabad Live: Music Festival | PROCESSING         | EXPIRED            | 0              |
| 4   | `order_TkVvx7pyLnoLTR` | 2026-10-06 05:53 | 519.18       | Hyderabad Live: Comedy Night   | PROCESSING         | EXPIRED            | 0              |

Earlier evidence (not in these rows): on 2026-10-06 a real payment `pay_TkVxCS4BmDljlf` for Rs 519.18 was captured
and its webhook was rejected because the webhook secret did not match at that time. It most likely belongs to row 4;
confirm it in the dashboard.

Both events are test events and are PAUSED since 2026-10-12 19:16 UTC (audited). No customer holds a ticket.

## How to fill the Razorpay side (LIVE mode)

For each order id: Dashboard, Transactions, Orders, search the order id, open it, and read the payments listed under
it. An order can have zero, one or several payment attempts.

| Razorpay order status | Meaning                                                |
| --------------------- | ------------------------------------------------------ |
| `created`             | Nobody tried to pay. No money moved.                   |
| `attempted`           | Payment tried and failed or abandoned. Check payments. |
| `paid`                | At least one payment captured. Money was taken.        |

| Razorpay payment status   | Meaning                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `created` / `failed`      | No money taken.                                                                                                              |
| `authorized`              | Money held, not captured. Razorpay auto-refunds uncaptured authorizations after its window unless captured. Record the date. |
| `captured`                | Money taken. With no ticket issued, this must be refunded.                                                                   |
| `refunded` (full/partial) | Already returned. Record the refund id and date.                                                                             |

## Worksheet (owner fills the right-hand columns)

| #   | Order id               | Order status | Payment id(s) | Payment status | Captured amount | Refund id / status | Settled to our bank? | Proposed action | Approved by / date |
| --- | ---------------------- | ------------ | ------------- | -------------- | --------------- | ------------------ | -------------------- | --------------- | ------------------ |
| 1   | `order_Ti0ZgG4TUERr8s` |              |               |                |                 |                    |                      |                 |                    |
| 2   | `order_Ti9ywwxLCj7NHY` |              |               |                |                 |                    |                      |                 |                    |
| 3   | `order_TiB668NA23wep9` |              |               |                |                 |                    |                      |                 |                    |
| 4   | `order_TkVvx7pyLnoLTR` |              |               |                |                 |                    |                      |                 |                    |

## Proposed action by outcome (for approval, not executed)

| Razorpay shows                       | Proposed action                                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Order `created`, no payments         | None. Record "no money moved". Close.                                                                             |
| Only failed payments                 | None. Record the payment ids. Close.                                                                              |
| `authorized`, not captured           | Do not capture. Record the authorization date; confirm Razorpay's automatic release; close when released.         |
| `captured`, not refunded             | Full refund from the Razorpay dashboard (no ticket was issued). Owner approval per payment. Record the refund id. |
| Already refunded                     | Record the refund id and date. Close.                                                                             |
| Captured more than once on one order | Refund every captured payment (no ticket was issued for any). Escalate as a duplicate-charge incident.            |

Why refunds go through the dashboard and not the app: the application has no captured payment on these bookings
(the payment id never reached it), and the bookings are EXPIRED, so the app's refund path cannot act on them.

## After the owner fills it

Engineering will: (1) record the outcome in this file without customer data; (2) if any payment was captured,
re-check that the webhook path now accepts signed payment events (one small live payment after the approved
production deploy); (3) leave the four application rows as they are. They are the evidence; no data is changed.
