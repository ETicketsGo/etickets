# Incident — payment captured, booking not confirmed, inventory released

**Severity:** P0
**Date:** 2026-10-06
**Environment:** PROD (Railway env `af6f5e92-e35d-4072-a76c-3e4045cf66c9`)
**Release deployed:** `c82f3cf`
**Status:** evidence preserved; affected booking NOT mutated

No credentials, secret values or signature material appear in this record.

## Timeline (UTC)

| Time                                    | Event                                                                                                      | Source           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| 2026-10-04 06:52:08                     | `400 PAYMENT_WEBHOOK_INVALID`                                                                              | PROD api log     |
| 2026-10-04 06:58:48                     | `400 PAYMENT_WEBHOOK_INVALID`                                                                              | PROD api log     |
| 2026-10-04 07:01:26                     | `400 PAYMENT_WEBHOOK_INVALID`                                                                              | PROD api log     |
| 2026-10-04 18:52:08                     | `400 PAYMENT_WEBHOOK_INVALID`                                                                              | PROD api log     |
| 2026-10-06 04:37:20                     | `400 PAYMENT_WEBHOOK_INVALID` (x2)                                                                         | PROD api log     |
| 2026-10-06 05:53:39                     | Razorpay order ready: `order_TkVvx7pyLnoLTR`, booking `cmuw9j097000ua6sotkgz7v0q`, `amountMinor=51918 INR` | PROD api log     |
| 2026-10-06 05:54:48                     | **Real UPI payment captured** `pay_TkVxCS4BmDljlf` Rs 519.18 (11:24:48 IST)                                | Razorpay receipt |
| 2026-10-06 05:54:49                     | webhook delivery -> `400 PAYMENT_WEBHOOK_INVALID`                                                          | PROD api log     |
| 2026-10-06 05:54:50, :55, :58           | retries -> 400                                                                                             | PROD api log     |
| 2026-10-06 05:55:08 (x2), 05:55:30 (x2) | retries -> 400                                                                                             | PROD api log     |
| 2026-10-06 05:56:11 (x2), 05:57:34 (x2) | retries -> 400                                                                                             | PROD api log     |
| 2026-10-06 06:00:19 (x2)                | retries -> 400 (last delivery observed)                                                                    | PROD api log     |
| ~2026-10-06 06:03:39                    | hold lapses (order 05:53:39 + `BOOKING_HOLD_MINUTES`=10)                                                   | derived          |
| 2026-10-06 06:04:00                     | **`released expired holds { released: 1 }`** — inventory released                                          | PROD worker log  |

Deliveries arrive in pairs because Razorpay sends both `payment.captured` and `order.paid`.

## Facts

- **Booking:** `cmuw9j097000ua6sotkgz7v0q`
- **Listing:** Hyderabad Live: Comedy Night — 19 Oct 2026 1:09 pm, Shilpakala Vedika, General x 1
- **Razorpay order:** `order_TkVvx7pyLnoLTR`
- **Razorpay payment:** `pay_TkVxCS4BmDljlf`
- **Amount captured:** Rs 519.18 (tickets Rs 499.00 + payment processing Rs 10.18 + convenience Rs 10.00)
- **Method:** real UPI, live Razorpay account
- **Order created:** 2026-10-06 05:53:39Z
- **Captured:** 2026-10-06 05:54:48Z (11:24:48 IST)
- **Webhook attempts:** 13 observed on 2026-10-06, all `400 PAYMENT_WEBHOOK_INVALID`
- **Booking state transitions:** `PENDING_PAYMENT` -> `EXPIRED` by the sweep at 06:04:00Z
- **Hold expiry:** ~06:03:39Z
- **Inventory release:** 06:04:00Z (general admission counter returned to sale)
- **Ticket state:** never issued
- **Finance state:** no discrepancy recorded; no `UNAPPLIED_CAPTURE`; no receipt; no settlement line
- **Reconciliation state:** not reached — the booking never confirmed. The residue is a
  `Payment` row left `PROCESSING` (expiry only fails `REQUIRES_PAYMENT`) against an `EXPIRED`
  booking, which the existing read-only reconciliation report classifies `mismatched`.

## Evidence retention

PROD api and worker deployment logs were read via the Railway API. Railway log retention is
finite, so the quoted lines above are the preserved copy of record.

## Not done

- The affected booking, its payment row, inventory and finance records were not mutated.
- No refund issued. No webhook replayed or manufactured. No secret value printed or compared.
