# India GST: what the code does, and what you must decide

Two parts, deliberately separated. The first is what the implementation does today, measured.
The second is a list of questions for an Indian accountant, written so they can be sent as they
are.

**Nothing here is tax advice.** The rates in the code came from the published GST 2.0 schedule
and no qualified person has checked them against our business.

Measured at `main = c77a9cd` by `apps/api/src/pricing/india-order-totals.spec.ts`, which prices
real orders through the real engines.

---

## PART 1 — IMPLEMENTED FACT

### 1.1 How an order is built

```
ticket face value (what the buyer sees on the poster)
  - coupon discount                     -> net subtotal
  + booking fee        (banded: Rs 5 / 10 / 15 / 20 by net subtotal)
  + payment fee        (2% of net subtotal + booking fee)
                                        -> customer fee (CUSTOMER_PAYS mode)
  + GST on the customer fee             -> ADDED to what the buyer pays
  = buyer total
```

GST on the **ticket** is _inside_ the face value and is extracted, not added. GST on the
**fee** is charged on top. These are two supplies with two places of supply: s.12(6) for
admission (the venue's state), s.12(2) for the booking fee (customer vs platform registration).
One order can legitimately show admission as CGST+SGST while the fee is IGST.

Fee mode is per event. `CUSTOMER_PAYS` is assumed throughout below. `ORGANIZER_PAYS` moves the
whole fee — and therefore its GST — off the buyer; `SHARED` splits it, customer rounded up.

### 1.2 The measured price table

Default bands, one ticket, `CUSTOMER_PAYS`, Telangana venue and buyer, MOVIE category. All
figures in rupees, produced by the test named above.

| Ticket  | Booking fee | Payment fee | Customer fee | **Buyer pays, GST off** | GST total | GST added | **Buyer pays, GST on** | Delta |
| ------- | ----------- | ----------- | ------------ | ----------------------- | --------- | --------- | ---------------------- | ----- |
| 100.00  | 5.00        | 2.10        | 7.10         | **107.10**              | 6.04      | 1.28      | **108.38**             | +1.28 |
| 199.00  | 5.00        | 4.08        | 9.08         | **208.08**              | 32.00     | 1.64      | **209.72**             | +1.64 |
| 200.00  | 10.00       | 4.20        | 14.20        | **214.20**              | 33.07     | 2.56      | **216.76**             | +2.56 |
| 499.00  | 10.00       | 10.18       | 20.18        | **519.18**              | 79.76     | 3.64      | **522.82**             | +3.64 |
| 500.00  | 15.00       | 10.30       | 25.30        | **525.30**              | 80.83     | 4.56      | **529.86**             | +4.56 |
| 999.00  | 15.00       | 20.28       | 35.28        | **1034.28**             | 158.75    | 6.36      | **1040.64**            | +6.36 |
| 1000.00 | 20.00       | 20.40       | 40.40        | **1040.40**             | 159.82    | 7.28      | **1047.68**            | +7.28 |
| 1598.00 | 20.00       | 32.36       | 52.36        | **1650.36**             | 253.18    | 9.42      | **1659.78**            | +9.42 |

Reading the GST columns: on a Rs 100 ticket the Rs 6.04 total is Rs 4.76 inside the ticket (5%
band, inclusive) plus Rs 1.28 on the fee (18%, added). On Rs 199 the ticket sits in the 18%
band, so Rs 30.36 is extracted from the face value and Rs 1.64 is added on the fee.

**Fee band edges.** Bands are `0-199`, `200-499`, `500-999`, `1000+` on the net subtotal, and
there are gaps between them (Rs 199.01-199.99, and the same at 499 and 999). An amount in a gap
falls back to the nearest band at or below, so it is charged the lower fee rather than refused.

### 1.3 What activation changes — the A3 answer

|                             | Changes?                       | Detail                                                                                                                                                           |
| --------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Buyer final amount**   | **YES**                        | Rises by 18% of the customer-borne fee: Rs 1.28 on a Rs 100 ticket, Rs 9.42 on Rs 1,598. **This is a price change to real customers.**                           |
| **B. Tax breakdown**        | YES                            | CGST/SGST or IGST lines appear per supply, on order and receipt.                                                                                                 |
| **C. Receipt / invoice**    | YES                            | The receipt becomes a tax document showing rate, base and split per line.                                                                                        |
| **D. Organizer settlement** | **NO**                         | The organizer's proceeds derive from the ticket face value, which does not move. Inclusive GST on admission is a reclassification of money already in the price. |
| **E. ETicketsGo revenue**   | **NO change in cash retained** | The fee stays the same; its GST is collected from the buyer and is a liability to remit, not revenue.                                                            |
| **F. Reconciliation**       | Mechanically no                | Money conservation is unaffected: the extra paise are collected and owed onward. New tax lines must be reportable.                                               |
| **G. Refunds**              | YES                            | Refunds and credit notes decide GST per line, so a refunded order reverses the GST that was charged on it. Not separately exercised against live money.          |

> **The correction worth stating plainly.** An earlier certification document, written by me,
> said activation "changes what the receipt says, not what the customer pays". That is true of
> the ticket and false of the order. The test that was supposed to prove it asserted
> `x === 0 + x - 0`, which is true for every possible value and proved nothing. Both are fixed;
> the figures above are the measurement that replaced the claim.

### 1.4 What is active today

Nothing. Production quotes return `tax 0` on INR. Rules ship inactive and activation is a
deliberate command:

```
npx tsx apps/api/prisma/seed-india-gst.ts            # write the rules, still inactive
npx tsx apps/api/prisma/seed-india-gst.ts --activate # switch them on
```

The shipped table is now tested against the published rates by
`apps/api/src/pricing/india-gst-activation.spec.ts` (13 tests): band edges meet with no gap,
admission rules share one tax group so a band and the catch-all cannot stack, and no rate is
invented for the 40% categories.

### 1.5 What the engine deliberately refuses

- A **banded** rule applied to an order total rather than per ticket: it throws rather than
  guess. Ten Rs 90 seats must not be rated as one Rs 900 order.
- A rate of its own: the engine holds none. Rates are rows a person edits.
- A rule for IPL, casinos, betting or racing (the 40% categories). None is shipped, so those
  categories are currently **untaxed** rather than wrongly taxed.

---

## PART 2 — BUSINESS / TAX DECISION REQUIRED

Questions for an Indian accountant. Each one changes code or configuration depending on the
answer; none can be answered from the codebase.

### Q1 — Is GST on our convenience/booking fee inclusive of the displayed fee, or added to the buyer?

Today it is **added**: a Rs 7.10 fee becomes Rs 8.38 to the buyer. The alternative is to treat
the displayed fee as GST-inclusive, so the buyer pays Rs 7.10 and we remit Rs 1.08 out of it.
This decides whether activation raises prices at all.

### Q2 — Is our platform fee one supply or two?

We charge a **booking fee** and a **payment processing fee** and currently tax both at 18% as
our own service. If the payment processing fee is a disbursement of the gateway's charge rather
than our service, its treatment may differ.

### Q3 — What is our place of supply for the booking fee?

The engine supports admission (venue state) and fee (customer vs our registration) differing,
producing CGST+SGST on the ticket and IGST on the fee in the same order. **We must state the
state of our GST registration**, which is currently unset in production.

### Q4 — Are the shipped admission rates correct for our catalogue?

Cinema 5% at or below Rs 100 and 18% above; recognised sport 0% at or below Rs 500 and 18%
above; everything else 18%. Effective 22 September 2025. Is this right for the events we
actually list?

### Q5 — Which of our categories fall in the 40% band, and do we sell any?

IPL, casinos, betting and racing moved to 40%. We ship **no** rule for them, so such an event
would currently be taxed at the 18% catch-all — under-collecting by more than half. Confirm we
will not list them, or give us the rates.

### Q6 — Is SAC 9996 correct for both the admission and the booking fee?

One code is currently assumed for both.

### Q7 — Do we need to issue a tax invoice rather than a receipt, and with what on it?

We issue receipts, and tax invoices when tax applies. Confirm the required fields: our GSTIN,
the customer's GSTIN where supplied (**we do not currently collect one**), HSN/SAC, place of
supply, and invoice numbering rules.

### Q8 — Do we need to collect a buyer GSTIN for B2B bookings?

Not collected anywhere today. If corporate buyers need an input credit, this is a schema and UI
change, not configuration.

### Q9 — How is GST reversed on a refund, and on a partial refund?

Refunds and credit notes decide GST per line. Confirm whether a credit note is required, in
what period, and whether the booking fee's GST is refundable when the fee itself is not.

### Q10 — Who remits the admission GST: us or the organizer?

This is the big one. Inclusive admission GST sits inside the organizer's ticket price. If the
**organizer** is the supplier of admission and we are an intermediary, the admission GST is
theirs to remit and ours only to report; if we are the supplier, it is ours. **This decides
whether settlement amounts are correct today.** Our model currently pays the organizer from the
face value without withholding admission GST.

### Q11 — Is there a TCS obligation on us as an e-commerce operator?

Section 52 TCS is not implemented anywhere. If it applies, it affects every payout.

### Q12 — From which date must GST be charged, and what about bookings already taken?

Production has taken live payments with no GST line. Confirm whether anything retrospective is
required for those, or whether activation is simply effective from the date we switch it on.

---

## What I need from you before activation

1. An answer to **Q1** and **Q10** at minimum — they change money, not presentation.
2. **Our GST registration state** (Q3), which is unset in production.
3. Accountant sign-off on the rate table (Q4, Q5).

Until then the rules stay inactive, which is the honest state: no GST line, and no wrong GST
line either.
