# Vijayawada "Platinum Executive" seat class: finding

Status: **investigation only. Nothing was mapped, edited, activated or created anywhere.**
Prepared 2026-10-10 on branch `docs/vijayawada-seat-class` (base `origin/main` `eb4534b`).

Related:
[`docs/compliance/india-cinema-vijayawada-launch.md`](../compliance/india-cinema-vijayawada-launch.md)
(runbook),
[`INDIA-CINEMA-PRICING-COMPLIANCE-REPORT.md`](../../INDIA-CINEMA-PRICING-COMPLIANCE-REPORT.md),
[`VIJAYAWADA-PILOT-READINESS-REPORT.md`](../../VIJAYAWADA-PILOT-READINESS-REPORT.md),
[`TELANGANA-CINEMA-PRICING.md`](./TELANGANA-CINEMA-PRICING.md) (engine gap list G1-G12),
`apps/api/prisma/seed-india-cinema-policy.ts`.

## 0. Summary

- On QA, every upcoming seated show at the **ETG Vijayawada Multiplex (QA pilot)** is only
  partly sellable. Regular and Recliner seats sell. The 4 **Platinum Executive** seats on
  Screen 1 do not, because that seat category has **no regulatory seat class**
  (`SeatCategory.regulatoryClass = null`). Blocker code `SEAT_CLASS_UNMAPPED`.
- The engine is doing what it was designed to do: an unmapped category in a regulated state is
  refused rather than sold with no ceiling. This is a **missing configuration answer**, not a
  defect in the pricing engine.
- The answer is not an engineering decision. The platform offers four classes (`REGULAR`,
  `RECLINER`, `PREMIUM`, `NON_PREMIUM`). For a **Municipal Corporation multiplex**, the Andhra
  Pradesh table in this repository has rows for **only two** of them: Regular (Rs 150) and
  Recliner (Rs 250). Platinum Executive is priced at **Rs 200**, between the two.
- Mapping it to `PREMIUM` or `NON_PREMIUM` would **not** give it a ceiling: no AP multiplex row
  names those classes, so the seat would resolve to the climate-only fallback and sell
  **uncapped** (gap G10). Mapping it to `REGULAR` blocks it until it is re-priced to Rs 150 or
  less. Mapping it to `RECLINER` lets Rs 200 sell, which is right only if the seat is in fact a
  recliner within the meaning of G.O.Ms.No.13.
- **Nobody in this repository has read G.O.Ms.No.13.** The AP rates were transcribed from a
  product brief (`textReviewed = false`). So nothing here can say which class the order puts a
  "Platinum Executive" seat in. That is a question for the owner and the cinema, with the order
  text in hand.

## 1. How this was checked

QA API `https://api-qa-f580.up.railway.app/api`, 2026-10-10, as `owner@eticketsgo.test`
(organizer) and `admin@eticketsgo.test` (platform admin). One `POST /auth/login` per account
to obtain a token; **every other request was a GET**. No UAT or production request was made.

| Request                                                               | What it showed                                   |
| --------------------------------------------------------------------- | ------------------------------------------------ |
| `GET /cinemas?organizationId=...`                                     | the cinema and its classification                |
| `GET /cinemas/:id`, `GET /cinemas/:id/screens`                        | screen id, capacity                              |
| `GET /screens/:screenId/seat-layouts`, `GET /screens/:id/seatmap`     | layout id, version, seat categories              |
| `GET /cinemas/:id/seat-classes`                                       | each category and its regulatory class           |
| `GET /cinemas/:id/pilot-readiness`                                    | the readiness blocker                            |
| `GET /cinemas/:id/pricing-compliance`                                 | the compliance panel's view                      |
| `GET /organizer-calendar?organizationId=...&from=...&to=...`          | the cinema's shows                               |
| `GET /organizer-calendar/sale-eligibility?...&sessionIds=...`         | the per-show blockers checkout would raise       |
| `GET /shows/:sessionId/pricing`                                       | seats per category on one show                   |
| `GET /admin/cinema-pricing-policies`                                  | every policy row, every status                   |
| `GET /admin/cinema-pricing-policies/inspect?...&seatCategory=<class>` | which row each class WOULD resolve to (no write) |

