# India cinema pricing compliance — implementation report

**Date:** 2026-09-04 · **Branch:** `main` · **Deployed to QA:** `6ee5ef2`

---

## 1. What changed

The regulatory correction asked for one substantive thing: remove the Telangana engineering
guess, and make it impossible to make that kind of guess again. Both were done.

**`UNCONFIRMED` now exists as a maintenance treatment.** Previously the schema offered only
`INCLUDED_IN_TICKET_PRICE` and `ADDED_TO_TICKET_PRICE`, so a row carrying a known amount and an
unknown treatment could not be expressed — and `ADDED_TO_TICKET_PRICE` was written down instead.
A guess in a pricing table is indistinguishable from a researched value the moment its author
moves on. Three independent mechanisms now hold the line:

| Layer         | Guarantee                                                                                         |
| ------------- | ------------------------------------------------------------------------------------------------- |
| PostgreSQL    | A `CHECK` constraint refuses `status = 'ACTIVE'` on an `UNCONFIRMED` row.                         |
| Admin service | `activate()` refuses with a sentence naming the amount and the order, not a constraint violation. |
| Resolver      | Returns `POLICY_CONFIGURATION_ERROR` and prices nothing if such a row is ever reached.            |

**Regulatory references are a table, not a string per row.** `RegulatoryDocument` holds each
order once; forty-one rules cite it by ID. Retyping a citation per row guarantees that one day
forty say one thing and the forty-first says another, with no way to tell which is the typo.

**Provenance is recorded separately from citation.** Every document carries `textReviewed`.
Andhra Pradesh's is `false`: the rates were transcribed from the product brief that cites
G.O.Ms.No.13, **not from the order text**. That is a materially different epistemic state from
having read it, and a launch decision cannot see the difference if the only record is a citation
that looks equally authoritative either way.

---

## 2. Andhra Pradesh — the values encoded

**Reference:** `G.O.Ms.No.13, Home (General-A) Department, dated 07-03-2022`
**Rows:** 38 rate rows + 3 climate-only fallbacks. **Status:** all `DRAFT`.

### Municipal Corporation — the Vijayawada rollout slab

Vijayawada is a Municipal Corporation, so these are the numbers that govern the initial rollout.

| Format          | Climate         | Seat class   | Ceiling  |
| --------------- | --------------- | ------------ | -------- |
| Single screen   | Non-AC          | Non-premium  | ₹40      |
| Single screen   | Non-AC          | Premium      | ₹60      |
| Single screen   | AC / air-cooled | Non-premium  | ₹70      |
| Single screen   | AC / air-cooled | Premium      | ₹100     |
| Special theatre | —               | Non-premium  | ₹100     |
| Special theatre | —               | Premium      | ₹125     |
| **Multiplex**   | —               | **Regular**  | **₹150** |
| **Multiplex**   | —               | **Recliner** | **₹250** |

Municipality and Nagar/Gram Panchayat slabs are encoded on the same shape at lower ceilings
(₹30–₹250 and ₹20–₹100 respectively). The Panchayat slab has **no recliner row**, which is
recorded as an absence rather than filled in.

### Maintenance charge

₹5 per ticket air-conditioned, ₹3 non-air-conditioned, treatment `INCLUDED_IN_TICKET_PRICE` —
shown to the customer, does not increase what they pay. It is a third money component alongside
ticket and fee, and it is **not platform revenue**: four Postgres tests assert it never reaches a
payout, a commission base or a revenue report.

### Online booking fee — the most dangerous field in the system

`REQUIRES_APPROVAL`, `maxOnlineFeeMinor = null`.

The order states the permitted rate already includes online service charges. What ETicketsGo may
charge as a third-party platform is **unanswered**. Null in that column must never be read as
"unrestricted" — that reading applies the standard fee schedule on top of a regulated rate. The
ceiling function returns **0** for `REQUIRES_APPROVAL`, and 0 for a regulated jurisdiction with no
resolved policy; only `NOT_REGULATED` and `ALLOWED` return null. Falsified: making
`REQUIRES_APPROVAL` honour the cap field fails two tests.

