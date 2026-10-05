# First production transaction runbook

One controlled, low-value Indian purchase, executed deliberately and watched at every step.
**Nothing in this document has been executed.**

Pair this with `FIRST_RAZORPAY_PAYMENT_RUNBOOK.md`, which has the log lines and the failure
table. This one is the procedure and the arithmetic.

---

## 1. Pre-flight — every line must read PASS

Do not start if any line is not PASS. The point of a gate is that it is allowed to stop you.

| #   | Gate                                      | How to establish it                                                                                                                                          | Status at `c77a9cd`                                        |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 1   | **Fresh verified DB backup**              | A `backup written` + `verified yes` line with **today's** date, and the artifact in the listing. A green nightly job and a SUCCESS deployment prove nothing. | **FAIL** — newest is 2026-09-29                            |
| 2   | **All five services on the approved SHA** | `node scripts/deploy/verify-deployed.mjs` — compares the _running_ SHA per service                                                                           | **FAIL** — 144-163 commits behind                          |
| 3   | **Production probe**                      | `node scripts/certification/production-transaction-probe.mjs` → `0 blockers`                                                                                 | **FAIL** — 2 blockers (demo wording, `.example` contacts)  |
| 4   | **Razorpay LIVE on the checkout path**    | `[PaymentConfigService] bootstrapped razorpay:LIVE; routes INR->razorpay` in the API boot log                                                                | **PASS**                                                   |
| 5   | **Webhook registered**                    | Razorpay dashboard, URL + events per the payment runbook, secret matching `RAZORPAY_WEBHOOK_SECRET`                                                          | **UNPROVEN** — only a paid purchase closes it              |
| 6   | **Notification deliverable**              | Email via SES configured. **SMS/WhatsApp/push are not**                                                                                                      | **PARTIAL** — email only; see the DLT inventory            |
| 7   | **GST decision**                          | Activate or deliberately defer. Deferring is a decision, not an omission                                                                                     | **OPEN** — Q1 and Q10 in `INDIA_GST_BUSINESS_DECISIONS.md` |
| 8   | **Business/legal blockers**               | The MUST-HAVE table in `PRODUCTION_BUSINESS_DETAILS_CHECKLIST.md`                                                                                            | **FAIL** — 7 items                                         |
| 9   | **Monitoring available**                  | The log greps in the payment runbook return something                                                                                                        | **PARTIAL** — #215 merged; needs a deploy to take effect   |
| 10  | **Finance/Payout safety understood**      | `PAYOUT_EXECUTION_ENABLED` off, `SETTLEMENT_REVERSAL_RECONCILE_ENABLED` unset, Route off                                                                     | **PASS**                                                   |

**Also decide before starting:** which event, which show, which seat, and the exact amount you
expect. Write the amount down **before** you see the checkout screen, so the comparison is a
check and not a rationalisation.

Use the cheapest real ticket you have. A Rs 100 cinema seat exercises the 5% band and the
smallest fee tier; the arithmetic in §3 is already worked for it.

---

## 2. The purchase, step by step

No step may be inferred. If you cannot see the evidence, stop at that step.

| #   | Action                               | Evidence before continuing                                                                                                       |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Pick the controlled listing and show | The show is `PUBLISHED`, on sale, and has the seat you intend                                                                    |
| 2   | Select one ticket                    | Seat held; `BookingItem` reflects it                                                                                             |
| 3   | **Capture the quote**                | `POST /bookings/quote` response saved verbatim — subtotal, booking fee, payment fee, tax, total                                  |
| 4   | **Record the expected amount**       | Written down, from §3, before paying                                                                                             |
| 5   | Begin checkout                       | `Booking.status=PENDING_PAYMENT`; no `reference` yet                                                                             |
| 6   | Razorpay Checkout opens              | `razorpay order ready order=… booking=…` (once deployed); order id noted                                                         |
| 7   | Pay with a real method               | Razorpay dashboard shows `pay_…` captured; **amount equals step 4**                                                              |
| 8   | **Capture the provider payment id**  | `pay_…` written down                                                                                                             |
| 9   | Webhook observed                     | `WebhookEvent` row, `processingStatus=PROCESSED`                                                                                 |
| 10  | Booking CONFIRMED                    | `Booking.status=CONFIRMED`, `confirmedAt` set, `reference` = `ETG-IN-2026-…`                                                     |
| 11  | Ticket created                       | `Ticket` row(s), `status=ACTIVE`, one per unit/seat                                                                              |
| 12  | QR generated                         | Ticket face renders; QR verifies against `QR_SIGNING_SECRET`                                                                     |
| 13  | Email observed                       | `Notification` `type=BOOKING_CONFIRMED` **and** the message in the inbox. **No SMS will arrive** — that is expected, not a fault |
| 14  | Buyer order history                  | The booking appears in the buyer's account (or via the guest link)                                                               |
| 15  | Organizer view                       | The sale appears in the organizer console for that event                                                                         |
| 16  | Finance entry                        | `Settlement` moved for the event. Accrual is fire-and-forget, so allow a moment                                                  |
| 17  | Reconciliation                       | No open `SettlementReconciliationFinding`; §3 balances to zero                                                                   |

Between steps 7 and 9, if nothing appears within a couple of minutes: **do not pay again and do
not confirm by hand.** Go to the failure table in the payment runbook. The money is not lost;
the question is only whether the webhook authenticated.

---

## 3. Money conservation worksheet

Fill in from the quote and the Razorpay dashboard. **Minor units throughout** — paise, not
rupees — because that is what every row in the database holds and converting twice is how a
discrepancy gets invented.

