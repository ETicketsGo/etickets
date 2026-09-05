# Vijayawada pilot readiness — report

**Date:** 2026-09-04 · **QA deployed:** `14dad96` (api, worker, customer-web, organizer-web, admin-web)

---

## 0. What went wrong first, because it matters more than the rest

**I emptied the QA database.**

To seed the policy rows I set the `db-seed` service's start command through the Railway API,
deployed, and restored it afterwards. The API accepted the change and read it back correctly.
The deployment ran the **old** command anyway, because `deploy/railway/db-seed.railway.json` is
config-as-code and silently overrides anything set through the API.

The old command was the destructive seed. QA lost its events, bookings, tickets, payments,
receipts, tax rules, payment provider configuration and organizations. It was reduced to zero
events.

**The seed could not put it back either.** Its reset died partway with a foreign-key violation
on `AccountInvitation`, _after_ thirty-eight deletions had already committed. It deleted in a
hand-maintained order that had rotted: seventeen models held foreign keys into rows it deleted
and were missing from the list.

Both are fixed — the reset now truncates every table the database reports, in one CASCADE, so
the ordering question cannot be answered wrongly again; and `db-seed` runs a dispatcher whose
default is a **read-only census**, with the destructive path requiring a second variable that
says what it does. But **QA demo data is still empty**: restoring it means running the
destructive seed, and that action is blocked in this environment. It needs a human to run
`SEED_OPERATION=full-reset SEED_ALLOW_DESTRUCTIVE=yes`.

That blockage is the reason sections 2, 5 and 6 below are incomplete.

---

## 1. QA regulatory data — done

```
AP DRAFT:   41
AP ACTIVE:   0
TG DRAFT:    2
TG ACTIVE:   0
ACTIVE TOTAL: 0
```

Read back through `SEED_OPERATION=status` inside the Railway private network. Postgres was
**not** exposed publicly at any point; there is no public proxy on the QA database and I did
not create one.

All three regulatory documents report `[UNREVIEWED]`.

### A correction to the previous report

The last report said Telangana held no monetary value. **It did.** Both Telangana rows carried
₹5 maintenance, copied from the constant this codebase uses for **Andhra Pradesh's**
G.O.Ms.No.13 — an Andhra Pradesh figure standing in for a Telangana one, including on the row
for G.O.77, an order that is not in this repository at all.

Found by an assertion written to check something else entirely. Both rows now record zero,
which is the _absence_ of a figure rather than a claim that the state charges nothing; the
`UNCONFIRMED` treatment beside it says which. The database constraint that made zero unstorable
was amended, because it forced a choice between inventing an amount and declaring the
jurisdiction has no charge.

---

## 2. Pilot cinema — NOT DONE

No pilot cinema exists in QA, because QA has no organizations, venues or cinemas to attach one
to. Blocked on the restore in section 0.

The classification the cinema will need is built and enforced: country, region, city,
`localBodyType = MUNICIPAL_CORPORATION`, `cinemaFormat`, `climateType`, and a regulatory class
on every sellable seat category. Missing any of them fails closed with a message naming what to
fix.

---

## 3. Seat-class mapping — done, and it was broken in two ways

**Display names were being used as regulatory classes.** Matching was a case-insensitive string
comparison against the seat category's _name_. A category called "Recliner" got the recliner
ceiling; the identical seat called "Lounger" matched nothing and sold uncapped.

`SeatCategory.regulatoryClass` now records the operator's explicit answer — `REGULAR`,
`RECLINER`, `PREMIUM`, `NON_PREMIUM`. Nullable, no default, no backfill. Unmapped in a
regulated jurisdiction is **refused by name**, never inferred: a category literally called
"Recliner" with no mapping is still unmapped, and a test says so.

Organizer UI at cinema → readiness lists **every** category, not only the unmapped ones — a
missing mapping refuses loudly at checkout, a _wrong_ one sells legally at the wrong ceiling and
nothing ever complains.

---

## 4. Pricing proofs — done, against the real booking code path

`vijayawada-pilot.integration-postgres.spec.ts` — 14 tests, real Postgres, driving
`BookingsService.admissionLinesFor` and `resolveCinemaPolicy`, i.e. the functions a real
booking calls.

| Proof                          | Result                                             |
| ------------------------------ | -------------------------------------------------- |
| ₹150 regular                   | sells                                              |
| ₹151 regular                   | refused, naming the seat category and G.O.Ms.No.13 |
| ₹250 recliner                  | sells                                              |
| ₹251 recliner                  | refused                                            |
| regular + recliner in one cart | **sells**, and still catches an over-ceiling line  |
| unmapped "Platinum Executive"  | refused, naming the category                       |
| maintenance, 2 × ₹150          | ₹10 disclosed, **₹0 added** — subtotal stays ₹300  |
| booking fee                    | ceiling **₹0** under `REQUIRES_APPROVAL`           |

### The ceilings had been enforced on nothing

