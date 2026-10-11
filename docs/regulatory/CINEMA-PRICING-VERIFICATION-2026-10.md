# Cinema pricing: regulatory verification (AP G.O.Ms.No.13 and Telangana G.O.77)

Status: **verification record and proposals only. Nothing here changes configuration, seed values or
sales behaviour.** Prepared 2026-10-11 on branch `docs/regulatory-verification` (base `origin/main`
`6d9b4d1`). Retrieval date for every source below: **2026-10-11**.

Related: [`TELANGANA-CINEMA-PRICING.md`](./TELANGANA-CINEMA-PRICING.md) (engine gap list G1-G13),
[`VIJAYAWADA-SEAT-CLASS-FINDING.md`](./VIJAYAWADA-SEAT-CLASS-FINDING.md),
[`docs/compliance/india-cinema-vijayawada-launch.md`](../compliance/india-cinema-vijayawada-launch.md),
`apps/api/prisma/seed-india-cinema-policy.ts`.

## 0. Bottom line

- **Neither order's text could be read.** Every government portal that holds them refused the
  connection or was empty (section 6). No gazette, mirror or archive copy was found. So **no
  ceiling, floor, class definition or GST wording is VERIFIED against an order.** Anything below
  labelled VERIFIED is verified against a _court document_ or against _this repository_, and says so.
- What could be established: (a) the orders exist and the Andhra Pradesh and Telangana High Courts
  treat them as operative; (b) the AP rate table in the seed **matches the table printed by the
  press on 7-8 March 2022 cell for cell**, with **one omission** (Nagar / Gram Panchayat multiplex
  recliner, reported Rs 250, absent from the seed); (c) every source that quotes the AP order says
  its rates are **exclusive of GST**, **inclusive of maintenance** and **inclusive of online service
  charges**, while the AP High Court said, prima facie, in 2022 that online service charges cannot be
  part of the "rate of admission".
- Three code facts matter more than any number: the GST basis is compared wrongly (G3, still
  present), a seat class with no rate row still sells uncapped (G10, still present), and the seed
  stamps a 2026 "effective from" on a 2022 order. Section 4.
- Nothing was activated, edited or seeded. Production activation must stay refused while
  `textReviewed = false`.

Labels used:

| Label        | Meaning                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------- |
| VERIFIED     | Read in a primary document (order, judgment, gazette) or, for code, read in this repository         |
| CORROBORATED | Two or more independent news outlets agree; the primary order was NOT read. Not good enough to ship |
| REPORTED     | One secondary source only                                                                           |
| UNVERIFIED   | Asserted by the seed, the brief or a prior document; no source found                                |

Caveat on method: pages were read through a fetch tool that summarises HTML. Where a quotation is
shown it is the tool's quotation of the page; the one court order read in full as a PDF (S5) was
read by text extraction and is quoted from that text.

## 1. Verified rules

### 1.1 Verified against primary court documents

| #   | Rule or fact                                                                                                                                                                                                                                                                                                            | Source (URL, document, date)                                                                                                                                                       | Exact text                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V1  | In July 2022 the AP High Court treated ticket charges as **regulated and fixed**, and recorded that the question "whether the rate of admission includes the service charges or not" was **still open**. It did not decide it. The court order does not mention G.O.Ms.No.13 or GST rates.                              | S5: AP High Court, I.A.No.1 of 2022 in W.P.No.16346 of 2022 and batch (Bigtree Entertainment v. State of A.P.), order dated 01.07.2022, CJ P.K. Mishra and Justice DVSS Somayajulu | para 18: "Whether the rate of admission includes the service charges or not, is an issue that needs to be determined." and "As pointed out by the learned Senior Counsel for the petitioners, the ticket charges are regulated and fixed but the service charges vary." |
| V2  | AP rules made by G.O.Ms.No.69 (02.06.2022) cap a nodal-agency online service charge at **2% of the rate of admission**. The High Court **restrained** operating that online ticketing solution on 01.07.2022 (interim). So no AP service-charge ceiling for third-party platforms is in force as a result of that rule. | S5, paras 5 and 20                                                                                                                                                                 | Rule 17A(3): "...collection of a service charge not exceeding 2% of the rate of admission into cinema theatres." Para 20: "the respondents are restrained from giving effect to and operating the online ticketing solution..."                                         |
| V3  | The State's power to fix rates of admission was argued (by the Advocate General) to rest on a Division Bench judgment.                                                                                                                                                                                                  | S5, para 14 (argument, not a holding)                                                                                                                                              | "DKV Prasad Rao v Government of Andhra Pradesh, AIR 1984 Andhra Case 75 ... the power of the State to fix the rates has been upheld by the Division Bench"                                                                                                              |
| V4  | This repository's code and seed state, at `6d9b4d1`, are as described in sections 4 and 5. (Code facts only.)                                                                                                                                                                                                           | This repository                                                                                                                                                                    | -                                                                                                                                                                                                                                                                       |