```
BUYER SIDE
  Ticket / subtotal            ____________ paise
  Booking fee                  ____________
  Payment fee                  ____________
  GST                          ____________   (0 while the rules are inactive)
  ------------------------------------------
  Buyer charged                ____________   <- must equal Booking.totalMinor
                                              <- must equal the Razorpay payment amount

PLATFORM SIDE
  Razorpay fee + its GST       ____________   (from the Razorpay dashboard, not computed)
  ETicketsGo retains           ____________   (customer fee, less any GST we owe on it)
  Organizer accrues            ____________   (Settlement for the event)
  ------------------------------------------
  Difference                   ____________

EXPECTED: Difference = 0
```

For the worked Rs 100 cinema case with GST **inactive** (today's configuration):

|                   | paise     |
| ----------------- | --------- |
| Ticket            | 10000     |
| Booking fee       | 500       |
| Payment fee       | 210       |
| GST               | 0         |
| **Buyer charged** | **10710** |

With GST **active** the buyer is charged **10838** — the extra 128 is the 18% on the Rs 7.10
fee. Whichever state you launch in, the figure you wrote at step 4 must match.

Three identities to check, not one total:

1. `Booking.totalMinor` **=** Razorpay payment amount **=** what you wrote at step 4.
2. `Payment.amountMinor` **=** `Booking.totalMinor`. A mismatch here is what raises
   `PAYMENT_AMOUNT_MISMATCH`, and tickets are deliberately not issued.
3. Organizer accrual **+** what we retain **+** the provider's fee **=** buyer charged.

Any unexplained paise is a stop, not a rounding note. Inclusive GST is the one thing that makes
a total _look_ wrong while being right — it is inside the ticket price, so it is not an addend.

---

## 4. Abort points, and the first safe action

| Condition                                               | First safe action                                                                                                                                                                                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Razorpay says captured, booking stays `PENDING_PAYMENT` | **Stop.** Check for a `WebhookEvent` row. No row means not delivered or signature mismatch — compare the dashboard secret with `RAZORPAY_WEBHOOK_SECRET`. **Do not confirm by hand; do not refund.** |
| Webhook missing entirely                                | **Stop.** Same check. The payment is safe and the seat is held; nothing is urgent.                                                                                                                   |
| Duplicate booking or duplicate tickets                  | **Stop.** Should be impossible — only the delivery that flips `PENDING_PAYMENT → CONFIRMED` issues tickets. If seen, treat as P0 and preserve the rows before changing anything.                     |
| Wrong amount charged                                    | **Stop.** Look for the `PAYMENT_AMOUNT_MISMATCH` audit row. Tickets were withheld on purpose. Establish which figure is wrong before moving money.                                                   |
| Ticket missing on a confirmed booking                   | **Stop.** P0. The confirming transaction rolls back if the strategy issues too few, so this should not be reachable.                                                                                 |
| Notification missing                                    | **Not an abort.** The ticket exists. Check the `Notification` delivery state. No SMS is expected.                                                                                                    |
| Finance amount mismatch                                 | **Stop** before the refund. Record the figures from §3 first; a refund on top of an unexplained ledger makes two problems.                                                                           |
| Unexplained paise                                       | **Stop.** Check whether you are adding inclusive GST as an addend before assuming a defect.                                                                                                          |
| Reconciliation discrepancy                              | **Stop.** An open finding is evidence to read, not to resolve. Resolution moves no money by design — leave it open until the cause is known.                                                         |

**The rule across all of these: do not refund as a first response.** A refund before the state
is understood converts one reconciliation into two, and the automation that would do it is off
and production-forbidden for exactly this reason.

---

## 5. The controlled refund — a separate authorization

Only after §2 is complete and §3 balances to zero. This is its own gate and its own decision.

**Pre-conditions:** purchase fully reconciled; `Difference = 0` recorded; the booking,
payment, ticket and settlement rows all captured beforehand so "before" and "after" can be
compared rather than remembered.

Trace the state backwards and expect each:

| Layer          | Expected after a full refund                                                                                                  |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Razorpay       | a refund against `pay_…`, and a `refund.processed` webhook (**`refund.created` moves nothing** — it means accepted, not paid) |
| `Refund` row   | `COMPLETED`, carrying the provider refund id                                                                                  |
| `Payment`      | `refundedMinor` increased **once** — a redelivery must not deduct twice                                                       |
| `Booking`      | status per the refund policy; entitlement withdrawn                                                                           |
| `Ticket`       | no longer admits anybody at the gate                                                                                          |
| `Settlement`   | the organizer's accrual reduced by the capped organizer share                                                                 |
| Reconciliation | converges; no open finding                                                                                                    |
| Buyer          | refund notification, and the money back on their statement                                                                    |
| Organizer      | the reduction visible in their console                                                                                        |

Then the same arithmetic, in reverse:

```
  Refund issued to buyer       ____________ paise
  Reversed from organizer      ____________
  Reversed from our fee        ____________   (per the policy decision in Q9)
  Provider fee returned        ____________   (often zero - Razorpay may keep it)
  ------------------------------------------
  Difference                   ____________

EXPECTED: Difference = 0
```

**Note the likely non-zero:** payment-gateway fees are frequently _not_ returned on a refund.
If so, the platform absorbs that cost and the difference is explained, not zero — write the
explanation down rather than forcing the figure.

Automated refund execution is **off and production-forbidden**. This refund is a deliberate,
authorized act, performed once, watched throughout.

---

## 6. What this runbook will not do

- It will not tell you the first transaction succeeded on the strength of a status code.
- It will not refund automatically to tidy up a state nobody has established.
- It will not treat a missing SMS as a failure, because SMS cannot deliver and we know why.
