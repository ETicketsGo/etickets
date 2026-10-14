# India GST: tax classification of tickets

> **Not tax advice.** This records what the platform does and the published sources it was
> checked against on 2026-10-14. Nobody qualified has reviewed it. **GST is inactive in every
> environment** and must stay inactive until a Chartered Accountant (or equivalent) has signed
> off the table below and the "needs professional review" list at the end.

## What changed (H-8)

The tax rate on an Indian ticket depends on **what is being admitted to**. Until H-8 the
platform had no field that said so:

- The shipped rules banded on category `MOVIE` (5% up to Rs 100) and `Sports` (0% up to Rs 500).
- The booking passed the **seat category's regulatory class** (`REGULAR`, `RECLINER`...) to the
  tax engine as the category. That is a cinema _pricing_ class for state rate orders, not a tax
  category.
- So no cinema or sports band could ever match, and every ticket fell to the `*` catch-all at
  18%. A Rs 90 cinema seat would have been taxed at 18% instead of 5%.

Now:

1. **A dedicated classification.** `Event.taxCategory`, with an optional per-ticket-type
   override (`TicketType.taxCategory`). Both nullable, no backfill: any backfilled value would
   be a guess. The value is snapshotted on each booking line (`BookingItem.taxCategory`) so a
   re-price rates what the buyer was quoted.
2. **Rules match on it.** `TaxRule.category` is one of the classifications below. Rules keep
   their effective dates (`effectiveFrom` inclusive, `effectiveTo` exclusive); a rate change is
   a new rule, never an edit.
