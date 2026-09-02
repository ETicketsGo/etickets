# India GST on ticket sales — the rules, and what this platform does with them

> **This document records published rates; it is not tax advice, and nobody here is your
> accountant.** Every rate below is configuration, held in `TaxRule` rows, precisely so that
> a change of law is a data change and not a deploy. **Have your CA confirm the table before
> a single rupee of real GST is collected.** If a rate here is wrong, the fix is a row, not
> a release.

## Why the rates are not in the code

Rates move. The whole table below changed on **22 September 2025** under the GST Council's
56th meeting ("GST 2.0"), which collapsed four slabs into 5% and 18% and added a 40% slab
for demerit services. Anything that hardcodes a percentage is wrong the day the Council
meets. So the engine knows about _bands, categories and place of supply_; it knows no
numbers.

## The rate table (as published, effective 22 September 2025)

| What is being sold                                  | Band   | Rate    |
| --------------------------------------------------- | ------ | ------- |
| Cinema admission                                    | ≤ ₹100 | **5%**  |
| Cinema admission                                    | > ₹100 | **18%** |
| Recognised sporting event                           | ≤ ₹500 | **0%**  |
| Recognised sporting event                           | > ₹500 | **18%** |
| IPL, casinos, betting, horse racing, gambling       | any    | **40%** |
| Other entertainment / cultural / artistic admission | any    | **18%** |
| Convenience or booking fee charged by the platform  | any    | **18%** |

Admission services are **SAC 9996**. The platform's booking fee is a separate supply of
service by the platform and is taxed in its own right — which is why a receipt carries two
tax lines and not one.

**The band is decided per ticket, on the face value of that ticket.** A ₹90 ticket and a
₹450 ticket in the same order are not the same rate, and averaging them is wrong.

## Inclusive, not added on top

Indian ticket prices are quoted **inclusive of GST** — the ₹250 on the poster is what you
pay, and the tax is inside it. That is how every Indian ticketing site behaves, and it is
what an organizer means when they type 250 into a price field.

So for India this platform **extracts** GST from the face value rather than adding it. Two
consequences worth stating plainly:

- The customer's total does not move when GST is switched on. The ticket was always ₹250;
  the receipt now says how much of that ₹250 was tax.
- The **organizer** receives less than the face value, because part of it was never theirs.
  That is the law working, not a fee — but an organizer who has never itemised GST before
  will notice, and should be told before it is enabled.

Adding GST on top instead would raise every Indian price by up to 18% overnight. The engine
supports both — `inclusive` is a property of the rule — but inclusive is the default for
India for the reasons above.

## CGST + SGST, or IGST

**Section 12(6) of the IGST Act**: for admission to a cultural, artistic, sporting,
scientific, educational or entertainment event, the place of supply is **where the event is
actually held**.

So the comparison is the _venue's_ state against the _seller's registered_ state:

| Venue state vs seller state | Lines on the receipt        |
| --------------------------- | --------------------------- |
| Same                        | CGST at half + SGST at half |
| Different                   | IGST at the full rate       |

**The amount is identical either way** — 18% is 18% whether it appears as 9 + 9 or as 18.
Only the labels and the reporting differ. That matters when the venue's state is unknown:
the customer is never overcharged by the ambiguity, and the platform defaults to CGST+SGST,
which is the overwhelmingly common case for a venue-based event.

## What this platform does NOT do

- **It does not decide whether your event is a "recognised sporting event"**, or whether a
  cricket match is a sporting event or an entertainment event. That is a classification
  question with a live dispute behind it — IPL was moved from 28% to 40% in September 2025
  and the franchises are contesting the classification. The category on the event drives the
  rate; a human chooses the category.
- **It does not handle entertainment duty**, which several states levy _in addition_ to GST
  on online booking convenience fees. The Bombay High Court upheld that levy in August 2025.
  Where it applies it is a state-by-state amount and is not modelled here.
- **It does not file anything.** No returns, no GSTR, no e-invoicing. It records what was
  charged and produces a receipt.
- **It does not apply the ≤ ₹500 sporting exemption automatically** unless a rule says so —
  an exemption is a rate of zero and is configured like any other band.

## Switching it on

The rules are seeded **inactive**. Nothing is taxed until somebody says so:

```
npx tsx apps/api/prisma/seed-india-gst.ts            # write the rules, switched off
npx tsx apps/api/prisma/seed-india-gst.ts --activate # switch them on, deliberately
```

Re-running never overwrites a rate somebody edited on advice — an existing rule of the same
shape is left exactly as it is.

**What changes the moment they are active**, measured against the live table:

| Order                              | Before  | After                                         |
| ---------------------------------- | ------- | --------------------------------------------- |
| ₹250 cinema × 2 + ₹20 fee          | ₹520.00 | ₹520.00 — CGST ₹38.14, SGST ₹38.13, fee ₹3.05 |
| ₹90 cinema × 2 + ₹10 fee           | ₹190.00 | ₹190.00 — the 5% band, ₹10.10 tax in total    |
| Same order, venue in another state | ₹520.00 | ₹520.00 — one IGST line of ₹79.32             |

The customer pays the same either way. That is what "inclusive" means, and it is the reason
switching this on is safe to do without re-pricing anything.

## Still to build

- **No admin UI for `TaxRule`.** Rows are created by the seed script above or by hand. The
  admin console has full CRUD for fee rules and nothing for tax rules, so a rate change today
  means running a script rather than editing a form.
- **No entertainment duty**, per the note above.
- **Categories are matched on the event's own category text.** A MOVIE experience maps to
  `MOVIE` automatically; everything else uses whatever the organizer typed, so a `Sports`
  rule only fires for an event categorised `Sports`. Nothing validates that.

## Sources

Published summaries, not statute. Verify against CBIC notifications before relying on them.

- [GST on movie tickets — rates and bands (busy.in)](https://busy.in/gst-rates/movie-tickets/)
- [GST on movie tickets (Razorpay)](https://razorpay.com/learn/gst-on-movie-tickets/)
- [40% slab on IPL tickets, casinos, betting from 22 Sept (PL India)](https://www.plindia.com/news/gst-council-40-percent-tax-ipl-tickets-casinos-lotteries-betting-sept-22/)
- [Sporting events: exemption below ₹500 (CAclubindia)](https://www.caclubindia.com/articles/new-gst-on-sporting-event-exemption-for-lowpriced-tickets-54106.asp)
- [Place of supply for events, s.12(6) IGST Act (Taxwink)](https://www.taxwink.com/blog/place-of-supply-for-events-conferences-seminar)
- [Entertainment duty on convenience fees upheld (MediaNama, Aug 2025)](https://www.medianama.com/2025/08/223-bombay-hc-entertainment-duty-rs-10-convenience-fees-online-ticket-booking/)
