# Theater onboarding

Guided setup for a new cinema: `/organizer/cinemas/[id]/onboarding`

---

## A shell, not a second product

Every step links to the screen where the work is actually done — the cinema form, the seat
layout designer, the scheduling workspace, live operations. Rebuilding any of those inside a
wizard would create a second place to keep correct, and the two would drift.

The shell contributes **orchestration and state**, nothing else.

## Progress is derived, never stored

There is no onboarding-progress table and no wizard checkbox. Each step's state comes from the
live readiness verdict for its section.

A stored "complete" flag can disagree with reality — a screen taken out of service, a layout
archived, a show cancelled — and a wizard reporting complete over a cinema that cannot sell a
ticket is worse than no wizard at all.

The cost is honest and intended: **a step can go backwards.** If somebody archives the last
published layout, Seat layouts returns to Blocked. That is the system telling the truth.

Leaving and returning always shows current state, because there is no state to go stale.

## Steps

| #   | Step             | Where the work happens                 |
| --- | ---------------- | -------------------------------------- |
| 1   | Business         | `/organizer/settings`                  |
| 2   | Cinema           | Cinema edit page                       |
| 3   | Screens          | Cinema page                            |
| 4   | Seat layouts     | Layout versions page                   |
| 5   | Staff            | `/organizer/team`                      |
| 6   | Pricing          | Schedule → a show's **Pricing** action |
| 7   | Fees             | **No self-service screen**             |
| 8   | Policies         | **No self-service screen**             |
| 9   | Payments         | **No self-service screen**             |
| 10  | Shows            | Scheduling workspace                   |
| 11  | Live operations  | Live ops                               |
| 12  | Launch readiness | Readiness page                         |

Steps with no destination **say so and say who owns it** rather than linking nowhere. An
operator told "configure fees" with no way to do it is worse off than one told the screen does
not exist and that ETicketsGo configures it.

## Timezone during onboarding

The cinema form shows and edits the persisted IANA zone. New India cinemas default to
`Asia/Kolkata` as a convenience.

**Once a cinema has any scheduled show, the timezone is locked.** Show times are stored as
absolute instants; re-pointing the zone does not move them, it changes what they are advertised
as. The API refuses with `TIMEZONE_LOCKED_BY_SHOWS`, names how many shows are in the way, and
the form surfaces that message. Correcting a trading cinema's zone is a data migration, not a
form save.

An empty cinema can be corrected freely — the case that matters during onboarding.

## Pricing belongs to the show

Set per showing, not per room. Two showings of the same film on the same screen can be priced
differently, and changing a price never touches the seat layout — the layout's own prices are
only the default a newly scheduled show inherits.

A category that has **sold** is fixed for that show; held seats lock nothing, because the
buyer's line was snapshotted when they held it. See
[PRICING-AUDIT.md](./PRICING-AUDIT.md).

## A cinema brings its own venue

`Venue` is an internal join between the movie and events domains, and there is no endpoint to
create one. A cinema now creates its own at creation time. Before that, a brand-new
organization completed every visible step and then could not schedule its first show:
`No venue is available for this organization.`

## Not built

- Organization profile fields beyond what exists. `Organization` has name, slug, status,
  contact email/phone and public profile fields only — **no GSTIN, registered address, finance
  or settlement contact**.
- Fee, policy and payment configuration screens.
- Cinema activation workflow.
- Admin pilot command centre.
- QA pilot seed and full rehearsal.

See [PILOT-READINESS.md](./PILOT-READINESS.md) for the readiness contract and the tax gap.
