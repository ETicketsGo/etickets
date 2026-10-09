# Telangana cinema ticket pricing: research and rule-engine review

Status: **research and proposal only. Nothing in this document is active, seeded or approved.**
Prepared 2026-10-09 on branch `docs/telangana-cinema-pricing` (base `313dfa2`).

Related: [`docs/compliance/india-cinema-vijayawada-launch.md`](../compliance/india-cinema-vijayawada-launch.md)
(which already says "do not reconstruct G.O.77 from press coverage"), and
`apps/api/prisma/seed-india-cinema-policy.ts` (Telangana rows are metadata only, by design).

## 0. Summary

- **The text of G.O.Ms.No.77 was NOT read.** The official GO repository
  (`goir.telangana.gov.in`), the High Court site (`tshc.gov.in`) and the Telangana Gazette host
  could not be reached from the research environment (TCP connection refused, see section 1.3).
  No copy of the order, its annexure, or any High Court judgment PDF was found on any other
  host. **So no rule below is VERIFIED.** Every G.O.77 value is REPORTED (press only) or UNKNOWN.
- What the press consistently reports: G.O.77, Home (General) Department, dated 14-08-2026,
  amends G.O.Ms.No.120 (21-12-2021). It sets a **minimum and a maximum** price per theatre class
  and seat type, defines a new **special theatre** class, requires **25% non-premium seats** in
  every theatre, gives air-cooled theatres **two years** to become AC or charge non-AC rates, and
  sets conditions (8 to 11) for **price hikes for films with a budget over Rs 100 crore**.
- G.O.77 is reported to class theatres by **format and climate only**, not by local body
  (corporation / municipality / panchayat). That is a different shape from the Andhra Pradesh
  table.
- Two facts that decide what the customer pays are **in conflict** in the reporting:
  whether maintenance is inside the price or added to it, and whether a separate online booking
  charge exists. These must stay UNCONFIRMED until the order is read.
- The engine can express most of the base table (classes, seat classes, min and max, dates). It
  **cannot** express: the 25% non-premium share, film-specific hike memos, the special-show
  price, or a GST-exclusive ceiling. There are also two engine defects that should be fixed
  before ANY market is activated (section 4, G1 and G2).
- Recommendation: keep Telangana DRAFT and unsellable as it is today. Obtain a certified copy of
  G.O.77 (and G.O.120), then load the section 3 rows. Owner approvals are listed in section 5.

Verification labels used throughout:

| Label    | Meaning                                                                                             |
| -------- | --------------------------------------------------------------------------------------------------- |
| VERIFIED | Read in a primary source (the order, the gazette, a judgment) or, for code, read in this repository |
| REPORTED | Only in secondary sources (newspapers, legal news sites); primary not read                          |
| UNKNOWN  | Not found in any source, or sources conflict with no way to settle it                               |

## 1. Sources

### 1.1 Primary sources (none could be read)

| #   | Document                                                                        | Where it should be                              | Result                                                                                                                     |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| P1  | G.O.Ms.No.77, Home (General) Department, dated 14-08-2026 (with annexure)       | `https://goir.telangana.gov.in/`                | **Not read.** Host refused the connection (`ECONNREFUSED 103.122.129.62:443`, also on port 80). No mirror found by search. |
| P2  | G.O.Ms.No.120, Home (General) Department, dated 21-12-2021                      | same portal                                     | **Not read.** Same reason.                                                                                                 |
| P3  | Telangana Gazette notification of P1                                            | `tsgazette.cgg.gov.in` / `tggazette.cgg.gov.in` | **Not read.** Hosts unreachable.                                                                                           |
| P4  | Telangana Cinemas (Regulation) Act, 1955, s.7A (review of rate decisions)       | Act text                                        | **Not read.** Only cited in court reporting.                                                                               |
| P5  | High Court of Telangana orders (see 2.6)                                        | `https://tshc.gov.in/`                          | **Not read.** Host unreachable.                                                                                            |
| P6  | Supreme Court order, Mythri Movie Makers v. Dachepally Chandra Babu, 13-03-2026 | sci.gov.in                                      | **Not read.** Reported only.                                                                                               |
| P7  | Memo No.21/HOME-GEN2/2026 dated 20-09-2026 ("The Paradise" hike)                | Home Department                                 | **Not read.** Reported only.                                                                                               |

`https://www.telangana.gov.in/government-orders/` was reachable but only links to P1's portal
and lists no cinema order.

### 1.2 Secondary sources (used to locate facts; none is authoritative)

