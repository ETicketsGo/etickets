# ADR-044: Session Seating is a Setting, Until the First Commitment

- **Status:** Accepted
- **Date:** 2026-08-30
- **Deciders:** Principal Architect
- **Builds on:** ADR-037 (inventory provider seam), and the seated-events change (PR #77) that
  moved seat-based-ness from `Event.experienceType` onto `EventSession.screenId`
- **Scope:** when a session's room may change, and what happens to its ticket types when it does

## Context

PR #77 established that whether a ticket names a seat is a property of the **room**, not of the
kind of event. A session either points at a room with a published seat map, or it does not.

That change made the room choosable **only at session creation**. The reasoning was that
re-seating a session with sold tickets would move seats people had already paid for — which is
true, and remains true. But the rule was applied to _every_ session, including the
overwhelming majority that have sold nothing at all.

The consequence showed up the first time somebody tested it: an organizer created an event,
realised it should have assigned seating, and found no way to say so. The only route was to
delete the session and rebuild it. For a draft nobody has bought from, that is friction with
no safety argument behind it — and it makes seating feel like a decision that must be got
right in advance, which is not how anyone plans an event.

## Decision

**Seating is an ordinary setting until the first commitment, and immutable afterwards.**

`PATCH /events/sessions/:id/seating` accepts `{ screenId: string | null }` and:

1. refuses if the session has any non-cancelled, non-expired **booking**;
2. refuses if any of its ticket types has **`quantitySold > 0` or `quantityHeld > 0`**;
3. otherwise deletes the session's `ShowSeat` rows and ticket types, repoints `screenId` and
   `seatMapId`, and re-seats from the room's layout — all in one transaction.

`null` is a meaningful value, not an absent one: it means "make this general admission again".
The validation schema uses `.nullable()` rather than `.optional()` so the two intentions stay
distinguishable.

### Why "held" counts as a commitment

A hold is somebody standing at a checkout **right now**. They have chosen seats and are
entering payment details. Re-seating underneath them would take the seat they are in the
middle of buying, and the booking would fail at the last step for a reason they could never
diagnose. "Nothing sold yet" is exactly the reading that would permit this, so the check is on
sold **and** held, and the test falsifies the held half specifically.

### Why ticket types are replaced rather than merged

A seated session derives one ticket type per seat category, priced from the category. A
general-admission session carries whatever the organizer typed. Keeping both across a change
would leave two competing prices on the same night, and the room's would silently win at the
point of sale — a pricing bug that surfaces as a customer being charged the wrong amount.

Because nothing may be sold or held when the change is allowed, a ticket type at that moment
is draft configuration rather than a commitment. It is still the organizer's work, so the UI
states the count **before** the change ("this session's 2 ticket types will be replaced"),
rather than letting them discover the loss afterwards.

### Why validation runs before the transaction opens

Not for atomicity — the transaction gives that, and a test asserts a refused change leaves the
session byte-for-byte as it was. It is for **which check speaks first**. Both the room check
and the cinema scheduler's own layout lookup reject an unmapped room, but the scheduler says
_"generate one before scheduling shows"_: the wrong vocabulary for somebody adding seats to a
concert, and silent about the layout needing to be PUBLISHED. Running the room check first is
what makes the refusal actionable. It also keeps a multi-query read outside an open
transaction.

## Consequences

- An organizer can add, change or remove assigned seating on any session they have not yet
  sold. This is the common case and it is now unremarkable.
- After the first sale or hold the room is fixed, and the refusal names the number — "already
  has 1 booking", "2 currently held". A refusal without a reason is indistinguishable from a
  broken button, and that is how people stop trusting a console.
- The rule is enforced **server-side**. The UI offers the control unconditionally and surfaces
  the server's message, because a UI that merely hides a button is still one crafted request
  away from moving seats somebody paid for.
- `addSession` and `updateSessionSeating` share one room-validation implementation. A room
  acceptable at creation must stay acceptable at change; two copies of that rule would drift,
  and this codebase has already paid for a duplicated seating rule once — the fix for selling
  aisle positions as seats had to be applied at two sites, and the second was found by
  accident.

## What this does not do

Re-seating a session that has sold tickets. That is a refund question — who is moved, who is
told, who is compensated — and it belongs with the compensation model in ADR-043 rather than
in a settings endpoint. Quietly allowing it would be worse than not offering it.

## Discoverability, recorded here because it is part of the same decision

A correct API that nobody can find is not a shipped feature. Two changes accompany this:

- The only route to a seat map was a navigation item called **"Cinemas"**. A concert promoter
  reads that, correctly concludes it is not for them, and never finds the prerequisite. It is
  now **"Rooms & seat maps"**, and its empty state says what a room unlocks instead of telling
  a non-cinema organizer to "start scheduling screenings". The rows really are `Cinema` records
  and the film-specific pages inside still say cinema and screen, where those words are true.
- The onboarding checklist gained a **seating step, marked optional and not counted** toward
  completion. Listed because it is otherwise undiscoverable; optional because a promoter
  selling standing tickets genuinely never needs it, and a checklist that cannot be finished
  stops being a checklist and becomes a permanent nag.
