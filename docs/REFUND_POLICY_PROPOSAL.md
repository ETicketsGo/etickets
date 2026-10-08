# Proposed refund & cancellation policy

**Not published.** This is a proposal built strictly from what the platform already enforces,
for review before anything reaches `/refunds`.

Audited from source at `feat/buyer-front-door` (baseline `main = 9b73984`). Nothing below was
invented: every rule in Part 1 is implemented and testable today, and every open question in
Part 2 is open because the code does not answer it.

---

## PART 1 — SYSTEM ALREADY SUPPORTS

These are enforced in code. A policy that said otherwise would be a promise the platform
would break.

### 1.1 Who decides the window — the organizer, per event

`Event.refundsEnabled` (default **true**) and `Event.refundCutoffHours` (default **48**).

The cut-off was once a platform constant of 48 hours for everybody. The schema comment records
why it moved: a fixed constant meant _"showing buyers a refund button the organizer never
agreed to honour"_, and granting a request the organizer would have refused still moves the
money — so the platform was underwriting a promise it had no standing to make.

**Consequence for the policy:** ETicketsGo cannot state a single refund window. It can state
that every event shows its own, which the event page already does.

### 1.2 When a refund is possible

`checkRefundEligibility` — a pure function, four rules:

| Rule              | Behaviour                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| Booking status    | Only `CONFIRMED` or `PARTIALLY_REFUNDED`                                                        |
| Organizer opt-out | `refundsEnabled: false` → _"This organizer does not offer refunds for this event."_             |
| Window            | Refunds close `refundCutoffHours` before session start (default 48; `0` means up to start time) |
| After the window  | Refused                                                                                         |

### 1.3 What amount comes back — tickets and their tax, **not fees**

The refunded amount is `ticketsMinor + tax.addedMinor`. **Booking and payment fees are not
included.**

This matters because `/refunds` currently tells buyers _"We have not decided whether fees are
refundable."_ **The code has decided: they are not returned.** The business has not ratified
that decision, which is a different thing and is why it appears in Part 2.

Tax goes back the way it was charged — per line, inclusive or added. Treating every line as
added once refunded Indian GST twice and then refused the refund for exceeding the balance.

### 1.4 Partial refunds — supported, per ticket

Refunds target individual tickets (`PARTIALLY_REFUNDED` is a real booking state). Only
`ACTIVE` or `CHECKED_IN` tickets are refundable. Cumulative refunds can never exceed
`booking.totalMinor`, and concurrent requests are serialised by a per-booking advisory lock.

### 1.5 Used tickets

A ticket already scanned at the gate is `CHECKED_IN`. It remains technically refundable by an
operator, but the window rule will normally have closed first.

### 1.6 Who approves

| Actor                                     | Can                                                     |
| ----------------------------------------- | ------------------------------------------------------- |
| Buyer                                     | **Request** a refund from their booking or tickets page |
| `ORGANIZER_OWNER`, `ADMIN`, `SUPER_ADMIN` | **Approve or reject**                                   |
| Admin refund review                       | Additionally gated by the `REFUND_REVIEW` permission    |

Status moves `REQUESTED → PROCESSING → COMPLETED | REJECTED`, and every step is audited.

**No refund is automatic.** `BOOKING_REFUND_POLICY_MODE` defaults to `MANUAL_ONLY`, and the
money-moving automation is off and production-forbidden.

### 1.7 Cash bookings

A booking paid in cash has no `Payment` row. An approved refund with no provider named has
nowhere to go, so this path is handled separately rather than being sent to a gateway.

### 1.8 Free events

No payment, no refund path. Cancellation still works; there is nothing to return.

### 1.9 Cinema and movie bookings

**No separate rule.** Shows read `session.event.refundsEnabled` and the same cut-off. A
cinema's policy is the event's policy.

### 1.10 Provider behaviour

Razorpay refunds reach us as `refund.processed` (which moves the ledger) and `refund.failed`
(which marks ours FAILED for manual follow-up). `refund.created` deliberately moves nothing —
it means accepted, not paid, and counting it once double-counted every refund.

### 1.11 Disputes and chargebacks

`payment.dispute.created/won/lost` are processed and synced. Handled as the provider requires,
then matched against our own records.

---

## PART 2 — BUSINESS DECISION REQUIRED

Six questions. The code cannot answer any of them, and `/refunds` should not be published
until it can state an answer to the first three.

### D1 — Are fees refundable? **(blocking)**

The system returns ticket value and its tax, and keeps the booking and payment fees. That is a
defensible position — the service was rendered — and it is also what every buyer will ask
about first.

Decide one of: fees are never returned; fees are returned when the **organizer** cancels but
not when the buyer does; fees are always returned.

Note the asymmetry if you keep fees on an organizer cancellation: the buyer loses money for a
decision that was not theirs.

### D2 — What happens when an organizer cancels an event? **(blocking)**

**Today: nothing automatic.** `cancelShow` expires unpaid bookings and returns a
`bookingsRequiringRefund` list. Paid buyers are refunded only if a human acts on that list.

A buyer whose event is cancelled and who hears nothing is the single worst experience this
platform can currently produce, and it is reachable today.

Decide: does an organizer cancellation entitle the buyer to a **full** refund including fees,
within what time, and is it initiated by us or by the organizer? Note that automatic refunding
is engineering work that does not exist yet.

### D3 — What counts as a material change? **(blocking)**

The platform supports rescheduling and venue changes. Nothing currently entitles a buyer to a
refund because the time or venue moved.

Decide what a buyer is entitled to when a show is moved rather than cancelled.

### D4 — Is there a cooling-off period?

Nothing in the code implements one. Some jurisdictions require it; India's consumer rules on
distance selling may apply. **Needs legal input, not a product decision.**

### D5 — Who bears the gateway fee on a refund?

Razorpay frequently does not return its fee on a refund. Today the platform absorbs it
silently. Decide whether that is the intent at volume.

### D6 — Minimum organizer standard?

An organizer can set `refundsEnabled: false` and offer no refunds at all. Decide whether
ETicketsGo permits that, or imposes a floor (for example, refunds must be offered up to N
hours before).

---

## Proposed buyer-facing copy, once D1–D3 are answered

Offered as a shape, not as final wording. Every sentence below is already true except the
bracketed parts, which await the decisions.

> **Refunds and cancellations**
>
> **Each event sets its own refund window.** Before you buy, the event page tells you whether
> refunds are offered and until when. Most close 48 hours before the start.
>
> **Asking for a refund.** Request it from your booking or your tickets. We check it against
> the event's policy and pass it to the organizer. You will see it move from Requested to
> Completed or Rejected, and we record every step.
>
> **What comes back.** The ticket price and any tax charged on it. [Booking and payment fees
> are / are not returned — D1.]
>
> **Part of a booking.** You can return some tickets and keep the rest.
>
> **If the organizer cancels.** [D2.]
>
> **If the event moves.** [D3.]
>
> **Once you have been scanned in**, the ticket has been used and is no longer refundable.
>
> **Free events** have nothing to refund; just cancel.
>
> **Card disputes** are handled as your bank and our payment provider require.

---

## Recommendation

D1 and D2 are the two that block publication, and D2 is also the one with a product gap behind
it: deciding that an organizer cancellation entitles buyers to an automatic refund would create
engineering work that does not exist today. Deciding it is organizer-initiated costs nothing and
is honest, but needs the policy to say so plainly.

Until then `/refunds` should keep its draft notice. It is currently the most honest page on the
site, and it is also the page a cautious buyer reads last before deciding not to pay.