| #   | Source                                                                                                                                                                                                                               | Date          | Used for                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | Deccan Chronicle, "Telangana Revises Cinema Ticket Rates, Mandates Affordable Access" https://www.deccanchronicle.com/southern-states/telangana/telangana-revises-cinema-ticket-rates-mandates-affordable-access-1980588             | 19-08-2026    | Home Department; rate table; 25% non-premium; maintenance Rs 5 / Rs 3; "prices exclude GST but include maintenance charges"; replaces Dec 2021 norms                                             |
| S2  | ETV Bharat (Telugu) https://www.etvbharat.com/te/entertainment/government-of-telangana-issued-orders-regarding-movie-ticket-prices-ten26081905151                                                                                    | 19-08-2026    | GO 77 amends GO 120; rate table; special theatre definition; online booking Rs 5 AC / Rs 3 non-AC; 5 shows 8 AM to 1 AM; hike conditions (Rs 100 crore budget, Rs 1 crore deposit, 10 days, 20%) |
| S3  | Andhravilas https://andhravilas.net/telangana-go-cinema-ticket-price-hike-revenue-share-new-rules/                                                                                                                                   | 19-08-2026    | Same table; online charges Rs 5 / Rs 3; welfare fund conditions                                                                                                                                  |
| S4  | TeluguOne https://www.teluguone.com/tmdb/news/news-en-229306c1.html                                                                                                                                                                  | Aug 2026      | Issue date 14-08-2026; table; special theatre definition; air-cooled 2-year window                                                                                                               |
| S5  | Deccan Chronicle, exhibitors' letter to CM https://www.deccanchronicle.com/entertainment/tollywood/telangana-exhibitors-letter-to-cm-revanth-reddy-raise-concerns-over-ticket-pricing-1982667                                        | Aug 2026      | "G.O. 77, dated August 14, 2026"; overlapping slabs; air-cooled conversion                                                                                                                       |
| S6  | NTV Telugu https://ntvtelugu.com/news/telangana-exhibitors-association-letter-cm-revanth-reddy-against-go-77-movie-ticket-rates-1008795.html                                                                                         | Aug 2026      | Exhibitor objections (no figures)                                                                                                                                                                |
| S7  | Namasthe Telangana https://www.ntnews.com/cinema/telangana-film-chamber-demands-review-of-ticket-pricing-go-77-2489313                                                                                                               | 21-08-2026    | Film Chamber review demand; exhibitors said they would go to court in 10 days                                                                                                                    |
| S8  | NewsMeter, "The Paradise ticket price hike: HC declines interim relief" https://newsmeter.in/entertainment/the-paradise-ticket-price-hike-telangana-hc-declines-interim-relief-to-petitioners-776367                                 | 28-09-2026    | GO 120 and GO 77 both "Home (General) Department"; Memo 21/HOME-GEN2/2026; hike amounts; 10-day limit                                                                                            |
| S9  | Telangana Today, "HC questions last-minute ticket hike for The Paradise" https://telanganatoday.com/telangana-hc-questions-last-minute-ticket-hike-for-the-paradise                                                                  | 22-09-2026    | Court: memo gave no reasons "as required under the relevant clauses of the government order"                                                                                                     |
| S10 | Bar and Bench, "Supreme Court stays Telangana HC order mandating 90-day notice" https://www.barandbench.com/amp/story/news/litigation/supreme-court-stays-telangana-hc-order-mandating-90-day-notice-for-film-ticket-price-hikes     | 13-03-2026    | SC stay of HC 90-day-notice order                                                                                                                                                                |
| S11 | Sakshi Post / NewsMeter / Siasat on the 90-day rule and repeated memos (links in 2.6)                                                                                                                                                | Jan-Feb 2026  | HC single judge and division bench                                                                                                                                                               |
| S12 | ThePrint (PTI) https://theprint.in/india/telangana-cinema-ticket-rates-revised/787690/ and The News Minute https://www.thenewsminute.com/telangana/movie-ticket-prices-hiked-telangana-multiplexes-can-charge-rs-250-plus-gst-159149 | 24/25-12-2021 | GO 120 rates "plus GST"; maintenance Rs 5 / Rs 3; tickets must show GST, maintenance and online charges separately                                                                               |
| S13 | Track Tollywood (HTTP 403, read via search summary only) https://tracktollywood.com/telangana-new-ticket-prices-special-theatres-300                                                                                                 | Aug 2026      | Corroboration of the table only                                                                                                                                                                  |

### 1.3 What to do to reach VERIFIED

1. Download P1 and P2 from `goir.telangana.gov.in` from an Indian network (the refusal looks
   like geo or network filtering, not a missing page), or request certified copies from the
   Home (General) Department or the Telangana Film Development Corporation.
2. Check the Gazette for the notification and its commencement date.
3. Pull the High Court orders in the "Paradise" writ petitions and any writ against G.O.77
   itself from the High Court case-status system.
4. Re-run this document's section 2 against the text and change each label.

## 2. Extracted rules

### 2.1 Order identity and dates