`admissionLinesFor` handed the policy engine the _event's_ category — the literal string
`"MOVIE"` — as the cart's seat class. No rate row names a class called "MOVIE", so every real
booking fell past the class-specific rows onto the class-agnostic fallback, which carries a
maintenance charge and **no maximum price**. ₹150 and ₹250 appeared on the compliance screen and
governed nothing anyone could buy. There was also no ceiling check in the booking path at all.

### And a legal sale was being refused

A cart with one regular seat and one recliner matched both rows, equally specific, so the
resolver reported "2 equally specific policies match" and the booking was **blocked**. Buying
one of each is an ordinary purchase. One class in a cart now resolves to its own row; several
resolve at jurisdiction level, with per-line ceilings still applied class by class.

Both falsified: reverting the seat class fails 7 of 14 tests; removing the unmapped refusal
fails 2.

---

## 5. End-to-end payment proof — NOT DONE

Quote → booking → Razorpay order → reconciliation → confirmation → settlement → refund has
**not** been run. It needs a pilot cinema in QA, which needs the restore in section 0.

Nothing about the money path was changed by this work, but that is an argument for expecting it
to pass, not evidence that it does.

---

## 6. Accounting — proven at unit level, not end-to-end

`maintenance-not-revenue.integration-postgres.spec.ts` (4 Postgres tests) asserts the
maintenance charge never reaches a payout, a commission base or a revenue report. The booking
snapshot preserves the amount.

Not verified on a real booking, for the same reason as section 5.

**Not decided by anyone:** who the maintenance money ultimately belongs to. That is a
legal/accounting question and nothing in the code assumes an answer.

---

## 7. Activation gate — done

`activationPreflight` returns **every** blocker at once rather than one per attempt, and is its
own endpoint so the list is visible before the button is pressed:

`NOT_DRAFT` · `NO_REFERENCE` · `MAINTENANCE_UNCONFIRMED` · `NO_CEILING` · `AMBIGUOUS` ·
`TEXT_NOT_REVIEWED`

`textReviewed = false` is a **warning** outside production and a **hard block** in production,
with no override parameter — an override existing only here would be an informal bypass
invented for whoever is blocked. Accepted warnings are written into the audit entry.

Two intended checks turned out unreachable: the database already refuses those rows outright.
The tests assert the stronger guarantee instead.

---

## 8. CI and test isolation — done

**247 suites / 2,388 tests.** Whole gate green: 9 builds, 15 typechecks, 3 lints, 11 test tasks,
format clean, 201 deploy-config checks, schema drift clean.

**Module bootstrap gate:** kept and promoted to its own CI step, so a failure reads as "the
application cannot start" rather than one line in a long log. CI also now runs
`db:seed:india-cinema`, without which every cinema suite would fail on an empty policy table.

**Seed isolation, proven order-independent:** forward in band 82 pass · reversed in band 78 pass
· default parallel run twice, 200 and 200. No suite mutates the canonical seeded rows; the ones
that need ACTIVE policies clone them into their own country, copying the values so they still
verify the real transcription.

---

## 9. Runbook — done

`docs/compliance/india-cinema-vijayawada-launch.md`. Operational steps only, plus rollback by
disable/supersede. It states plainly that both preserve the record while deletion destroys the
evidence that a price was lawful when charged, and it never suggests deleting financial or
regulatory history.

---

## 10. Missing non-code inputs

1. **The G.O.Ms.No.13 order text**, from an official source, archived. Until someone reads all
   41 rows against it, `textReviewed` stays false and production activation is refused.
2. **Whether ETicketsGo may charge a third-party booking fee in Andhra Pradesh**, and how much.
   Until answered the platform charges ₹0.
3. **The complete Telangana G.O.77 dated 14-08-2026**, from the Telangana Gazette or another
   official source.
4. **Legal/finance approval** to charge the regulated rates.
5. **The pilot cinema itself** — which theatre, its local body, format, climate and its real
   seat category names.
6. **Who maintenance money belongs to**, for settlement.

---

## Verdicts

| Scope                     | Verdict            |
| ------------------------- | ------------------ |
| **Architecture**          | **GO**             |
| **Vijayawada QA pilot**   | **CONDITIONAL GO** |
| **Vijayawada production** | **NO-GO**          |
| **Hyderabad**             | **NO-GO**          |

**Architecture — GO.** The rules are enforced where money is taken, not only where compliance is
displayed. Two defects that made the ceilings decorative are fixed and falsified.

**Vijayawada QA pilot — CONDITIONAL GO.** The pricing behaviour is proven against the real
booking code path, and QA carries the policies as DRAFT. Conditional on one thing only:
restoring QA demo data, then creating and classifying a pilot cinema and running the payment
end-to-end. That is blocked on an operation I could not perform.

**Vijayawada production — NO-GO.** Not because the platform misbehaves, but because no one has
read the order, the booking-fee question is unanswered, and no approval is recorded. The
production activation gate enforces the first of those by itself.

**Hyderabad — NO-GO.** Unchanged, and correctly so. No rate values exist because no source
exists. The next action remains obtaining G.O.77.
