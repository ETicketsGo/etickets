# QA pilot gap register

Observed gaps from walking the Launch Readiness page as an operator would.

> ## Scope warning — this rehearsal is PARTIAL
>
> The **static walk** completed: every readiness fix path was followed to see whether the
> destination exists and whether the operator who sees it can reach it. That produced the
> defects below, two of which are fixed in this change.
>
> The **live walk did NOT complete.** Docker Desktop crashed mid-session and the QA Postgres
> container would not stay running, so the booking journey, seat map, checkout, live occupancy
> and the readiness→fix→recheck loop against real data were **not exercised in this pass**.
>
> Rows below are marked **OBSERVED** or **NOT YET OBSERVED** accordingly. Nothing is recorded
> here that was merely reasoned about — the point of the exercise was evidence, and a register
> padded with inference would defeat it.

---

## Fixed during the rehearsal

### GAP-01 — Fees fix path was a dead link · **PRODUCT_DEFECT** · P1 · OBSERVED

**Observed:** the FEES check emitted `fixPath: '/admin/fees'`. That route **does not exist** in
the admin app (`apps/admin-web/app/admin/` has `payments`, `payment-config`, `payouts` — no
`fees`). The readiness page rendered a _Fix this_ button leading to a 404.

**Expected:** either a working destination, or no button and a statement of who owns it.

|                            |                                                        |
| -------------------------- | ------------------------------------------------------ |
| Backend capability exists? | Yes — `FeeRule` model                                  |
| UI exists?                 | **No**, in either app                                  |
| Blocks pilot?              | No — fee absence is a WARNING                          |
| Fixed                      | `fixPath: null`, message now names ETicketsGo as owner |

### GAP-02 — Payment fix paths pointed into an app operators cannot open · **PRODUCT_DEFECT** · P1 · OBSERVED

**Observed:** `NO_INR_ROUTE` and `PROVIDER_NOT_CONFIGURED` emitted `fixPath: '/admin/payments'`.
That route exists, but `/admin/*` is a **separate application** a theater operator has no
account for. Both are **BLOCKING** checks, so the operator was handed a blocker whose only
offered remedy was a door they cannot open.

**Expected:** a blocker the theater cannot fix should say so and name the owner.

|                            |                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------- |
| Backend capability exists? | Yes — `PaymentRoute`, provider config                                            |
| UI exists?                 | Admin-only; **not organizer-reachable**                                          |
| Blocks pilot?              | **Yes** — but the fix is ETicketsGo's, not the theater's                         |
| Fixed                      | `fixPath: null`, messages now say "ETicketsGo configures this — contact support" |

**A test now prevents the class, not just the instances:** no check may emit a `fixPath`
outside `/organizer/`, and any non-READY check without a path must name its owner. That third
assertion also corrected a pre-existing test which had demanded a `fixPath` on _every_ blocker
— the demand that produced these links in the first place.

---

## Confirmed self-service gaps (backend exists, no operator UI)

All **OBSERVED** by route inventory: `apps/organizer-web/app/organizer/` contains no `fees`,
`payments` or `policies` route, and no pricing editor.

| ID     | Section  | Classification        | Sev    | Backend                          | UI                      | Blocks pilot?    |
| ------ | -------- | --------------------- | ------ | -------------------------------- | ----------------------- | ---------------- |
| GAP-03 | Fees     | SELF_SERVICE_GAP      | P2     | `FeeRule` ✅                     | ❌                      | No (WARNING)     |
| GAP-04 | Policies | SELF_SERVICE_GAP      | P2     | `Event.refundPolicy` ✅          | ❌                      | No (WARNING)     |
| GAP-05 | Payments | EXTERNAL_OWNER_ACTION | **P0** | `PaymentRoute` ✅                | ❌ organizer            | **Yes**          |
| GAP-06 | Pricing  | SELF_SERVICE_GAP      | **P1** | `SeatCategory.basePriceMinor` ✅ | Only at layout creation | **Yes** if wrong |