| Rule                                                                                           | Value                                            | Status   | Source                                                                        |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------- | ----------------------------------------------------------------------------- |
| Instrument                                                                                     | G.O.Ms.No.77                                     | REPORTED | S1-S8                                                                         |
| Department                                                                                     | Home (General) Department                        | REPORTED | S1 ("Home Department"), S8                                                    |
| Date of issue                                                                                  | 14-08-2026                                       | REPORTED | S4, S5, S8 (S1/S2 give 19-08-2026, which is the publication date of the news) |
| Relation to earlier order                                                                      | Amends G.O.Ms.No.120, Home (General), 21-12-2021 | REPORTED | S2, S8                                                                        |
| Commencement / effective date                                                                  | Not stated in any source                         | UNKNOWN  | -                                                                             |
| Gazette notification                                                                           | Not found                                        | UNKNOWN  | -                                                                             |
| Whether G.O.120 is wholly replaced or only amended (e.g. any clause of G.O.120 still in force) | Sources say "amend"                              | UNKNOWN  | S2                                                                            |

### 2.2 Theatre classification

| Class                                               | Definition as reported                                                                                                                                                  | Engine mapping                                             | Status                                                             |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| Non-AC theatre                                      | Single screen without AC                                                                                                                                                | `SINGLE_SCREEN` + `NON_AC`                                 | REPORTED (S1-S4)                                                   |
| AC / Air-cooled theatre                             | One slab covers both                                                                                                                                                    | `SINGLE_SCREEN` + `AC`, and `SINGLE_SCREEN` + `AIR_COOLED` | REPORTED (S1, S4)                                                  |
| Air-cooled transition                               | Air-cooled theatres have 2 years to convert to AC or charge non-AC rates                                                                                                | Dated `AIR_COOLED` rows (see 3.3)                          | REPORTED (S4, S5). Exact deadline and start of the 2 years UNKNOWN |
| Special theatre                                     | Standalone screen with 7.1 or better digital surround, 2K/4K projection, and IMAX or a screen of 75 ft and above (whether ALL or ANY of these is required is not clear) | `SPECIAL_THEATRE`                                          | REPORTED (S2, S4). AND/OR test UNKNOWN                             |
| Multiplex                                           | Multi-screen complex (statutory definition not reported)                                                                                                                | `MULTIPLEX`                                                | REPORTED; definition UNKNOWN                                       |
| Local body (corporation / municipality / panchayat) | **Not reported as a dimension in G.O.77 or G.O.120.** The 25% rule applies "irrespective of category or location".                                                      | `localBodyType: null`                                      | UNKNOWN (absence in press is not proof of absence in the order)    |

### 2.3 Admission rates (per ticket, rupees)

All figures REPORTED, consistent across S1, S2, S3, S4 and S13. None VERIFIED.

| Class           | Seat type          | Min | Max | Engine `seatCategory`    |
| --------------- | ------------------ | --- | --- | ------------------------ |
| Non-AC          | Non-premium        | 30  | 70  | `NON_PREMIUM`            |
| Non-AC          | Premium            | 50  | 100 | `PREMIUM`                |
| AC / Air-cooled | Non-premium        | 50  | 150 | `NON_PREMIUM`            |
| AC / Air-cooled | Premium            | 100 | 200 | `PREMIUM`                |
| Special theatre | Non-premium        | 100 | 250 | `NON_PREMIUM`            |
| Special theatre | Premium / recliner | 200 | 300 | `PREMIUM` and `RECLINER` |
| Multiplex       | Regular            | 100 | 250 | `REGULAR`                |
| Multiplex       | Recliner           | 200 | 300 | `RECLINER`               |

For comparison, G.O.120 (2021) as REPORTED by S12: non-AC 30-70, AC 50-150, multiplex 100-250,
recliner max 200 (single screen) and 300 (multiplex), all "plus GST". So G.O.77's main changes
are the premium/non-premium split for single screens and the new special-theatre class.

Open questions (UNKNOWN): whether "premium" in a special theatre includes non-recliner premium
seats; whether a multiplex may have a "premium" (non-recliner) class and at what band; whether
the ranges overlap by design (exhibitors flagged the overlap as ambiguous, S5).

### 2.4 Seat mix, GST, maintenance, online charges, shows