### The fallback that keeps a regulated market sellable

Every rate row names a seat class. A cart whose class the platform cannot identify would match
none of them — and in a regulated market, no match means fail closed, i.e. a customer unable to
buy because their seat category is called "Gold". Three climate-only fallback rows carry the same
maintenance charge and **no ceiling**, so such an order still prices correctly and the organizer
is told the ceiling could not be matched.

---

## 3. Telangana — searched for, and deliberately empty

The repository was searched for G.O.77 before anything was written. **It is not present**, in any
form — no text, no rate table, no summary.

| Document                                                     | Status                                   | Values   |
| ------------------------------------------------------------ | ---------------------------------------- | -------- |
| `G.O.Ms.No.120, Home (General) Department, dated 21-12-2021` | Retained as history                      | None     |
| `G.O.77 dated 14-08-2026`                                    | Recorded as the current framework, DRAFT | **None** |

Both policy rows carry `maintenanceTreatment = UNCONFIRMED` and every monetary field null.
Nothing was taken from news reporting. `--activate` cannot activate them by any flag: the database
refuses the status.

---

## 4. Regulatory values still missing

1. **The G.O.Ms.No.13 order text.** Rates are transcribed from a brief. Until someone reads the
   order against the table, `textReviewed` stays `false`.
2. **Whether a third-party platform may charge a booking fee in Andhra Pradesh**, and if so how
   much. Until answered, ETicketsGo charges **zero** booking fee on AP cinema tickets.
3. **The complete Telangana G.O.77 dated 14-08-2026** — every rate, every classification, the
   maintenance charge and its treatment. This is the single blocker for Hyderabad, and it is a
   document-acquisition task, not an engineering one.
4. **Seat-class vocabulary.** The order's classes (`REGULAR`, `RECLINER`, `PREMIUM`,
   `NON_PREMIUM`) must be mapped to what organizers actually name their seat categories.

---

## 5. Organizer compliance UX — built

A panel on the cinema readiness page shows jurisdiction, classification, the cited order, the
maximum permitted price, the maintenance charge in plain words, the booking-fee posture, and
**each ticket price with its reason inline** next to the price it refers to.

It is **explanatory, never enforcement**. Every judgement it shows was made by the server, and the
server makes it again on its own at booking and publish time. If the panel were deleted, nothing
about what may be sold would change. The moment a compliance screen becomes the thing that
decides, a client that fails to render it becomes a client that can sell at any price.

Internal notes — "transcribed from a brief", "treatment unverified" — are **not** sent to it. They
are useful to whoever configures the platform and actively misleading to an exhibitor deciding
whether they may charge ₹150.

---

## 6. Admin policy UI — built, with a gap

`/admin/cinema-pricing` provides:

- **List** every policy with scope, status, version, effective dates, maintenance, fee posture and
  ceiling. A null ceiling renders as **"not recorded"**, in words, because a blank cell reads as
  "no limit" and that is a different and much more dangerous thing.
- **Inspect** — "what applies right now" for a given jurisdiction, reading the _same resolver
  checkout uses_, so it cannot disagree with what a customer would be charged.
- **Activate** a draft, **Disable** an active one.
- **No Edit button on an ACTIVE row.** History is superseded, never rewritten.

**Gap:** create-draft, edit-draft and supersede have **no UI**. All six endpoints exist and are
tested server-side; three of them can currently only be reached by API. Adding a new state's rates
today means calling the API or running a seed script.

---

## 7. Tests

**API: 2,356 tests / 244 suites. Web-kit: 240. Organizer-web: 143. Whole gate green** — 9 builds,
15 typechecks, 3 lints, 11 test tasks, format clean, 201 deploy-config checks.

