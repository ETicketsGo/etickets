# Pilot readiness

Whether a cinema can open, and precisely what is stopping it.

`GET /cinemas/:id/pilot-readiness` → `READY | WARNING | BLOCKED`
UI: `/organizer/cinemas/[id]/readiness`

---

## One source of truth

The rules live in `apps/api/src/cinemas/pilot-readiness.ts` as pure functions. The organizer
page **renders** the verdict and contains no rules of its own.

That separation is the whole design. A second implementation in the client is how a screen ends
up saying READY while the API refuses to activate, leaving an operator with two answers and no
way to tell which is lying.

Every check carries:

| Field     | Purpose                                                       |
| --------- | ------------------------------------------------------------- |
| `section` | Which part of setup it belongs to                             |
| `code`    | **Stable identifier** — the UI keys off this, never the prose |
| `level`   | `READY` / `WARNING` / `BLOCKED`                               |
| `message` | One sentence an operator can act on, written by the server    |
| `fixPath` | Where to go to fix it                                         |

A blocker with no `fixPath` is a test failure. "Something is wrong" with no route is a support
ticket.

## Sections

Business · Cinema · Screens · Seat layouts · Staff · Pricing · Fees · Policies · Payments ·
Shows · Customer experience · Operations

Sections render **blocking first**. A checklist that lists twelve green sections above the one
red one is a checklist nobody reads to the bottom of.

## What blocks

Organization not active · no screen in service · an in-service screen with no published layout
(named individually, not counted) · nobody able to operate the cinema · no priced seat category
· no INR payment route · no resolvable payment credentials · nothing scheduled · nothing
publicly discoverable · cinema not active.

## What only warns

No support email · no street address · **a single operator** · **no fee rule** · no cancellation
policy · some unpriced categories.

### Two pilot policy decisions, made deliberately

**A lone operator warns rather than blocks.** A pilot night with one person has no second pair
of hands — if they are unavailable nobody can pause sales or release a seat — but it is not an
invalid configuration. This is a business call and is a one-line change to flip to BLOCKED.

**No fee rule warns rather than blocks.** Selling with no convenience fee is a valid commercial
choice for a pilot; it is just more often an oversight. The message says so rather than
accusing.

**Warnings never block.** A checklist that refuses to let anyone proceed over an optional field
is one people learn to route around, and then it stops being read at all.

## Discoverable means more than scheduled

The CUSTOMER check requires a **published film** with a future show at this cinema. Shows can
exist against a draft film, in which case the organizer schedule looks healthy and the public
listing is empty — a failure invisible from the organizer side.

## Re-checking

Not polled. Readiness changes when somebody edits configuration, not on a clock. The page
refetches on window focus — exactly when an operator returns from fixing something — and on
demand via **Re-check**. `staleTime: 0`, so nobody reads a cached verdict from before their own
edit.

The verdict card is a `role="status"` live region, so the result of a re-check is announced
rather than only painted. Status is carried by a word and a glyph, never colour alone.

## Payments

Readiness reports only **whether** credentials resolve in this environment. No key, secret or
webhook secret is read or returned. Production credentials are not required for QA readiness.

## Activation

**Not implemented.** There is no cinema activation workflow beyond the existing `status` field,
and this mission did not invent one. The readiness engine is the input such a workflow would
need; wiring it is separate work.

## Known gaps

- **No activation workflow** (above).
- **No self-service UI** for fees, cancellation policy or payment routing. The onboarding shell
  states this per step rather than linking nowhere.
- **Pricing has no dedicated editor.** Prices are set per seat category when a layout is
  generated; the step links to the screen as the closest honest destination.
- **GST/tax is not represented.** See below.

> ### Tax readiness: incomplete, and not implied anywhere
>
> `Booking` has **no tax field**. Money is modelled as `subtotalMinor`, `bookingFeeMinor`,
> `paymentFeeMinor`, `discountMinor`, `customerFeeMinor`, `organizerFeeMinor` and `totalMinor` —
> all integer minor units, but with **no separate ticket tax and no tax on the convenience fee**.
>
> This is a schema gap, not a configuration gap. No GST percentage has been invented anywhere in
> this codebase, and the readiness engine deliberately does **not** report a tax check —
> reporting READY for tax would imply a capability that does not exist.
>
> Representing ticket tax, fee tax and their breakdown needs a finance/legal decision on what
> must be shown and remitted. That decision is an owner's, not engineering's.
