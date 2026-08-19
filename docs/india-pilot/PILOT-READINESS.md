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

A blocker must be **actionable**, which is not always a link: some are ETicketsGo's to fix,
and those name their owner instead. A blocker that is neither is a test failure.

Two rounds of rehearsal produced three dead ends here — `/admin/fees` (a 404), `/admin/payments`
(an app operators cannot open), and `/organizer/settings` for organization approval (a page
that edits the public profile and cannot change status). The guard test forbids any path
outside `/organizer/`; it cannot detect the third kind, where the route exists and the
capability does not.

## Sections

Business · Cinema · Screens · Seat layouts · Staff · Pricing · Fees · Policies · Payments ·
Shows · Customer experience · Operations

Sections render **blocking first**. A checklist that lists twelve green sections above the one
red one is a checklist nobody reads to the bottom of.

## What blocks

Organization not APPROVED · no screen in service · an in-service screen with no published layout
(named individually, not counted) · nobody able to operate the cinema · no priced seat category
· no INR payment route · no resolvable payment credentials · nothing scheduled · nothing
publicly discoverable · cinema not active.

## What only warns

No support email · no street address · **a single operator** · **no fee rule** · no cancellation
policy · some unpriced seat categories.

### Pricing checks the show, not the room

`SeatCategory.basePriceMinor` is the TEMPLATE a new show is created from; `TicketType.priceMinor`
is what a customer pays. Reading only the template reported a cinema satisfied while tomorrow's
show sold for nothing — observed live. A future show priced at zero now BLOCKS; an unpriced
template only warns, because it misprices shows that do not exist yet.

### APPROVED, not ACTIVE

`OrganizationStatus` is PENDING | APPROVED | REJECTED | SUSPENDED. The rule used to compare
against `'ACTIVE'`, a value the column cannot hold, so **every** organization was blocked and no
cinema could ever reach READY — with a unit fixture that said `'ACTIVE'` too, so the tests
agreed with the code and both were wrong. The facts type is now the real union, which makes
that mistake a compile error.

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

Readiness asks **what this environment can actually charge with** — not whether some variable
is set.

The old check was `RAZORPAY_KEY_ID || PAYMENTS_MOCK_MODE === 'true'`, and
`PAYMENTS_MOCK_MODE` **was not a variable this system has**: absent from the config schema,
every `.env`, CI and every deploy manifest. Its only effect anywhere was to turn this check
green. Meanwhile `PAYMENT_PROVIDER` is declared in the schema and read by no runtime code, so
a local box could take a mock payment while readiness insisted no payment was possible.

It now reads the payment module's own model — `APP_ENV` → `PaymentEnvName`, plus
`isDummyAllowed` / `isLiveAllowed` — rather than a second policy that could disagree with it.

**The simulated gateway is never READY, in any environment.** It confirms every booking it is
asked to, which is exactly what makes it useless as evidence. It warns where the payment
module already permits it (LOCAL/DEV/QA) and blocks everywhere a pilot could run.

Presence and declared mode only. No key, secret or webhook secret is read or returned, and
the facts structure has no field that could hold one. Full matrix:
[RAZORPAY-SANDBOX.md](./RAZORPAY-SANDBOX.md).

## Activation

**Not implemented.** There is no cinema activation workflow beyond the existing `status` field,
and this mission did not invent one. The readiness engine is the input such a workflow would
need; wiring it is separate work.

## Known gaps

- **No activation workflow** (above).
- **No self-service UI** for fees, cancellation policy or payment routing. The onboarding shell
  states this per step rather than linking nowhere.
- ~~Pricing has no dedicated editor.~~ **Built.** Prices belong to the SHOW, not the layout —
  proven live — and every future show now has a **Pricing** action in the schedule day view.
  See [PRICING-AUDIT.md](./PRICING-AUDIT.md).
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