### 1.2 Existence and operative status of the orders (court reporting; the judgments themselves not read)

| #   | Fact                                                                                                                                                                                                                                                                                                                                                        | Status   | Source                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | G.O.Ms.No.13 is dated **07.03.2022** and is treated as the operative AP ticket order: premiere rates "[do not contravene] G.O.Ms.No.13"; enhanced rates only for the first 10 days; at most 5 shows a day.                                                                                                                                                  | REPORTED | LiveLaw report of AP High Court, WP(PIL) 198 of 2024, 8 Dec 2024, https://www.livelaw.in/high-court/andhra-pradesh-high-court/andhra-pradesh-high-court-higher-premiere-rates-pushpa-2-mythri-movie-makers-277671 ; and WP(PIL) 7 of 2025, 14 Jan 2025, https://www.livelaw.in/high-court/andhra-pradesh-high-court/andhra-pradesh-high-court-movies-game-changer-and-daaku-maharaaj-ticket-price-hike-andhra-pradesh-government-280933 |
| R2  | The 2022 AP interim view on rate fixation: "For the present the prima facie opinion is that the Government cannot be the authority by itself to fix the rates and the charges." (Multiplex Association of India v. State of A.P., 21 April 2022, interim.) The rate-fixing power therefore **has been contested**; later 2024-25 orders still apply G.O.13. | REPORTED | Bar and Bench, https://www.barandbench.com/news/litigation/service-charge-online-booking-movie-tickets-ap-high-court-protection-multiplex ; Silver Screen, https://silverscreenindia.com/movies/news/ap-high-court-says-state-government-has-no-authority-to-fix-movie-ticket-prices/                                                                                                                                                   |
| R3  | Telangana G.O.Ms.No.120 (21.12.2021) "fixed the maximum rates of payment for admission to the different classes"; the High Court held the State bound by it and noted that "no challenge had been made" to it. Barla Mallesh Yadav v. State of Telangana, W.P.No.29214 of 2025, Justice N.V. Shravan Kumar, 25/26 Sept 2025.                                | REPORTED | LiveLaw, https://www.livelaw.in/amp/high-court/telangana-high-court/telangana-high-court-stays-order-enhanced-ticket-price-pawan-kalyan-they-call-him-og-movie-305122 and https://www.livelaw.in/amp/high-court/telangana-high-court/telangana-high-court-order-enhanced-ticket-price-pawan-kalyan-movie-305425                                                                                                                         |

### 1.3 The AP rate table: CORROBORATED, not verified

