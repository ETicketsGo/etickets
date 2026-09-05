# Vijayawada cinema launch — runbook

Operational steps for switching on regulated cinema pricing for one Vijayawada cinema.

This is a checklist, not an explanation. The reasoning lives in
`INDIA-CINEMA-PRICING-COMPLIANCE-REPORT.md`.

> **Vijayawada is a Municipal Corporation.** That selects the slab: multiplex **₹150 regular**,
> **₹250 recliner**. A cinema classified as anything else gets different ceilings.

---

## Before anything is switched on

| #   | Step                                                                                                                 | Who                | Done when                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| 1   | Obtain **G.O.Ms.No.13, Home (General-A) Department, dated 07-03-2022** from an official source and archive the file. | Legal / compliance | The order is stored where an auditor can be shown it.               |
| 2   | Check every seeded Andhra Pradesh rate against that text, line by line.                                              | Legal / compliance | Each of the 41 rows has been read against the order.                |
| 3   | Set `textReviewed = true` on the regulatory document.                                                                | Admin              | `db:policy-status` prints `[reviewed]` for the AP order.            |
| 4   | Record legal/finance approval to charge the regulated rates.                                                         | Finance            | Approval is written down somewhere durable, with a date and a name. |
| 5   | Resolve whether ETicketsGo may charge a third-party booking fee in AP, and how much.                                 | AP advisor         | A written answer exists. Until then the platform charges **₹0**.    |

**Do not proceed past here on the strength of a QA pass.** QA proves the platform behaves; it
proves nothing about whether the numbers are the state's.

---

## Preparing the cinema

| #   | Step                                                                                                     | Where                                              |
| --- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 6   | Classify the cinema: country, state, city, **local body = Municipal Corporation**, format, climate type. | Organizer console → cinema settings                |
| 7   | Map every sellable seat category to a regulatory class (Regular / Recliner / Premium / Non-premium).     | Organizer console → cinema → readiness             |
| 8   | Confirm ticket prices are at or below the ceiling for each class.                                        | Organizer console → readiness → Regulatory pricing |

An unclassified cinema, or one with an unmapped seat category, **fails closed**: it stops
selling rather than selling at an unregulated price. That is the intended behaviour, and it is
why steps 6 and 7 come before activation.

---

## Proving it in QA

| #   | Step                                                                       | Passes when                                                                                             |
| --- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 9   | Seed the policies: `SEED_OPERATION=india-cinema` on the `db-seed` service. | `db:policy-status` shows 41 AP + 2 TG rows, **0 ACTIVE**.                                               |
| 10  | Quote and book a ₹150 regular ticket.                                      | It sells. Quoted total = booking snapshot total.                                                        |
| 11  | Price a regular ticket at ₹151 and attempt a booking.                      | Refused, naming the seat category and G.O.Ms.No.13.                                                     |
| 12  | Repeat at ₹250 and ₹251 for a recliner.                                    | ₹250 sells; ₹251 refused.                                                                               |
| 13  | Check the maintenance charge on a two-ticket order.                        | ₹10 disclosed; the ticket subtotal is still ₹300, not ₹310.                                             |
| 14  | Check the booking fee on the same order.                                   | **₹0.** The standard convenience fee is not added.                                                      |
| 15  | Complete a Razorpay test payment.                                          | Quote = snapshot = Razorpay order amount = captured amount.                                             |
| 16  | Refund it.                                                                 | The refund uses the booking's own stored components, not a re-derived price.                            |
| 17  | Check settlement/accounting.                                               | Maintenance is present and is not platform fee revenue, and does not reduce the organizer's settlement. |

---

## Activating

| #   | Step                                                                | Notes                                                                                         |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 18  | Run the activation preflight on each policy you intend to activate. | Admin console → Cinema pricing. It lists every blocker at once.                               |
| 19  | Activate **only** the policies this cinema resolves against.        | Municipal Corporation + multiplex + the classes this cinema sells, plus the climate fallback. |
| 20  | Smoke-test a production quote for the pilot cinema.                 | ₹150 quotes at ₹150 with ₹0 booking fee.                                                      |
| 21  | Enable the cinema for customer sales.                               |                                                                                               |

**Do not activate all 41 rows because they exist.** Activating a policy makes every cinema in
its scope resolve against it, and any cinema in that scope which is not classified stops
selling. Activate the slab the pilot needs and leave the rest DRAFT.

Production activation is **refused** while `textReviewed` is false. There is no override
parameter — step 3 is the way through, and that is deliberate.

---

## Telangana

Leave every Telangana policy **DRAFT**. Nothing monetary is recorded for Telangana and nothing
should be: `G.O.77 dated 14-08-2026` is not in this repository, and the rows carry no amount,
no ceiling and an unconfirmed maintenance treatment. The database refuses to activate them.

`G.O.Ms.No.120 dated 21-12-2021` is retained as history and is **not** current authority. Do
not price anything from it, and do not reconstruct G.O.77 from press coverage — capture it from
the Telangana Gazette or another official government source.

---

## Rollback

If a rate turns out to be wrong, or the pilot has to stop:

1. **Disable** the policy (admin console), or **supersede** it with a corrected version.
2. Cinemas in its scope then **fail closed** — they stop selling rather than falling back to
   unregulated pricing. Confirm that is what you are choosing before you do it.
3. To stop one cinema only, disable that cinema for sales instead of touching the policy.

Bookings already taken are unaffected: each one carries its own immutable snapshot of the
policy that priced it, so disabling a policy never changes a total that has already been paid.

**Never delete a policy row, a regulatory document, a booking, a receipt or a refund.** Superseding
and disabling both preserve the record; deletion destroys the evidence that a price was lawful
at the time it was charged, which is the thing you would most need if it were ever questioned.

---

## Commands

Run from the `db-seed` service inside the Railway private network — never against a database
reachable from a laptop.

```
SEED_OPERATION=status         # read-only census: rows per region per status, and textReviewed
SEED_OPERATION=india-cinema   # write AP + TG policies, all DRAFT, idempotent
```

Or, with a project token for the target environment:

```
node scripts/deploy/run-seed-operation.mjs status
node scripts/deploy/run-seed-operation.mjs india-cinema
```

`SEED_OPERATION=full-reset` empties every table and additionally requires
`SEED_ALLOW_DESTRUCTIVE=yes`. It is for rebuilding a QA environment from nothing. It has no
place in this runbook and must never be pointed at production.