| Rule                                                                                        | Value                                                                                                                                                                                                                                          | Status                                                    | Source                                                                                          |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Minimum non-premium share                                                                   | 25% of seats in every theatre, irrespective of category or location                                                                                                                                                                            | REPORTED                                                  | S1, S4 (S2's translation says "for economically disadvantaged patrons"; treat as the same rule) |
| GST                                                                                         | Rates exclusive of GST (GST added on top)                                                                                                                                                                                                      | REPORTED for G.O.120 (S12); REPORTED for G.O.77 (S1 only) | S1, S12                                                                                         |
| Maintenance charge                                                                          | Rs 5 per ticket AC, Rs 3 per ticket non-AC                                                                                                                                                                                                     | REPORTED                                                  | S1 (G.O.77), S12 (G.O.120)                                                                      |
| Maintenance inside or on top of the price                                                   | **Conflict.** S1: "prices exclude GST but include maintenance charges". S12 (G.O.120): tickets must show GST, maintenance and online charges "separately".                                                                                     | UNKNOWN                                                   | S1 vs S12                                                                                       |
| Online booking / convenience charge                                                         | **Conflict.** S2 and S3 report online booking charges of Rs 5 (AC) / Rs 3 (non-AC) per ticket. Those are the same figures as maintenance in S1, so this may be a confusion of the two. S1 says only "online booking charges apply separately". | UNKNOWN                                                   | S1, S2, S3                                                                                      |
| Whether any online charge cap binds a third-party platform (us) as opposed to the exhibitor | Not addressed in any source                                                                                                                                                                                                                    | UNKNOWN                                                   | -                                                                                               |
| Ticket printing                                                                             | GST, maintenance and online charges shown separately on the ticket (G.O.120)                                                                                                                                                                   | REPORTED                                                  | S12                                                                                             |
| Shows per day                                                                               | Five, between 8 AM and 1 AM                                                                                                                                                                                                                    | REPORTED                                                  | S2, S3 (this may be a hike-period condition, not a general rule)                                |

### 2.5 Price-hike exceptions (G.O.77 conditions 8 to 11)

| Rule                                                                        | Value                                                                                                                                                                                                            | Status   | Source                                                                 |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| Eligibility                                                                 | Films with production budget over Rs 100 crore (S2 adds: advanced VFX, IMAX format, or pan-India release)                                                                                                        | REPORTED | S2, S3, S7-S9                                                          |
| Deposit                                                                     | Rs 1 crore to the Telugu Film Industry Employees' Welfare Committee (run by TGFDC)                                                                                                                               | REPORTED | S2, S3                                                                 |
| Revenue share                                                               | 20% of the additional revenue from the hike to the welfare fund                                                                                                                                                  | REPORTED | S2, S3 (this share pre-dates G.O.77 in per-film orders from late 2025) |
| Duration                                                                    | At most 10 days from release                                                                                                                                                                                     | REPORTED | S2, S8                                                                 |
| Approval                                                                    | A Home Department memo per film, which must give reasons "as required under the relevant clauses of the government order"                                                                                        | REPORTED | S8, S9                                                                 |
| Example                                                                     | Memo No.21/HOME-GEN2/2026, 20-09-2026: special show 23-09-2026 at Rs 500 per ticket incl. GST; then extra Rs 48 / Rs 23 (single screen) and Rs 95 / Rs 45 (multiplex), incl. GST, over two periods to 03-10-2026 | REPORTED | S8                                                                     |
| Hike amounts in G.O.77 itself (fixed amounts, percentages, or set per memo) | Not reported                                                                                                                                                                                                     | UNKNOWN  | -                                                                      |

### 2.6 Court orders

| Matter                                                                                                                | What happened                                                                                                                                                                                       | Status   | Source                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W.P. by Dachepally Chandra Babu (HC, Justice N.V. Shravan Kumar), 20-01-2026                                          | Set aside a Home Dept memo of 08-01-2026 that raised prices for two films; interim direction that any hike be put in the public domain 90 days before release, so the s.7A review right can be used | REPORTED | S10, S11: https://www.sakshipost.com/news/telangana/telangana-high-court-upholds-90-day-rule-movie-ticket-price-hikes-476936                              |
| Writ appeal by Shine Screens India LLP (HC Division Bench, CJ Aparesh Kumar Singh and Justice Ghouse Meera Mohiuddin) | Dismissed; single-judge directions upheld                                                                                                                                                           | REPORTED | https://newsmeter.in/top-stories/mana-shankara-varaprasad-garu-telangana-hc-dismisses-appeal-against-single-judge-order-on-movie-ticket-price-hike-762115 |
| Supreme Court, Mythri Movie Makers v. Dachepally Chandra Babu, 13-03-2026 (Maheshwari and Chandurkar JJ.)             | **Stayed** the HC 90-day-notice order; existing approval mechanism continues pending hearing                                                                                                        | REPORTED | S10                                                                                                                                                       |
| HC comments on repeated memos                                                                                         | Court criticised the Home Department for issuing hike memos despite restraints                                                                                                                      | REPORTED | https://www.siasat.com/hc-raps-telangana-govt-over-repeated-movie-ticket-hike-orders-3486705/                                                             |
| "The Paradise" writ petitions (2026)                                                                                  | 22-09: court noted the memo gave no reasons and left no time to object; 28-09 (Justice T. Madhavi Devi): no interim relief; matters to be heard together; counter posted to 06-10                   | REPORTED | S8, S9                                                                                                                                                    |
| Any writ petition against G.O.77 itself                                                                               | Exhibitors threatened to go to court (S7). No filing found.                                                                                                                                         | UNKNOWN  | -                                                                                                                                                         |

The current legal state of hike approvals is therefore unsettled and moves week to week. This
alone argues against encoding film-specific hikes in configuration (see G9).

## 3. Proposed configuration (INACTIVE, pending approval)

**Do not load these rows until section 2 is VERIFIED and section 5 is approved.** The engine has
no `INACTIVE` status; the equivalent is `DRAFT`, which nothing resolves (only `ACTIVE` rows are
loaded: `apps/api/src/pricing/cinema-policy/cinema-pricing-policy.service.ts:37-47`).

### 3.1 RegulatoryDocument

```json
{
  "reference": "G.O.Ms.No.77, Home (General) Department, dated 14-08-2026",
  "country": "India",
  "region": "Telangana",
  "documentUrl": null,
  "textReviewed": false,
  "notes": "Values in the DRAFT rows come from press reports (docs/regulatory/TELANGANA-CINEMA-PRICING.md). Set documentUrl to the goir.telangana.gov.in PDF and textReviewed=true only after a person has read the order and its annexure."
}
```

The existing seed reference is `G.O.77 dated 14-08-2026`. It should be renamed to the full
citation above when the text is read, not before (the reference is copied onto bookings).

### 3.2 Rate rows (`CinemaPricingPolicy`)

Common fields for every row below:

```json
{
  "country": "India",
  "region": "Telangana",
  "district": "*",
  "city": "*",
  "currency": "INR",
  "localBodyType": null,
  "maintenanceTaxCategory": null,
  "maintenanceTreatment": "UNCONFIRMED",
  "onlineFeePolicy": "REQUIRES_APPROVAL",
  "onlineFeeCapMinor": null,
  "status": "DRAFT",
  "version": 1,
  "effectiveFrom": "<commencement date of G.O.77 - UNKNOWN; do not guess>",
  "effectiveTo": null,
  "regulatoryReference": "G.O.Ms.No.77, Home (General) Department, dated 14-08-2026",
  "regulatoryDocumentId": "<id of the 3.1 row>",
  "notes": "PENDING APPROVAL. Figures REPORTED (press), not VERIFIED. Do not activate."
}
```

Why these postures:

- `maintenanceTreatment: "UNCONFIRMED"` because sources conflict (2.4). The database refuses
  `ACTIVE` with `UNCONFIRMED` (migration `20260904160500_unconfirmed_never_active`), so these
  rows physically cannot go live by accident. Change it to `INCLUDED_IN_TICKET_PRICE` or
  `ADDED_TO_TICKET_PRICE` only from the order text.
- `onlineFeePolicy: "REQUIRES_APPROVAL"` gives a fee ceiling of 0
  (`apps/api/src/pricing/cinema-policy/apply-policy.ts:132-148`), so ETicketsGo charges no
  convenience fee in Telangana until counsel confirms what a third-party platform may charge.
- `localBodyType: null` because no source reports local-body banding (2.2). If the order turns
  out to band by local body, these rows must be split like the Andhra Pradesh table.

Per-row fields (`maintenanceChargeMinor` is the REPORTED Rs 5 / Rs 3, in paise; prices in paise):

| cinemaFormat    | climateType | seatCategory | ticketPriceMinMinor | ticketPriceMaxMinor | maintenanceChargeMinor | ticketPriceRule                                                   |
| --------------- | ----------- | ------------ | ------------------- | ------------------- | ---------------------- | ----------------------------------------------------------------- |
| SINGLE_SCREEN   | NON_AC      | NON_PREMIUM  | 3000                | 7000                | 300                    | G.O.77 non-AC, non-premium: Rs 30-70, exclusive of GST (REPORTED) |
| SINGLE_SCREEN   | NON_AC      | PREMIUM      | 5000                | 10000               | 300                    | G.O.77 non-AC, premium: Rs 50-100 (REPORTED)                      |
| SINGLE_SCREEN   | AC          | NON_PREMIUM  | 5000                | 15000               | 500                    | G.O.77 AC/air-cooled, non-premium: Rs 50-150 (REPORTED)           |
| SINGLE_SCREEN   | AC          | PREMIUM      | 10000               | 20000               | 500                    | G.O.77 AC/air-cooled, premium: Rs 100-200 (REPORTED)              |
| SINGLE_SCREEN   | AIR_COOLED  | NON_PREMIUM  | 5000                | 15000               | 500                    | as AC; see 3.3 for expiry                                         |
| SINGLE_SCREEN   | AIR_COOLED  | PREMIUM      | 10000               | 20000               | 500                    | as AC; see 3.3 for expiry                                         |
| SPECIAL_THEATRE | null        | NON_PREMIUM  | 10000               | 25000               | 500                    | G.O.77 special theatre, non-premium: Rs 100-250 (REPORTED)        |
| SPECIAL_THEATRE | null        | PREMIUM      | 20000               | 30000               | 500                    | G.O.77 special theatre, premium/recliner: Rs 200-300 (REPORTED)   |
| SPECIAL_THEATRE | null        | RECLINER     | 20000               | 30000               | 500                    | same band as premium (REPORTED)                                   |
| MULTIPLEX       | null        | REGULAR      | 10000               | 25000               | 500                    | G.O.77 multiplex, regular: Rs 100-250 (REPORTED)                  |
| MULTIPLEX       | null        | RECLINER     | 20000               | 30000               | 500                    | G.O.77 multiplex, recliner: Rs 200-300 (REPORTED)                 |

Plus three climate-only fallback rows, as the AP seed has, so a multi-class cart still resolves
(`cinemaFormat: null`, `seatCategory: null`, no min, no max):

| climateType | maintenanceChargeMinor |
| ----------- | ---------------------- |
| AC          | 500                    |
| AIR_COOLED  | 500                    |
| NON_AC      | 300                    |

Caution on the fallbacks: a fallback has no ceiling, so any seat class not in the table above
(for example a multiplex `PREMIUM` or `NON_PREMIUM` ticket) would sell **uncapped** (see G10).
Before activation, either add rows for every class a Telangana cinema actually uses or fix G10.

Caution on maintenance for special theatres and multiplexes: the Rs 5 assumes they are AC. The
AP seed makes the same assumption (`maintenanceFor(null)` returns the cooled amount).

### 3.3 Air-cooled transition

If the order confirms a fixed deadline (REPORTED: two years from the order), the `AIR_COOLED`
rows get `effectiveTo` = that deadline, and two successor `AIR_COOLED` rows with the non-AC
band (3000-7000 and 5000-10000, maintenance per the order) get `effectiveFrom` = the same
instant. The engine already resolves dated rows without ambiguity
(`telangana-and-immutability.integration-postgres.spec.ts:173-225`). Because the engine
compares against booking time, not show time (G4), a ticket bought before the deadline for a
show after it would use the old band.

### 3.4 What cannot be expressed as rows

- The 25% non-premium seat share (no field anywhere).
- Film-specific hike memos (no scope by film, event or show; a dated state-wide row would raise
  the ceiling for every film).
- The special-show price (Rs 500 in the Paradise memo).
- A GST-exclusive ceiling (see G3).

### 3.5 Existing Telangana seed rows

The two metadata rows in `apps/api/prisma/seed-india-cinema-policy.ts` (G.O.120 historical and
G.O.77, both DRAFT, UNCONFIRMED, no money) should stay as they are until the order is read.
The G.O.120 row should become `SUPERSEDED` (never ACTIVE) once G.O.77's commencement is known.

## 4. Rule-engine review

Scope: `apps/api/src/pricing/cinema-policy/*`, `apps/api/src/admin/cinema-pricing-policies.service.ts`,
`apps/api/src/admin/admin.controller.ts`, `apps/api/src/bookings/bookings.service.ts`,
`apps/api/src/events/event-sellability.service.ts`, `apps/api/src/cinemas/cinema-compliance.service.ts`,
`apps/api/prisma/schema.prisma` (models `CinemaPricingPolicy` 3153-3223, `RegulatoryDocument` 3098-3128),
`apps/api/prisma/seed-india-cinema-policy.ts`, and the five `20260904*` migrations. Code facts below are VERIFIED (read in this repository at `313dfa2`).

### 4.1 Properties

| Property                         | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| State-specific                   | **Yes**, by `country`/`region`/`district`/`city` with `'*'` wildcards; the most specific row wins by bit weight (seat 128 > climate 64 > format 32 > local body 16 > city 8 > district 4 > region 2 > country 1); a tie is a configuration error. No merging between rows. **But "regulated" is decided per country**: one ACTIVE India row makes every Indian cinema fail closed unless it resolves. Region and district are free text. | resolver `cinema-pricing-policy.resolver.ts:102-162, 215-266`                      |
| Effective-date-aware             | **Yes**, `effectiveFrom` inclusive, `effectiveTo` exclusive. **Compared with booking time ("now"), never the show date.**                                                                                                                                                                                                                                                                                                                | resolver:154-155; `bookings.service.ts:296, 461, 1254, 1300`                       |
| Theatre-category-aware           | **Yes**: `LocalBodyType`, `CinemaFormat` (incl. `SPECIAL_THEATRE`), `ClimateType` (`AC`, `AIR_COOLED`, `NON_AC`). Classification is declared by the organizer and is not verified or audited.                                                                                                                                                                                                                                            | `schema.prisma:3230-3253`; `cinemas.service.ts:156-161`                            |
| Seat-class-aware                 | **Yes**: `SeatCategory.regulatoryClass` (`REGULAR`, `RECLINER`, `PREMIUM`, `NON_PREMIUM`); unmapped class in a regulated market is refused. **No seat-mix (25%) rule.**                                                                                                                                                                                                                                                                  | `schema.prisma:1190`; `bookings.service.ts:1089-1104, 1150`                        |
| Min and max price                | **Both** enforced by `checkTicketPrice` (below-min reported with the misnamed status `PRICE_EXCEEDS_LIMIT`).                                                                                                                                                                                                                                                                                                                             | `apply-policy.ts:155-185`                                                          |
| Versioned / auditable            | **Partly.** `version`, `supersedesId` lineage, statuses `DRAFT/ACTIVE/SUPERSEDED/DISABLED`, preflight checks, audit entries for create/update/activate/supersede/disable, booking snapshot of policy id, version, reference and jurisdiction. No maker-checker; immutability is service-level only.                                                                                                                                      | `admin/cinema-pricing-policies.service.ts:66-317`; `bookings.service.ts:628-645`   |
| Enforced server-side             | **Yes, fails closed at checkout** with a 409 and an audit entry for `POLICY_NOT_FOUND`, `PRICE_EXCEEDS_LIMIT`, `INVALID_CINEMA_CLASSIFICATION`, `POLICY_CONFIGURATION_ERROR`. `REQUIRES_APPROVAL` sells with the online fee forced to 0.                                                                                                                                                                                                 | `bookings.service.ts:460-525`; `packages/shared-types/src/cinema-pricing.ts:64-81` |
| Readiness vs checkout consistent | **No**, see G7.                                                                                                                                                                                                                                                                                                                                                                                                                          | below                                                                              |

### 4.2 Gap list

Severity is for a Telangana activation. "Engine" gaps belong to the engineer unifying readiness
and checkout; this branch changes no engine code.

| #   | Severity | Gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Where                                                                                                                                                                                                           |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | **High** | **PATCH can activate a DRAFT row with no preflight.** The body is `Partial<PolicyInput>` (an interface, no ValidationPipe) and `updateDraft` writes `data: patch` unchanged, so `{"status":"ACTIVE"}` (or `version`, `supersedesId`) bypasses `activationPreflight`, including the production `TEXT_NOT_REVIEWED` block. It is audited only as `DRAFT_UPDATED`. The DB constraint still refuses `UNCONFIRMED` + `ACTIVE`, which is what protects the section 3 rows.                                                                                   | `admin/admin.controller.ts:371-379`; `admin/cinema-pricing-policies.service.ts:81-99`                                                                                                                           |
| G2  | **High** | **Seed re-run corrupts the AP fallback rows.** The "Telangana correction" block (variable `existingTg`) sits inside the Andhra Pradesh fallback loop, whose `where` has `region: 'Andhra Pradesh'`. A second run rewrites DRAFT AP fallbacks to `maintenanceChargeMinor: 0, UNCONFIRMED`, after which they can never be activated, and multi-class carts would fail `POLICY_NOT_FOUND` once AP rate rows are active.                                                                                                                                   | `prisma/seed-india-cinema-policy.ts:396-426`                                                                                                                                                                    |
| G3  | **High** | **GST basis mismatch.** Both AP and (REPORTED) Telangana ceilings are exclusive of GST, but ticket prices are stored GST-inclusive (`seed-india-gst.ts:97`), and `checkTicketPrice` compares the inclusive price with the exclusive ceiling. A lawful price at the ceiling is refused, and a minimum is met too easily. The policy has no field saying which basis its limits use.                                                                                                                                                                     | `apply-policy.ts:155-185`; `prisma/seed-india-gst.ts:88-97`                                                                                                                                                     |
| G4  | Medium   | Policy chosen at booking time, not show time. Matters at G.O. commencement and at the air-cooled deadline (3.3).                                                                                                                                                                                                                                                                                                                                                                                                                                       | `bookings.service.ts:296, 1254`; `event-sellability.service.ts:180`; `cinema-compliance.service.ts:78`                                                                                                          |
| G5  | Medium   | `supersede` creates an ACTIVE row with no preflight (no `NO_CEILING`, ambiguity or `TEXT_NOT_REVIEWED` check), can change scope and can backdate. `seed --activate` also bypasses preflight.                                                                                                                                                                                                                                                                                                                                                           | `admin/cinema-pricing-policies.service.ts:260-297`; seed:338-343                                                                                                                                                |
| G6  | Medium   | No maker-checker: one admin can create and activate. No DB-level immutability for ACTIVE/SUPERSEDED rows.                                                                                                                                                                                                                                                                                                                                                                                                                                              | `admin/cinema-pricing-policies.service.ts`                                                                                                                                                                      |
| G7  | Medium   | **Readiness and checkout differ**: (a) the quote endpoint resolves the policy but never blocks, so a quote succeeds for a show checkout will refuse; (b) ticket types with no seat category are checked by sellability/compliance but not by checkout's per-class loop; (c) currency is `'INR'` hard-coded in compliance, the first ticket type's in sellability, the cart's at checkout; (d) compliance scans up to 200 ticket types across past sessions; (e) publish runs sellability once, later changes only caught by the sweep and at checkout. | `bookings.service.ts:1090-1103, 1299-1321`; `event-sellability.service.ts:358, 410-419`; `cinema-compliance.service.ts:95-104, 138, 152-160`; `events.service.ts:1213`; `event-sellability-sweep.service.ts:69` |
| G8  | Medium   | A per-class resolution that blocks (tie or configuration error with no policy) passes `checkTicketPrice` as `ok: true`, everywhere.                                                                                                                                                                                                                                                                                                                                                                                                                    | `apply-policy.ts:163-165`                                                                                                                                                                                       |
| G9  | Medium   | No model for the 25% non-premium share, film-specific hikes with approval (G.O.77 conditions 8-11), special-show prices, or show-count/time limits. No scope by film, event or show.                                                                                                                                                                                                                                                                                                                                                                   | `schema.prisma:3153-3223`                                                                                                                                                                                       |
| G10 | Medium   | A seat class with no rate row falls to a fallback with no ceiling and sells uncapped (already true for AP Nagar/Gram Panchayat recliners).                                                                                                                                                                                                                                                                                                                                                                                                             | seed:271-274, 386-445                                                                                                                                                                                           |
| G11 | Low      | Online fee cap is per order, before GST, and does not apply to the organizer-absorbed fee. If Telangana caps per ticket, the shape is wrong.                                                                                                                                                                                                                                                                                                                                                                                                           | `pricing/pricing.service.ts:114-124`                                                                                                                                                                            |
| G12 | Low      | Classification (format, climate, local body) is self-declared by the organizer and edits are not audited; declaring a higher class raises the ceiling. A multiplex with no climate set fails multi-class carts.                                                                                                                                                                                                                                                                                                                                        | `cinemas.service.ts:156-161, ~228`                                                                                                                                                                              |
| G13 | Low      | `currency` is not part of specificity (two rows differing only by currency tie); `ONLINE_FEE_NOT_ALLOWED` is never emitted; below-minimum uses `PRICE_EXCEEDS_LIMIT`.                                                                                                                                                                                                                                                                                                                                                                                  | resolver:121-132                                                                                                                                                                                                |

What already protects us today (VERIFIED): Telangana has no ACTIVE row and no money values; its
rows are `UNCONFIRMED`, which the database refuses to activate; the G.O.77 document is
`textReviewed: false` with no URL (`telangana-and-immutability.integration-postgres.spec.ts`,
`seed-isolation.integration-postgres.spec.ts`).

## 5. Approvals required before activation

| #   | Approval                                                                                                                                                                        | Owner                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| A1  | Obtain and read G.O.Ms.No.77 (with annexure), G.O.Ms.No.120 and the Gazette notification; re-label section 2; set `documentUrl` and `textReviewed: true`                        | Owner / counsel                  |
| A2  | Confirm the commencement date (`effectiveFrom`) and the air-cooled deadline                                                                                                     | Counsel                          |
| A3  | Confirm whether limits are inclusive or exclusive of GST, and whether maintenance is inside or on top of the price (sets `maintenanceTreatment`)                                | Counsel / tax adviser            |
| A4  | Decide what ETicketsGo, as a third party, may charge as a convenience fee in Telangana (sets `onlineFeePolicy` and cap); until then 0                                           | Owner + counsel                  |
| A5  | Decide how to meet the 25% non-premium rule: organizer attestation, a seat-map check, or out of scope                                                                           | Owner (product)                  |
| A6  | Decide whether to sell at hiked prices under per-film memos at all, given the live litigation (2.6); if yes, a separate design for film-scoped, time-boxed, approved exceptions | Owner + counsel                  |
| A7  | Fix G1, G2 and G3 (and decide G4) before ANY Indian market is activated; activating one India row regulates every Indian cinema                                                 | Engineering, with owner sign-off |
| A8  | A second admin reviews the rows and the preflight output before `activate` (no maker-checker in code, G6)                                                                       | Owner                            |
| A9  | Classify every Telangana cinema (format, climate, local body) and map every seat category to a regulatory class before activation, or they fail closed                          | Organizer onboarding             |