| Suite                                                     | Tests |
| --------------------------------------------------------- | ----- |
| `cinema-pricing-policy.spec.ts` (resolver, pure)          | 25    |
| `cinema-policy.integration-postgres.spec.ts`              | 13    |
| `ap-rate-table.integration-postgres.spec.ts`              | 23    |
| `telangana-and-immutability.integration-postgres.spec.ts` | 10    |
| `maintenance-not-revenue.integration-postgres.spec.ts`    | 4     |
| `price-breakdown.spec.ts` (maintenance footing)           | +5    |
| `app-module-graph.integration-postgres.spec.ts`           | 1     |

Fixture amounts in the pure unit tests are deliberately unreal (₹7, ₹9) so a test can never be
mistaken for a source of law.

### Two defects found and fixed during this work

**The application could not boot, and 2,356 passing tests did not notice.**
`CinemaPricingPolicyService` was injected by two services and provided by no module. QA refused to
start. Every test either constructed the service directly or used a hand-built harness — which
proves the service _works_ and cannot ask whether Nest can _build_ it. There is now a test that
compiles the real module graph; it reproduces the exact production error when the export is
removed, and runs in 164 ms without opening a socket.

**One test suite corrupted another's state.** The AP rate suite flipped the real seeded rows to
`ACTIVE` and back. Jest runs suites in parallel against one database, so a suite asserting "the
seed ships DRAFT" saw 41 active rows and failed — a false alarm of exactly the kind that gets a
real assertion deleted for being flaky. It clones the rows into a test-only country now, copying
the values rather than restating them, so it still verifies the transcription.

---

## 8. Deployment state

All QA services run `6ee5ef2` — api, worker, customer-web, organizer-web, admin-web. The three
migrations applied cleanly, including the constraint that refuses `UNCONFIRMED` + `ACTIVE`.

**One manual step remains:** the policy rows come from a seed, not a migration, so QA has the
schema and no rows. QA's Postgres has no public proxy — correctly — so this cannot be run from a
developer machine, and I did not open one to work around it. From inside the Railway network:

```
npx tsx apps/api/prisma/seed-india-cinema-policy.ts        # writes 41 AP + 2 TG rows, all DRAFT
```

Nothing activates. Activating India is a deliberate act, and it has a consequence worth stating
plainly: **once any India policy is ACTIVE, every cinema in India must resolve one.** A cinema in
an unconfigured state, or one not classified by local body, format and climate, fails closed
rather than selling at an unregulated fee. Classify the cinemas first.

---

## 9. Launch verdicts

### India regulated-pricing architecture — **GO**

The mechanism is complete, tested and fails closed. Regulation is declared by data: a market is
regulated if and only if an ACTIVE policy names it, which is why this subsystem ships without
touching any non-cinema flow or any other country. Adding a state is configuration. No
`if (state === 'AP')` exists anywhere in the codebase.

### Andhra Pradesh / Vijayawada — **CONDITIONAL GO**

The rate table is encoded, the Municipal Corporation slab that governs Vijayawada is tested by
name, and bookings carry an immutable snapshot of the policy that priced them. Conditions:

1. Verify the rates against the G.O.Ms.No.13 text and set `textReviewed = true`.
2. Resolve the third-party booking-fee position. Until then the platform charges **₹0** in AP,
   which is safe and revenue-free.
3. Classify each cinema — local body, format, climate — before activating, or it fails closed.
4. Map organizer seat-category names to the order's seat classes.
5. Seed and activate on QA, then price a real booking end to end.

### Telangana / Hyderabad — **NO-GO**

Not a code gap. There are no rate values because no source exists in this repository, and
inventing them from reporting is precisely what this work removed. The next action is
non-engineering: **obtain the complete G.O.77 dated 14-08-2026.** Note that it is under active
challenge by exhibitor associations, so the operative text may still move — one more reason the
platform holds it as metadata with an unconfirmed treatment rather than a number.

Once the order is in hand, encoding it is configuration on the shape already proven by Andhra
Pradesh, plus a `textReviewed` pass. No schema change is expected.