3. **Fail closed.** In a tax group on the ticket base (India's `ADMISSION` group), only a rule
   that **names** the ticket's classification can rate it. A `*` rule in such a group rates
   nothing. A ticket with no classification is refused (`TAX_CLASSIFICATION_MISSING`); a
   classification with no rule in force at that price is refused (`TAX_RULE_NOT_FOUND`). The
   buyer sees "Online booking is not open for this show yet"; the organizer's readiness check
   names the fix. Never an assumed rate.
4. **Inactive GST changes nothing.** With no active classified rule, no classification is asked
   for, nothing is refused, and every total is what it was.
5. **Inclusive / exclusive is unchanged and explicit per rule**: tickets inclusive (the price on
   the poster contains the GST), the platform fee exclusive (GST added on top).

The cinema seat class (`regulatoryClass`) still drives the state **pricing** policy (ticket
ceilings, maintenance charge). It no longer has anything to do with tax.

## The classifications and the shipped (inactive) rules

Rates are the **combined** GST rate (CGST + SGST intra-state, or IGST inter-state). "Band" is
the price of **one ticket**. Rates effective from 22 September 2025 (GST Council 56th meeting).

| Classification (`taxCategory`) | What belongs in it                                                            | Band         | Rate                      | Legal basis (as published)                                                                                                                             | SAC (suggested, see review list)                       |
| ------------------------------ | ----------------------------------------------------------------------------- | ------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| `CINEMA`                       | A film shown in a cinema or screening room                                    | up to Rs 100 | **5%**                    | 11/2017-CT(Rate), heading 9996 item (ii), as amended by 15/2025-CT(Rate) (12% to 5%)                                                                   | 999615 Motion picture projection services              |
| `CINEMA`                       |                                                                               | above Rs 100 | **18%**                   | heading 9996 item (iia), as amended by 15/2025-CT(Rate)                                                                                                | 999615                                                 |
| `SPORTS_RECOGNISED`            | A match organised by a recognised sports body                                 | up to Rs 500 | **0%**                    | Exempt: 12/2017-CT(Rate) entry 81, as substituted by 3/2018-CT(Rate) (Rs 250 raised to Rs 500)                                                         | 999651 Sports event promotion and organisation         |
| `SPORTS_RECOGNISED`            |                                                                               | above Rs 500 | **18%**                   | heading 9996 item (vi); recognised sporting events are excluded from item (iiia) by 15/2025-CT(Rate)                                                   | 999651                                                 |
| `LIVE_PERFORMANCE`             | Concert, music, theatre, drama, dance, ballet, circus, award show, pageant    | up to Rs 500 | **0%**                    | Exempt: 12/2017-CT(Rate) entry 81 (circus, dance, theatrical performance incl. drama or ballet, award function, concert, pageant, musical performance) | 999622 / 999629 Performing arts and live entertainment |
| `LIVE_PERFORMANCE`             |                                                                               | above Rs 500 | **18%**                   | heading 9996 item (i) (circus, classical/folk dance, theatre, drama), (iii) (ballet) or (vi) (concerts and the rest)                                   | 999622 / 999629                                        |
| `AMUSEMENT`                    | Theme park, water park, rides, go-karting                                     | any          | **18%**                   | heading 9996 item (iii)                                                                                                                                | 999691 Amusement park and similar attraction services  |
| `OTHER_ENTERTAINMENT`          | Any other recreational or cultural event                                      | any          | **18%**                   | heading 9996 item (vi), "all recreational, cultural and sporting services other than (i) to (v)"                                                       | 999699 Other recreation and amusement services         |
| `SPORTS_OTHER`                 | A sporting event not organised by a recognised body, e.g. an IPL-style league | -            | **none shipped: refused** | heading 9996 item (iiia)(b) "sporting events such as IPL": 40% from 22 Sep 2025 (was 28%). See review list.                                            | 999651 / 999659                                        |
| `CONFERENCE`                   | Business, educational or trade event                                          | -            | **none shipped: refused** | Not heading 9996. Likely 18% under another heading; needs advice.                                                                                      | 998596 / 999293 (unverified)                           |
| platform booking fee           | The platform's own service (all classifications)                              | any          | **18%**, added on top     | general rate for the platform's service; place of supply is the buyer's state (s.12(2) IGST Act)                                                       | 998599 / 999799 (unverified)                           |

`SPORTS_OTHER` and `CONFERENCE` deliberately have **no shipped rule**. Selling them with GST
active is refused until somebody qualified writes the rule. That is the owner's decision
(2026-10-14): an unsupported case must not silently charge an assumed rate.

Casinos, race clubs, betting and lotteries are not sold on the platform and have no
classification.

## Place of supply (unchanged by H-8)

- Admission: where the event is held (s.12(6) IGST Act). Venue state vs the seller's
  registered state decides CGST + SGST vs IGST.
- Platform fee: where the buyer is (s.12(2)). Buyer state vs `PLATFORM_TAX_REGION`.

The amount is the same either way; only the heading changes (see the one-rounding-policy note
in `apps/api/src/pricing/tax-calculator.ts`).

## Needs professional tax review before activation

Each of these is a judgement the platform does not make. Until a qualified person answers them
the rules stay inactive.

1. **Cinema threshold base.** The engine compares the Rs 100 cinema band against the ticket's
   **face value, which includes GST** (prices are GST-inclusive). If the Rs 100 in heading 9996
   (ii) is read on the price _excluding_ GST, tickets with a face value from about Rs 100.01 to
   Rs 105 belong in the 5% band and the platform would over-collect on them. The same question
   applies to the Rs 500 exemption edge.
2. **Rs 500 exemption base for concerts and sport.** Entry 81 says "consideration for right to
   admission ... not more than Rs 500 per person". Whether the platform's booking fee, a
   maintenance charge or add-ons form part of that consideration is not settled here (published
   commentary suggests a total above Rs 500 can make the whole ticket taxable). The engine
   applies the band to the ticket price alone.
3. **The concert exemption is new behaviour.** The pre-H-8 table taxed every concert at 18% at
   any price. The shipped table now exempts `LIVE_PERFORMANCE` up to Rs 500 per entry 81 as
   substituted by 3/2018. Confirm entry 81 is still in force in that form after the
   September 2025 notifications (the substitution we cite is from 2018; we did not find the
   consolidated text).
4. **Stand-up comedy, magic shows, open mics, festivals** - "theatrical performance" (exempt up
   to Rs 500) or "other entertainment" (18% at any price)? The organizer chooses; give them
   written guidance.
5. **"Recognised sporting event".** Defined by reference to recognised sports bodies (the
   explanation in 12/2017 and 15/2025). The platform cannot verify an organizer's claim; decide
   whether the claim needs evidence before sale.
6. **IPL-style events (`SPORTS_OTHER`).** 40% under item (iiia)(b) from 22 Sep 2025. Whether the
   Rs 500 exemption in entry 81(b) ("any sporting event other than a recognised sporting event")
   still applies below Rs 500, and what "such as IPL" covers, needs advice. Franchises are
   reportedly contesting the classification.
7. **Conferences, workshops, exhibitions (`CONFERENCE`).** Not heading 9996. Rate and SAC need
   advice; place of supply for admission to a conference is also s.12(6).
8. **SAC codes.** The six-digit codes above are suggestions from the SAC scheme (Annexure to
   11/2017-CT(Rate)). Note **999692 is "Gambling and betting services"**, not general
   entertainment, and **999652 is "Sports and recreational sports facility operation"**, not
   admission to an event; neither should be used for ordinary tickets. The platform does not yet
   print a SAC on the receipt; decide which codes the tax invoice must carry.
9. **Input tax credit.** Reported as "5% with ITC" for cinema up to Rs 100 after 15/2025. This
   affects the cinema's own returns, not the buyer's price; confirm with each cinema operator.
10. **Telangana and other regulated cinemas.** Whether a government-capped ticket price is
    inclusive or exclusive of GST (see `docs/guides/INDIA-GST.md`). The rule's `inclusive` flag
    must match before activation.
11. **Legacy rows.** Databases seeded before H-8 still hold **inactive** rules with categories
    `MOVIE`, `Sports` and `*`. The new seed writes new rows beside them and never activates
    them. With the H-8 engine, activating the legacy rows would refuse every classified ticket
    (they name no current classification, and the `*` row rates nothing) rather than charge a
    wrong rate - but they should be deactivated for good or deleted by an admin.

## Sources

Primary sources are CBIC notifications. Where only a secondary reproduction was reachable it is
named as such; verify each against the gazette text on cbic-gst.gov.in before activation.

- Notification 11/2017-Central Tax (Rate), heading 9996, as amended up to 15/2025-Central Tax
  (Rate) effective 22-09-2025 - reproduced at
  [gstgyaan.com, heading 9996](https://gstgyaan.com/cgst-rate-on-recreational-cultural-and-sporting-services-heading-9996)
  (secondary; last updated 2026-03-08). Items (ii) cinema up to Rs 100 at 2.5% CGST, (iia) above
  Rs 100 at 9% CGST, (iiia) casinos, race clubs and "sporting events such as IPL" at 20% CGST
  with recognised sporting events excluded, (vi) everything else at 9% CGST.
- Notification 12/2017-Central Tax (Rate) entry 81, as substituted by 3/2018-Central Tax (Rate)
  from 25-01-2018: admission up to Rs 500 per person exempt for circus, dance, theatre, drama,
  ballet, award functions, concerts, pageants, musical performances, sporting events and
  planetarium - [Taxmann](https://taxmann.com/post/blog/gst-on-entertainment-services),
  [TaxTMI](https://www.taxtmi.com/news?id=19600),
  [CG GST copy of 3/2018](https://www.cggst.com/uploads/document/1753793400-32018-central-tax-rate.pdf).
- GST Council 56th meeting (3 September 2025) rate changes, reported:
  [Business Today on cinema and IPL](https://www.businesstoday.in/amp/personal-finance/news/story/gst-revision-moviegoers-get-relief-in-small-screens-ipl-goers-face-40-rate-for-match-tickets-492552-2025-09-04),
  [ClearTax on IPL tickets](https://cleartax.in/s/gst-on-ipl-tickets).
- SAC codes under heading 9996 -
  [busy.in SAC 9996 list](https://busy.in/hsn/sub-chapter-9996) (secondary).
- Rs 500 threshold and the consideration question -
  [CAclubindia, "The Rs 500 exemption illusion"](https://www.caclubindia.com/articles/the-rs-500-exemption-illusion-when-a-concert-ticket-turns-into-a-taxable-symphony-54412.asp).

## Where it lives in the code

- Vocabulary: `packages/shared-types/src/tax-classification.ts` (`TAX_CATEGORIES`, labels).
- Shipped rules (inactive): `apps/api/prisma/india-gst-rules.ts`, written by
  `apps/api/prisma/seed-india-gst.ts` (never activated by a deploy).
- Fail-closed check: `admissionClassificationGaps` in `apps/api/src/pricing/tax-calculator.ts`;
  turned into `TAX_CLASSIFICATION_MISSING` / `TAX_RULE_NOT_FOUND` in `PricingService`.
- Organizer readiness: `EventSellabilityService` (same check, same rules).
- Organizer form: `apps/organizer-web/components/tax-classification-field.tsx`, shown only
  where `GET /events/tax-classification?venueId=` says classification is required.