Source set: The News Minute, 7-8 Mar 2022 (https://www.thenewsminute.com/article/andhra-govt-fixes-new-movie-ticket-rates-all-you-need-know-161683);
Silver Screen India, 8 Mar 2022 (https://silverscreenindia.com/movies/news/ap-govt-revises-movie-ticket-prices-permits-5th-show-subject-to-conditions/);
Gulte, 7 Mar 2022 (https://www.gulte.com/movienews/158264/ap-ticket-prices-go-%e2%82%b920-%e2%82%b9250-benefit-shows-more).
None gives the GO number or quotes the annexure. The cell-level table below was assembled by a
web-search summariser from these three outlets; my direct page reads confirmed: TNM (Nagar/Gram
non-AC Rs 20 / Rs 40, Corporation multiplex Rs 150 / Rs 250, and the GST sentence), Gulte (the whole
non-premium column and the Rs 250 multiplex recliner in all three local bodies), Silver Screen
(ranges consistent with the table; 25% rule). **The premium column cells rest on the summariser plus
Silver Screen's ranges only.**

Rupees per ticket, ceilings (the order gives a maximum; no AP minimum was reported):

| Local body                  | Non-AC NP / P | AC or air-cooled NP / P | Special theatre NP / P | Multiplex regular / recliner |
| --------------------------- | ------------- | ----------------------- | ---------------------- | ---------------------------- |
| Municipal Corporation       | 40 / 60       | 70 / 100                | 100 / 125              | 150 / 250                    |
| Municipality                | 30 / 50       | 60 / 80                 | 80 / 100               | 125 / 250                    |
| Nagar Panchayat / Gram Pan. | 20 / 40       | 50 / 70                 | 70 / 90                | 100 / **250**                |

Comparison with `seed-india-cinema-policy.ts` (`AP_RATES`): **every seeded cell equals this table.
The one difference is the bold cell: the seed has no recliner row for Nagar / Gram Panchayat**
because "the brief gives ... no recliner rate". The press shows Rs 250 (Gulte: "the same Rs 250
reclining seat rate applies uniformly across all three local body categories"). See C1.

Other reported G.O.13 terms (CORROBORATED by TNM and the summariser): theatre classes non-AC,
AC/air-cooled, special, multiplex; **25% of seats non-premium** in AC, non-AC and special theatres;
special theatre = standalone with "Digital Surround System of 7.1 or more with 2K projection";
maintenance Rs 5 AC / Rs 3 non-AC; high-budget film rates only for 10 days; 5 shows a day.

## 2. Unverified assumptions

What the seed, the brief or earlier documents assert, that no primary source confirmed:

| #   | Assumption                                                                                                                    | Where asserted                                                           | State                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U1  | Each AP ceiling is the order's number                                                                                         | seed header ("transcribed from the product brief"); `textReviewed=false` | Matches press (1.3) but order unread. Premium cells single-source.                                                                                                                                                                                                                                                                                                                                                                         |
| U2  | Rates are **exclusive of GST**                                                                                                | seed `ticketPriceRule` text; document note                               | CORROBORATED for AP (TNM: "excluding GST"); Gulte says the order "mentioned the additional GST charges to be added to the ticket price". Order wording unread. Telangana G.O.77: REPORTED by Deccan Chronicle only (S8).                                                                                                                                                                                                                   |
| U3  | Rates are **inclusive of maintenance** (Rs 5 AC, Rs 3 non-AC)                                                                 | seed `INCLUDED_IN_TICKET_PRICE`                                          | CORROBORATED for AP (TNM, summariser). Telangana: conflicting (TELANGANA doc 2.4).                                                                                                                                                                                                                                                                                                                                                         |
| U4  | Rates are **inclusive of online booking service charges**                                                                     | seed document note                                                       | REPORTED (TNM). The AP High Court said in April 2022 that online booking service charge cannot, prima facie, be part of the "rate of admission", and in July 2022 called the question open (V1, R2). The seed's fee posture (0) is conservative either way.                                                                                                                                                                                |
| U5  | Commencement date                                                                                                             | seed `RECORDED_FROM = 2026-09-04`                                        | The seed says this is when the platform recorded it, not a commencement date. G.O.13 is dated 07.03.2022; its own commencement clause is unread.                                                                                                                                                                                                                                                                                           |
| U6  | **Vijayawada is a Municipal Corporation**                                                                                     | runbook, compliance report, QA cinema `localBodyType`                    | CARE Ratings, 14 Aug 2025: "VMC, being the sole municipal corporation of Vijayawada" (https://www.careratings.com/upload/CompanyFiles/PR/202508140809_Vijayawada_Municipal_Corporation.pdf, read by text extraction). Reputable but not a government source; the AP CDMA page returned 404. **The city is a corporation; whether a given cinema lies inside VMC limits is a separate, unchecked fact** (the QA pilot cinema is test data). |
| U7  | "Recliner" and "Regular" are the only multiplex classes; "Premium"/"Non-premium" apply to single screens and special theatres | seed; Vijayawada finding                                                 | Consistent with every press table. No definition of "recliner" or "premium" found anywhere. The order may define them.                                                                                                                                                                                                                                                                                                                     |
| U8  | Platinum Executive's class                                                                                                    | Vijayawada finding                                                       | Unclassifiable without the order and the physical seat. **Not classified here.**                                                                                                                                                                                                                                                                                                                                                           |
| U9  | G.O.Ms.No.13 is still in force and unamended                                                                                  | seed, runbook                                                            | 2024-25 High Court orders apply it (R1). No amendment found. A later AP order could exist that press search does not surface.                                                                                                                                                                                                                                                                                                              |
| U10 | The Telangana values in `TELANGANA-CINEMA-PRICING.md`                                                                         | that document                                                            | All REPORTED/CORROBORATED, none verified (section 3).                                                                                                                                                                                                                                                                                                                                                                                      |
| U11 | GST rates in `india-gst-rules.ts` (5% up to Rs 100, 18% above, effective 22 Sep 2025)                                         | repo                                                                     | **Not checked against a CBIC notification in this task.** Treat as UNVERIFIED here.                                                                                                                                                                                                                                                                                                                                                        |

## 3. Telangana: what was found

No Telangana order text was readable. All of the following are secondary.

| Item                                                                                                                            | Result                                                                                                                                                                                                                                                                                                                                      | Status       |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| G.O.77 issuer and date                                                                                                          | Press say Home (General), amends G.O.120; issue date 14-08-2026 (some outlets give 19-08-2026, the news date)                                                                                                                                                                                                                               | CORROBORATED |
| Rate table (Non-AC 30-70 / 50-100; AC 50-150 / 100-200; special 100-250 / 200-300; multiplex 100-250 regular, 200-300 recliner) | Deccan Chronicle, 19 Aug 2026 (fetched, table identical to TELANGANA doc 2.3); several others per that doc                                                                                                                                                                                                                                  | CORROBORATED |
| GST wording                                                                                                                     | Deccan Chronicle: "ticket prices are exclusive of GST but include maintenance charges of Rs 5 for AC theatres and Rs 3 for non-AC theatres. Online booking service charges will be levied separately." (https://www.deccanchronicle.com/southern-states/telangana/telangana-revises-cinema-ticket-rates-mandates-affordable-access-1980588) | REPORTED     |
| 25% non-premium, air-cooled two-year transition                                                                                 | Same article: "All theatres must reserve 25 per cent of total seating as non-premium"; "two-year transition period ... failing which they must charge as non-AC"                                                                                                                                                                            | CORROBORATED |
| G.O.120 exists and binds                                                                                                        | R3                                                                                                                                                                                                                                                                                                                                          | REPORTED     |
| Conflict that remains                                                                                                           | Deccan Chronicle says online charges are levied **separately** (outside the price) while maintenance is **inside**; AP's press wording puts online service charges **inside**. These are opposite postures in the two states and unconfirmed in both.                                                                                       | UNVERIFIED   |

Inference, not a finding: the High Court reporting mentions a G.O.120 multiplex maximum of Rs 295,
and Rs 250 x 1.18 = Rs 295. That would fit an exclusive Rs 250 ceiling shown with 18% GST added, but
the "Rs 295" came through a search summary and could not be found in the pages fetched. Do not rely on
it.

## 4. Configuration gaps

Each is a data or process gap, not a code bug. No change is applied here.

| #   | Gap                                                                                                                                                                                                                                                                                                                                                           | Proposed correction (NOT applied)                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | **No Nagar Panchayat / Gram Panchayat multiplex RECLINER row** (`seed-india-cinema-policy.ts` lines 270-275). The press shows Rs 250. Today a recliner at such a multiplex resolves to the climate-only fallback and sells **uncapped** (see D2). The seed's own comment calls the omission deliberate and the printed summary says "not given in the brief". | After the order text is read: add two DRAFT rows (`NAGAR_PANCHAYAT`, `GRAM_PANCHAYAT`; `MULTIPLEX`; climate null; `RECLINER`; 25000 minor), same maintenance/fee posture as sibling rows. Do not add from press alone for ACTIVE.          |
| C2  | **Seat-class vocabulary.** Platform enum is REGULAR / RECLINER / PREMIUM / NON_PREMIUM. No source defines "recliner", "premium" or "non-premium", or says whether a multiplex may sell a third class. The organizer UI offers all four for every cinema.                                                                                                      | Read the definitions in the order. If a multiplex has only Regular/Recliner, restrict the UI choices by cinema format and refuse the other two for a multiplex (needs engineering, see D2). Do not classify Platinum Executive until then. |
| C3  | **Missing PREMIUM / NON_PREMIUM rows for MULTIPLEX.** No AP row, in any status, names them for a multiplex, and press tables band multiplexes only by Regular/Recliner. Mapping a multiplex seat to PREMIUM/NON_PREMIUM sells it uncapped.                                                                                                                    | None required if the order has no such class. Make the engine refuse the mapping (D2) rather than adding rows.                                                                                                                             |
| C4  | **Local-body classification of Vijayawada.** The city is a municipal corporation (U6). The QA pilot cinema is test data. A real cinema must be classified by where it physically stands (VMC limits vs a neighbouring municipality or panchayat), which changes a regular multiplex ceiling from Rs 150 to Rs 125 or Rs 100.                                  | Per real cinema, record the local body with a document (property tax or trade licence address). Not a seed change.                                                                                                                         |
| C5  | **`effectiveFrom` of AP rows is 2026-09-04** (`RECORDED_FROM`), not the order's date. Booking snapshots copy the policy; a reader of one would take 2026-09-04 as the order's start.                                                                                                                                                                          | When the order is read, record its commencement as `effectiveFrom` through a supersede (not an edit), so history is kept.                                                                                                                  |
| C6  | **No `documentUrl`, `textReviewed=false`** on the AP document (and TG). This is correct today and must stay until a person has read the order.                                                                                                                                                                                                                | Add the URL and flip the flag only after S1-S3 are replaced by the order itself.                                                                                                                                                           |
| C7  | **Online service charge posture.** Seed note says the order's rate is "inclusive of service charges for online booking" (U4). The High Court called this open (V1) and enjoined the 2% rule (V2). Fee policy is `REQUIRES_APPROVAL` (fee 0), which is safe.                                                                                                   | Keep at 0. Counsel to confirm whether a third-party platform may charge any fee in AP and whether it sits inside or outside the ceiling.                                                                                                   |
| C8  | **Rules the model cannot express:** 25% non-premium seat share, 5 shows/day, 10-day higher-rate window, film-budget conditions (also TELANGANA doc G9).                                                                                                                                                                                                       | Product decision; out of scope for pricing rows.                                                                                                                                                                                           |
| C9  | **Telangana** rows stay metadata-only, DRAFT, `UNCONFIRMED`. Proposed rows already sit in TELANGANA doc section 3.                                                                                                                                                                                                                                            | No change.                                                                                                                                                                                                                                 |

## 5. Implementation defects

Code facts, VERIFIED at `6d9b4d1` by reading the repository. IDs follow `TELANGANA-CINEMA-PRICING.md`.

| #   | Defect                                                                                                                                                                                                                                                                                                                                                        | Where                                                                                                                                                                                                                 | State on main  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| D1  | **G3 GST basis.** `checkTicketPrice` compares the stored ticket price directly with `ticketPriceMaxMinor` / `ticketPriceMinMinor`. Ticket prices are stored GST-inclusive (tax rules for `TICKETS` are `inclusive: true`). The policy has no field saying which basis its limits use. Full analysis in section 7.                                             | `apps/api/src/pricing/cinema-policy/apply-policy.ts` `checkTicketPrice` (lines 158-185); `apps/api/prisma/seed-india-gst.ts` (`inclusive: rule.appliesTo === 'TICKETS'`, line ~97); `sale-eligibility.ts` line 242    | **Present**    |
| D2  | **G10 no-ceiling fallback.** The per-class loop resolves `{ seatCategories: [cls] }`. A class with no rate row falls to the climate-only fallback, whose `ticketPriceMaxMinor` is null, so `checkTicketPrice` returns ok. Activating the "NO_CEILING" blocker only covers rows that name a class. (This document does **not** enable or change the fallback.) | `sale-eligibility.ts` lines 238-256; `apply-policy.ts` 158-185; `seed-india-cinema-policy.ts` 384-433 (fallback rows); `admin/cinema-pricing-policies.service.ts` `NO_CEILING` (~line 219) applies only to class rows | **Present**    |
| D3  | **G4 booking time vs show time.** Policy chosen at booking time, so a ticket bought before an order's commencement or a conditional expiry for a later show uses the wrong row.                                                                                                                                                                               | `bookings.service.ts`, `event-sellability.service.ts`, `cinema-compliance.service.ts` (per TELANGANA doc)                                                                                                             | Not re-checked |
| D4  | **G8** a blocked per-class resolution passes `checkTicketPrice` as `ok: true` (it returns ok when `!policy`).                                                                                                                                                                                                                                                 | `apply-policy.ts` lines 163-165                                                                                                                                                                                       | **Present**    |
| D5  | **G2 seed re-run corruption of AP fallbacks: no longer present.** The block now sits in the Telangana loop (`seed-india-cinema-policy.ts` lines 459-474) and the AP fallback loop skips existing rows (line 413).                                                                                                                                             | seed                                                                                                                                                                                                                  | **Fixed**      |
| D6  | **G1 PATCH could activate a DRAFT: no longer present.** `editablePolicyFields` refuses any field outside an allowlist (status, version, supersedesId).                                                                                                                                                                                                        | `apps/api/src/admin/cinema-pricing-policies.service.ts` lines ~66-90                                                                                                                                                  | **Fixed**      |
| D7  | **Seed comment drift.** The seed header says Telangana has "no rate values" and that the AP order "has not been read". Both remain true, but the Telangana document row's `reference` is `G.O.77 dated 14-08-2026`, a press-derived label copied onto bookings; it should be renamed only after the order is read.                                            | seed line 38                                                                                                                                                                                                          | Documented     |

Not re-tested in this task: G5, G6, G7, G9, G11-G13 from the Telangana document.

## 6. Source log: every URL tried and its result

Retrieved 2026-10-11 unless noted. "Fetch" = WebFetch; "search" = WebSearch.

### 6.1 Government and court primary sources (none gave order text)

| URL                                                                                        | Result                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| https://goir.ap.gov.in                                                                     | `ECONNREFUSED 103.129.72.130:443` (fetch); also no response by curl                                                                                                                                                  |
| https://goir.ap.gov.in/Reports.aspx                                                        | `ECONNREFUSED 103.129.72.130:443`                                                                                                                                                                                    |
| https://www.ap.gov.in                                                                      | Fetch failed, no output                                                                                                                                                                                              |
| https://goir.telangana.gov.in and http://goir.telangana.gov.in/                            | `ECONNREFUSED 103.122.129.62:443` (twice)                                                                                                                                                                            |
| https://www.telangana.gov.in/government-orders/                                            | Loaded; lists three unrelated G.O.s and links to goir.telangana.gov.in. **No cinema order.**                                                                                                                         |
| https://www.telangana.gov.in/departments/cinematography/                                   | Loaded; describes TG Film Development Corporation and theatre NOCs. **No ticket-rate G.O. linked.**                                                                                                                  |
| https://tshc.gov.in                                                                        | **Now loads** (the earlier document found it unreachable). No G.O.77 or ticket judgment located on the home page.                                                                                                    |
| https://csis.tshc.gov.in/hcorders/2025/206300011842025_3.pdf                               | First `EAI_AGAIN`, then HTTP 404                                                                                                                                                                                     |
| https://www.indiacode.nic.in/bitstream/123456789/8609/1/act_4_of_1955.pdf                  | HTTP 403. **Section 7A / s.7 of the Cinemas (Regulation) Act remain unread.**                                                                                                                                        |
| https://cdma.ap.gov.in/en/node/545 (Vijayawada Municipal Corporation page)                 | HTTP 404                                                                                                                                                                                                             |
| https://fire.telangana.gov.in/WebSite/Downloads/go/GO177.PDF (AP Cinema Rules, search hit) | HTTP 403                                                                                                                                                                                                             |
| https://old.telugufilmchamber.in/docs/go/GO No.35, dt.8-4-21, A.P. - Admission Rates.pdf   | HTTP 522 (origin down) by fetch and curl. Wayback: no snapshot (404 / empty `archived_snapshots`). Index page https://www.telugufilmchamber.in/government-go lists GO 35 (2021) only; **no GO 13, GO 120 or GO 77.** |
| https://archive.org/wayback/available?url=goir.ap.gov.in                                   | `{"archived_snapshots": {}}`                                                                                                                                                                                         |
| Searches for indiankanoon / archive.org gazette copies of G.O.Ms.No.13 and G.O.77          | No hit for either order's text                                                                                                                                                                                       |

### 6.2 Court documents read

| URL                                                                                                                        | Result                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| S5 https://www.livelaw.in/pdf_upload/ap-hc-cinema-ticket-424166.pdf                                                        | **Read in full** via text extraction: AP High Court order of 01.07.2022 (section 1.1). Does not quote G.O.13. |
| https://www.livelaw.in/high-court/andhra-pradesh-high-court/... (277671, 280933)                                           | Read (reports of 2024-25 AP HC orders; R1)                                                                    |
| LiveLaw Telangana pieces 305122 and 305425                                                                                 | Read (R3). Neither gives rate figures or GST wording.                                                         |
| https://www.barandbench.com/news/litigation/service-charge-online-booking-movie-tickets-ap-high-court-protection-multiplex | Read (R2)                                                                                                     |
| https://theleaflet.in/analysis/is-andhra-pradeshs-new-law-on-cinemas-halls-constitutional                                  | Read; discusses 2021 GO 35 (8 Apr 2021) and the 1955 Act; does not quote G.O.13 or a rate-fixing section      |

### 6.3 Secondary sources

| URL                                                                                                                                | Result                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| https://www.thenewsminute.com/article/andhra-govt-fixes-new-movie-ticket-rates-all-you-need-know-161683                            | Read. Partial table, GST sentence, 25% rule. No GO number.                                                 |
| https://silverscreenindia.com/movies/news/ap-govt-revises-movie-ticket-prices-permits-5th-show-subject-to-conditions/              | Read. Ranges and 25% rule only; no GST sentence in the fetched text.                                       |
| https://www.gulte.com/movienews/158264/ap-ticket-prices-go-%e2%82%b920-%e2%82%b9250-benefit-shows-more                             | Read. Non-premium column, Rs 250 recliner in all three local bodies, "additional GST charges to be added". |
| https://silverscreenindia.com/movies/news/andhra-pradesh-restricts-ticket-prices-in-its-multiplexes-and-single-screen-theatres/    | Read; this is the April 2021 GO 35 article, not GO 13                                                      |
| https://www.deccanchronicle.com/southern-states/telangana/telangana-revises-cinema-ticket-rates-mandates-affordable-access-1980588 | Read (Telangana G.O.77, S8)                                                                                |
| https://www.careratings.com/upload/CompanyFiles/PR/202508140809_Vijayawada_Municipal_Corporation.pdf                               | Read by text extraction (U6)                                                                               |
| Search result pages for AP GO 13 tables (silverscreenindia, thenewsminute, gulte, ianslife, filminformation)                       | Used to locate the above; ianslife and filminformation not fetched                                         |

Source IDs used above: S5 = the AP High Court order; S8 = the Deccan Chronicle Telangana article.

## 7. GST basis: for the owner and counsel

### 7.1 What the orders say (as far as anyone could read)

- **AP G.O.13:** the press say the rates are "excluding GST, but inclusive of maintenance charges of
  Rs 5 for AC and Rs 3 for non-AC, and also inclusive of service charges for online booking" (TNM).
  Gulte: the order "mentioned the additional GST charges to be added to the ticket price." Every
  outlet that addresses GST says **the ceiling is before GST, with GST added on top.** Order wording:
  **UNREAD.**
- **Telangana G.O.77:** "exclusive of GST but include maintenance charges ..." (Deccan Chronicle).
  Telangana G.O.120 (2021) was reported by PVR and the press as "Rs 250 plus GST" and "Rs 300 plus
  GST". Both: **REPORTED, order unread.**
- Nobody could see whether the order says GST is added at the rate applicable to the **base** price or
  to the **inclusive** price, nor whether maintenance (inside the ceiling) is itself part of the
  value on which GST is charged.

### 7.2 What the code does

1. A ticket's stored price is GST-**inclusive**: tax rules for `TICKETS` are `inclusive: true`
   (`seed-india-gst.ts`, comment: "the number on the poster is what you pay, so the GST is extracted
   from it"). The rule itself is banded by that stored unit price: 5% up to Rs 100, 18% above
   (`india-gst-rules.ts`).
2. `checkTicketPrice` compares that stored inclusive price with `ticketPriceMaxMinor` unchanged.
   Nothing in the policy row says whether the limit is before or after tax. The row's
   `ticketPriceRule` text says "exclusive of GST", but no code reads it.
3. The same inclusive price is compared with `ticketPriceMinMinor` (Telangana rows would have one).

### 7.3 Worked consequences, if the ceilings are exclusive as reported

Assume the Corporation multiplex regular ceiling of Rs 150 (exclusive of GST) and 18% GST (price
above Rs 100):

| Quantity                                          | Value                                                       |
| ------------------------------------------------- | ----------------------------------------------------------- |
| Highest lawful base price                         | Rs 150.00                                                   |
| Highest lawful buyer price (base + 18% GST)       | Rs 177.00                                                   |
| Highest stored price the code accepts             | Rs 150.00 (inclusive)                                       |
| Equivalent base price the code effectively allows | Rs 150 / 1.18 = Rs 127.12                                   |
| Result                                            | Lawful prices from Rs 127.13 to Rs 150 base are **refused** |

So with exclusive ceilings the code **under-sells**: it fails closed, which cannot overcharge, but
refuses lawful prices on every class and misstates the ceiling shown to organizers. For a minimum
(Telangana), the inclusive price clears the floor too easily, so a below-floor base price can pass:
**over-permissive** for minimums.

If instead the ceiling were all-in (inclusive), the code would be right, and the press reports and the
seed text would be wrong. The code is correct for exactly one reading and the data says the other.

The recliner case has a second wrinkle. 18% GST applies above Rs 100 and 5% at or below; whether the
Rs 100 threshold is tested on the base or the inclusive amount is a GST-law question that decides
which rate row the engine picks near the boundary. **Not resolved here.**

### 7.4 Unresolved legal interpretation (owner / counsel to decide)

| #   | Question                                                                                                                                                          | Why it matters                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Q1  | Does each order's own text say the ceiling excludes GST? (Press: yes, for both states.)                                                                           | Decides which side of D1 is the defect                                                    |
| Q2  | If it excludes GST, may the quoted ticket price be GST-inclusive (a poster price of Rs 177) provided the base is within Rs 150?                                   | The platform shows one all-in price; the alternative is showing base plus GST separately  |
| Q3  | Is GST on admission levied on a value that includes the Rs 5 / Rs 3 maintenance (it sits inside the ceiling)?                                                     | `maintenanceTaxCategory` is null by design; the answer sets whether it becomes a tax rule |
| Q4  | Is the Rs 100 GST threshold tested on the base or inclusive amount?                                                                                               | Boundary pricing near Rs 100                                                              |
| Q5  | Does the ceiling bind the exhibitor's price only, with the platform's own service charge outside it? (AP HC left open; Telangana press says "levied separately".) | Whether a convenience fee can be charged at all (currently fixed at 0)                    |
| Q6  | Are the AP ceilings enforceable at all given the 2022 prima facie view that "the Government cannot be the authority by itself to fix the rates"?                  | Later 2024-25 orders apply G.O.13, so assume yes; counsel to confirm                      |

### 7.5 Proposed fix (NOT applied; needs its own PR and sign-off)

1. Add a basis field on the policy row, for example `ticketPriceBasis: EXCLUSIVE_OF_TAX | INCLUSIVE_OF_TAX`
   (forward-only migration; default `INCLUSIVE_OF_TAX` so existing behaviour is unchanged until the
   AP rows are re-stamped from the order).
2. In `checkTicketPrice`, when the basis is exclusive, compare the **tax-extracted base** from the tax
   engine, not the stored inclusive price. Show organizers both numbers.
3. Do not infer the basis from text. Set it from the order once read.
4. Pair with D2: refuse a known class with no rate row instead of falling to the no-ceiling fallback.

## 8. What is needed to reach VERIFIED

1. A certified copy of **G.O.Ms.No.13 (AP, Home (General-A), 07-03-2022)** with annexure, from the AP
   Home Department or from `goir.ap.gov.in` on an Indian network (the refusal looks like
   network filtering). Also any AP order after March 2022 on the same subject.
2. Certified copies of **G.O.Ms.No.77 (14-08-2026)** and **G.O.Ms.No.120 (21-12-2021)** and the gazette
   notification, from the Telangana Home (General) Department.
3. The two Telangana High Court judgments (W.P.No.29214 of 2025 and the 2026 "Paradise" petitions) from
   the court's case-status system, to settle whether the courts describe the ceilings as exclusive
   of GST.
4. Re-run sections 1, 2 and 4 against the text, change each label, set `documentUrl` and
   `textReviewed` only then.
5. A CBIC notification for the GST rates and the Rs 100 threshold (U11).

Co-sign list before any activation: legal (orders read), finance (GST basis, Q1-Q4), product
(25% rule, fee posture), and a second admin for the activation (no maker-checker in code).