**GAP-06 detail.** Prices are set per seat category _when a layout is generated_ and there is
no editor afterwards. Because published layouts are immutable, **changing a ticket price
appears to require cloning and publishing a new layout version** — a heavy operation for a
routine commercial change. This is the most surprising finding of the static walk and needs
confirming against the live product before it is acted on.

---

## Business profile gap

### GAP-07 — Organization has no GSTIN, registered address or finance contact · SELF_SERVICE_GAP + BUSINESS_DECISION · P1 · OBSERVED

`Organization` carries `name`, `slug`, `status`, `contactEmail`, `contactPhone` and public
profile fields only. There is no GSTIN, no registered/operational address, no finance or
settlement contact.

Readiness only checks `status` and `contactEmail`, so it reports BUSINESS as satisfiable — and
it is, _for what readiness asks_. Whether an Indian theater pilot can operate without these
recorded is a business/finance question, not an engineering one.

---

## Tax

### GAP-08 — `Booking` has no tax representation · LEGAL_FINANCE_DECISION + SCHEMA_GAP · P1 · OBSERVED

Booking money fields: `subtotalMinor`, `bookingFeeMinor`, `paymentFeeMinor`, `discountMinor`,
`customerFeeMinor`, `organizerFeeMinor`, `totalMinor` — all integer minor units.

**There is no ticket tax field and no tax on the convenience fee.** (`Payment.taxMinor` exists,
but that is the payment record, not the booking breakdown a customer is shown.)

Tax would need to appear in the booking money split and in the checkout payload. **No GST
percentage has been invented anywhere in this codebase**, and readiness deliberately reports no
tax check — a READY there would imply a capability that does not exist.

Requires a finance/legal decision on what must be displayed and remitted.

---

## Activation finding

### GAP-09 — Activation may be redundant · BUSINESS_DECISION · P3 · OBSERVED (source)

What currently makes a cinema customer-visible is the **conjunction already enforced by
readiness**: `Cinema.status = ACTIVE`, an in-service screen with a published layout, and a
future session on a `PUBLISHED` event with a `PUBLISHED` movie. `getPublicSeatLayout` and the
public catalogue read exactly those.

`Cinema.status` is already editable and readiness already blocks on it.

**Recommendation: do not build a separate activation lifecycle.** It would duplicate
`Cinema.status` and add a second thing that can disagree with visibility. If an explicit
moment is wanted, the cheapest honest version is an _Activate_ button on the readiness page
that sets `status = ACTIVE` and refuses while `overall === 'BLOCKED'` — one action over
existing state, not a new model.

---

## NOT YET OBSERVED — requires the live environment

These could not be exercised because the QA database was unavailable. They are listed so the
next session knows exactly what remains, and are **deliberately unclassified**.

- Business: can `/organizer/settings` actually edit `contactEmail`?
- Cinema: are state and PIN capturable? (No schema fields observed — likely a gap.)
- Cinema: does the timezone-lock refusal surface legibly in the form?
- Screens / layouts: full create → publish → readiness-clears loop in the browser
- Staff: does `/organizer/team` support invite, role assignment, deactivation?
- Pricing: does a configured price reach the customer seat map?
- Shows: schedule → readiness clears
- Customer journey: discovery → showtime → seat map → server price
- Operations: occupancy, seat override, audit
- The readiness → fix → re-check transition against real data

---

## Priority summary

| Priority | Count | Items                                                                            |
| -------- | ----- | -------------------------------------------------------------------------------- |
| **P0**   | 1     | GAP-05 payment routing (external owner)                                          |
| **P1**   | 4     | GAP-01, GAP-02 (both fixed), GAP-06 pricing, GAP-07 business profile, GAP-08 tax |
| **P2**   | 2     | GAP-03 fees UI, GAP-04 policies UI                                               |
| **P3**   | 1     | GAP-09 activation                                                                |

**The evidence does not point at fees or policies first.** Both are WARNINGs an operator can
launch past. The two things that actually stop a pilot are payment routing (external) and — if
confirmed live — that changing a ticket price may require republishing a seat layout.