Code read at `eb4534b`: `apps/api/src/pricing/cinema-policy/sale-eligibility.ts`,
`cinema-pricing-policy.resolver.ts`, `apply-policy.ts`,
`apps/api/src/cinemas/cinema-compliance.service.ts`, `apps/api/src/admin/admin.controller.ts`,
`apps/organizer-web/components/seat-class-mapping.tsx`, `apps/api/prisma/schema.prisma`
(`SeatCategory`, `SeatRegulatoryClass`), and the seed.

## 2. The missing configuration, exactly

### 2.1 Where it is

| Item         | Value                                                                              |
| ------------ | ---------------------------------------------------------------------------------- |
| Organization | `cmtnpiww7001uqoiixkmvh6iy`                                                        |
| Cinema       | `cmtnq138t000fb9jhqkl48fmk` "ETG Vijayawada Multiplex (QA pilot)", status ACTIVE   |
| Venue        | `cmtnq138j000db9jhdsebe8fc`                                                        |
| Jurisdiction | India / Andhra Pradesh / district NTR / city Vijayawada                            |
| Local body   | `MUNICIPAL_CORPORATION`                                                            |
| Format       | `MULTIPLEX`                                                                        |
| Climate      | `AC`                                                                               |
| Screen       | `cmtnq1o24000pb9jh8a3qae1k` "Screen 1", 2D, ACTIVE (the cinema's only screen)      |
| Layout       | `cmtnq1o54000sb9jh6frlavr1` "Vijayawada pilot layout", **version 1**, `PUBLISHED`  |
|              | published 2026-09-05T01:46:07Z, 24 seats (all kind `SEAT`), 15 future shows pinned |

The cinema's classification is complete. Nothing is missing at cinema level.

### 2.2 Seat categories on that layout

| Seat category id            | Name                   | Base price | Seats per show | `regulatoryClass` |
| --------------------------- | ---------------------- | ---------- | -------------- | ----------------- |
| `cmtnq1o59000ub9jhsu56a30h` | Regular                | Rs 150     | 16             | `REGULAR`         |
| `cmtnq1o62001ib9jhpanco4cd` | Recliner               | Rs 250     | 4              | `RECLINER`        |
| `cmtnq1o6f001sb9jhvwwxlo1q` | **Platinum Executive** | **Rs 200** | **4**          | **`null`**        |

Seats per show from `GET /shows/cmv2l2hi2001klh0y6rzxmk7h/pricing`.

### 2.3 The field and the check

- **Field:** `SeatCategory.regulatoryClass` (Prisma enum `SeatRegulatoryClass`: `REGULAR`,
  `RECLINER`, `PREMIUM`, `NON_PREMIUM`), nullable, no default. Null means "the operator has not
  answered" (`schema.prisma`, comment on the field).
- **Where it is set:** organizer console, cinema readiness page, "Seat classes" card
  (`/organizer/cinemas/cmtnq138t000fb9jhqkl48fmk/readiness#seat-classes`), which calls
  `PATCH /cinemas/:id/seat-classes/:seatCategoryId` with `{ "regulatoryClass": ... }`.
  Owners and managers only; the change is audited as `SEAT_CATEGORY_REGULATORY_CLASS_SET`.
  **This was not called.**
- **What the check expects:** for each ticket type, `lineOf()` in `sale-eligibility.ts` passes
  `seatCategory.regulatoryClass` as the line's `category` and the display name as
  `seatCategoryName`. A line with a seat category but no class is collected as an
  `unmappedSeatCategories` entry. In a regulated market (`resolvePolicy` sees at least one
  ACTIVE row for India), any unmapped entry returns `INVALID_CINEMA_CLASSIFICATION` **before**
  any rate row is matched, and `saleBlockersFromPolicy` turns that into the blocker below.
  The name is never used to infer a class (proved by
  `vijayawada-pilot.integration-postgres.spec.ts`, "never infers a class from a name").

### 2.4 The blocker as QA reports it

Readiness (`GET /cinemas/:id/pilot-readiness`): `overall: BLOCKED`, one blocker, section `SALES`:

> `SALE_SEAT_CLASS_UNMAPPED` (BLOCKED): "Seat category Platinum Executive needs a regulatory
> seat class before tickets can be sold. Andhra Pradesh caps the price of each class. Set it
> under Seat classes. (15 of 15 upcoming shows)"

Sale eligibility (`GET /organizer-calendar/sale-eligibility`), for each of the 15 seated
upcoming shows on Screen 1:

```
code:    SEAT_CLASS_UNMAPPED
owner:   ORGANIZER
subject: Platinum Executive
fixPath: /organizer/cinemas/cmtnq138t000fb9jhqkl48fmk/readiness#seat-classes
state:   PARTIAL   (2 ticket types open: Regular, Recliner; 1 closed: Platinum Executive)
```

A buyer sees only `BUYER_SALE_NOT_OPEN` ("Online booking is not open for this show yet...")
for that seat type. The other seats on the same show still sell.

The 15 shows: `cmv1fqplb00sx5zaacvbz21p9`, `cmv2nf3410092lh0y1wuqtu8f`,
`cmv2nhgis00wzlh0y6nmeweiz`, `cmv2nhl65010olh0y738qg1cc`, `cmv2nf38b00a2lh0yu9lbiua0`,
`cmv2nhgma00xzlh0ygi29rm9k`, `cmv2nhla4011olh0yf3pk70aa`, `cmv2nf3c400b2lh0y3r26d67f`,
`cmv2nhgqa00yzlh0yl7w131g3`, `cmv2nhldw012olh0y0c2jp6sx`, `cmv23ytub001y67rw9uj8f1fn`,
`cmv2x4x9a001egq3jyp3q3v9o`, `cmv2i8n5b001e97s1ywiaf1bv`, `cmv2l2hi2001klh0y6rzxmk7h`,
`cmv2b6vgg003hm4zwh2n4qv94` (2026-11-01 to 2027-01-02). A sixteenth upcoming show at the
same venue, `cmv2ng5he00kflh0yhb9xr4dm` "Film Appreciation Morning" (capacity 80), reports
`SELLING`; it is a free event with no cinema, not a Screen 1 show (see 6.3).

## 3. Andhra Pradesh policy rows on QA

`GET /admin/cinema-pricing-policies` returned 44 rows: 41 Andhra Pradesh, 3 Telangana.
All AP rows cite `G.O.Ms.No.13, Home (General-A) Department, dated 07-03-2022`, regulatory
document `cmtnpqcmo0000vv85yxg1jjty`, `documentUrl` null, version 1, effective from
2026-09-04 (the date the configuration was recorded on this platform, not a commencement date
of the order), no end date, `REQUIRES_APPROVAL` online fee (platform fee ceiling = 0),
maintenance `INCLUDED_IN_TICKET_PRICE` (Rs 5 AC / air-cooled, Rs 3 non-AC). District and city
are `*` on every row.

### 3.1 ACTIVE (3 rows)

| Id                          | Local body            | Format    | Climate | Seat class | Ceiling  |
| --------------------------- | --------------------- | --------- | ------- | ---------- | -------- |
| `cmtnpqcoh000kvv85jx7nzogf` | MUNICIPAL_CORPORATION | MULTIPLEX | -       | REGULAR    | Rs 150   |
| `cmtnpqcol000mvv856ltfssd2` | MUNICIPAL_CORPORATION | MULTIPLEX | -       | RECLINER   | Rs 250   |
| `cmtnpqctg0028vv85k33p23xi` | -                     | -         | AC      | -          | **none** |

The third row is the climate-only fallback: maintenance only, **no ceiling**, by design
("inheriting a ceiling from a different class would be an invention").

These three are exactly the rows the runbook (step 19) says the pilot needs. Because they are
ACTIVE, India is a regulated market on QA, which is why the unmapped category is refused.

### 3.2 DRAFT (38 AP rows)

Municipal Corporation (the slab Vijayawada is recorded as being in):

| Format          | Climate    | Seat class  | Ceiling | Status     |
| --------------- | ---------- | ----------- | ------- | ---------- |
| SINGLE_SCREEN   | NON_AC     | NON_PREMIUM | Rs 40   | DRAFT      |
| SINGLE_SCREEN   | NON_AC     | PREMIUM     | Rs 60   | DRAFT      |
| SINGLE_SCREEN   | AC         | NON_PREMIUM | Rs 70   | DRAFT      |
| SINGLE_SCREEN   | AC         | PREMIUM     | Rs 100  | DRAFT      |
| SINGLE_SCREEN   | AIR_COOLED | NON_PREMIUM | Rs 70   | DRAFT      |
| SINGLE_SCREEN   | AIR_COOLED | PREMIUM     | Rs 100  | DRAFT      |
| SPECIAL_THEATRE | -          | NON_PREMIUM | Rs 100  | DRAFT      |
| SPECIAL_THEATRE | -          | PREMIUM     | Rs 125  | DRAFT      |
| MULTIPLEX       | -          | REGULAR     | Rs 150  | **ACTIVE** |
| MULTIPLEX       | -          | RECLINER    | Rs 250  | **ACTIVE** |

The other DRAFT rows are the Municipality slab (10 rows, Rs 30 to Rs 250), the Nagar Panchayat
and Gram Panchayat slabs (9 rows each, Rs 20 to Rs 100, **no multiplex recliner row**), and the
`AIR_COOLED` and `NON_AC` climate-only fallbacks. They match the seed file value for value.

**No AP row, in any status, names `PREMIUM` or `NON_PREMIUM` for a `MULTIPLEX`.** In the table
as transcribed, Premium / Non-premium belong to single screens and special theatres; multiplexes
are banded Regular / Recliner only.

### 3.3 Telangana rows (for completeness)

- `cmtnpqctt002evv85g6rp4sl8` G.O.Ms.No.120 (historical), DRAFT, no values, UNCONFIRMED.
- `cmtnpqctx002gvv85tiu5cwra` G.O.77 dated 14-08-2026, DRAFT, no values, UNCONFIRMED.
- `cmtuykdt4000l128btbu2h9k6` reference `TS`, **DISABLED**, Hyderabad Municipal Corporation
  single screen AC, seat class `Regular`, ceiling 150 paise, maintenance 5 paise ADDED, fee
  ALLOWED, no regulatory document, created 2026-09-10. This is not from the seed; it looks
  like a test row. It is DISABLED and prices nothing. Not touched.

### 3.4 Which row each mapping would resolve to

From `GET /admin/cinema-pricing-policies/inspect` with this cinema's context (India / Andhra
Pradesh / Vijayawada / INR / MUNICIPAL_CORPORATION / MULTIPLEX / AC), which runs the same
resolver as checkout against ACTIVE rows and writes nothing:

| If mapped to  | Resolves to                                   | Ceiling  | Rs 200 today       |
| ------------- | --------------------------------------------- | -------- | ------------------ |
| `REGULAR`     | `cmtnpqcoh000kvv85jx7nzogf` MC multiplex reg. | Rs 150   | **refused**        |
| `RECLINER`    | `cmtnpqcol000mvv856ltfssd2` MC multiplex rec. | Rs 250   | sells              |
| `PREMIUM`     | `cmtnpqctg0028vv85k33p23xi` AC fallback       | **none** | sells **uncapped** |
| `NON_PREMIUM` | `cmtnpqctg0028vv85k33p23xi` AC fallback       | **none** | sells **uncapped** |

All four resolve with status `REQUIRES_APPROVAL` (matched, platform booking fee held at 0).

`REGULAR` refused: the eligibility check would replace `SEAT_CLASS_UNMAPPED` with
`PRICE_OVER_CEILING` ("Platinum Executive is priced at Rs 200, above the most Andhra Pradesh
allows for its seat class (Rs 150)..."). `PREMIUM` / `NON_PREMIUM` uncapped: this is gap
**G10** in `TELANGANA-CINEMA-PRICING.md` ("A seat class with no rate row falls to a fallback
with no ceiling and sells uncapped"). The fallback was built so an unknown class still prices
maintenance correctly; it was never meant to be the answer for a seat whose class is known.
The organizer UI offers all four classes for every cinema, so nothing on screen warns that two
of them carry no ceiling for a multiplex.

## 4. Verified vs unverified

### Verified (by a GET on QA on 2026-10-10, or by reading the code at `eb4534b`)

- The cinema, screen, layout, seat categories, prices and seat counts in section 2.
- `Platinum Executive` has `regulatoryClass = null`, and that alone produces the blocker on
  15 of 15 seated upcoming shows. No other regulatory blocker is reported for those shows.
- The 44 policy rows and their statuses in section 3, and that the QA AP values equal the
  values in `seed-india-cinema-policy.ts`.
- Which row each possible mapping resolves to on QA (section 3.4, via the inspect endpoint).
- `checkTicketPrice` compares the ticket's stored price directly with `ticketPriceMaxMinor`,
  with an inclusive bound (`apply-policy.ts`).

### Unverified (the repository says so itself)

- **The AP rates.** Every AP row says "Ceiling transcribed from the product brief, not from the
  order text". The regulatory document carries `textReviewed = false` and no URL
  (`seed-india-cinema-policy.ts` header; `INDIA-CINEMA-PRICING-COMPLIANCE-REPORT.md` section 1
  and 4.1; runbook steps 1-3). Nobody has read G.O.Ms.No.13 against the table.
- **Which seat classes G.O.Ms.No.13 defines for a multiplex, and what they mean.** The repo
  holds the brief's labels (Regular / Recliner for multiplexes; Premium / Non-premium for
  single screens and special theatres) and nothing more: no definition of "recliner", no
  statement of whether a multiplex may sell a third class, and no rule for a class between
  Regular and Recliner. `INDIA-CINEMA-PRICING-COMPLIANCE-REPORT.md` 4.4 lists "seat-class
  vocabulary" as a regulatory value still missing.
- **What a "Platinum Executive" seat physically is** at this (QA pilot) cinema: recliner,
  wider standard seat, lounge seat, or something else. The category is QA test data, and the
  repo records no description of it. `VIJAYAWADA-PILOT-READINESS-REPORT.md` section 10 item 5
  names "the pilot cinema itself ... and its real seat category names" as a missing non-code
  input.
- **Vijayawada's local body type.** The repo states "Vijayawada is a Municipal Corporation"
  (runbook, compliance report). No source document for that statement is recorded.
- **Third-party booking fee in AP** (open; platform fee held at Rs 0), **who owns the
  maintenance money** (open), and the **GST basis** of the ceilings: the AP rows say "Rs 150
  exclusive of GST", while India ticket prices are stored GST-inclusive, and the comparison has
  no basis adjustment (gap **G3**, recorded as open in `TELANGANA-CINEMA-PRICING.md`; I found no
  change to `checkTicketPrice` since). G3 matters for any mapping chosen: today a price that is
  lawful at the ceiling ex-GST can be refused, and the ceiling is effectively lower than
  written.

No statute, ceiling or definition was added from outside the repository in writing this.

## 5. Options for the owner

None of these was applied. Each needs the person answering it to have read G.O.Ms.No.13 (or
to accept that it is unread, on QA only), and to know what the seat physically is.

| #   | Option                                                                                                                         | What happens on QA                                                                                                                          | Consequence / risk                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | **Leave it blocked** (do nothing)                                                                                              | Regular and Recliner keep selling; Platinum Executive stays closed on all 15 shows; readiness stays BLOCKED.                                | Safe. No seat sells at a price nobody has checked. The cinema's readiness never reads "ready", which may confuse pilot testing.                                                                                                         |
| B   | **Map to `RECLINER`** (only if the seat is a recliner as the order defines it)                                                 | Resolves to the Rs 250 row; Rs 200 sells; ceiling enforced.                                                                                 | Correct only if the seat is a recliner. If it is not, a non-recliner sells under a recliner ceiling: legally wrong, and nothing would ever complain (the "wrong mapping" risk the Seat classes screen warns about).                     |
| C   | **Map to `REGULAR`** (if the seat is, in the order's terms, a regular multiplex seat)                                          | Resolves to the Rs 150 row; the blocker becomes `PRICE_OVER_CEILING` at Rs 200. Sells only after the organizer re-prices to Rs 150 or less. | Conservative and capped. A "premium" product at the regular price, or the category is retired. Re-pricing is an organizer decision on 15 shows.                                                                                         |
| D   | **Map to `PREMIUM` or `NON_PREMIUM`**                                                                                          | Resolves to the AC climate fallback; Rs 200 sells with **no ceiling** (G10).                                                                | **Not recommended under the current table.** No AP multiplex row names these classes, so the seat would be uncapped at any price. Looks configured, is not.                                                                             |
| E   | **Rename or merge the category** (e.g. make those 4 seats Recliner or Regular in the layout)                                   | Needs a new layout version, because the 15 future shows are pinned to layout v1. Seats then inherit the target category's existing mapping. | Same legal question as B or C, decided in the layout instead of the mapping. A layout change touches seat inventory for scheduled shows, which is out of scope for a pricing fix and must go through the normal layout-versioning flow. |
| F   | **Add a policy row for the class the order actually defines** (only if G.O.Ms.No.13, once read, bands a third multiplex class) | Admin creates a DRAFT row through the admin console, runs preflight, activates. Then map the category to it.                                | Only possible if the order text supports it. Creating a row from the brief or by analogy would be inventing law. Note the enum has only four classes; a class with a different name would need a schema change.                         |
| G   | **Fix G10 first** (engineering): make a known class with no rate row refuse instead of falling to the no-ceiling fallback      | Mapping to PREMIUM / NON_PREMIUM on a multiplex would then block instead of selling uncapped.                                               | Removes option D's trap for every cinema. It is a change to pricing-engine behaviour, so it needs its own PR, tests and owner sign-off. It does not by itself answer which class Platinum Executive is.                                 |

Whatever is chosen, the runbook still applies: QA proves platform behaviour, not that the
numbers are the state's. Production activation stays refused while `textReviewed` is false.

## 6. Other things noticed (not changed)

### 6.1 The compliance panel contradicts the blocker

`GET /cinemas/cmtnq138t000fb9jhqkl48fmk/pricing-compliance` returns
`status: INVALID_CINEMA_CLASSIFICATION`, but:

- `summary` reads "Cannot publish - Regular is priced at Rs 151 ...". That comes from Rs 151
  test ticket types on the cinema's **completed** September shows, not from the Platinum
  Executive mapping that actually blocks the upcoming shows.
- `onlineFee` reads `ALLOWED`, "A booking fee may be charged." When no policy resolves,
  `cinema-compliance.service.ts` defaults `onlineFee.policy` to `ALLOWED`. The matched AP rows
  say `REQUIRES_APPROVAL`, and checkout holds the platform fee at 0. The text shown to the
  organizer is the opposite of what checkout does.

Both are display issues on the organizer panel, not in checkout. Worth a separate small fix.

### 6.2 PREMIUM / NON_PREMIUM are offered for every cinema

`apps/organizer-web/components/seat-class-mapping.tsx` lists all four classes regardless of
the cinema's format or state. For an AP multiplex, two of them resolve to no ceiling (3.4).

### 6.3 The one show at the venue that does sell is not a cinema show

`cmv2ng5he00kflh0yhb9xr4dm` "Film Appreciation Morning" (2026-11-15, capacity 80) reports
`SELLING`. `GET /shows/cmv2ng5he00kflh0yhb9xr4dm/pricing` shows `cinemaId: null`,
`screenName: null` and one Rs 0 ticket type "Free pass" with no seat category. It is a free,
general-admission event held at the same venue, not a show on Screen 1, so the cinema pricing
check does not apply to it (`sessionSaleEligibility`: "A show with no cinema is not regulated").
Nothing to do.
