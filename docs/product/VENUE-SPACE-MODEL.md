# Venue, space, layout and seating - audit and first correction

Date: 2026-10-07
Branch: `feat/venue-space-model` - PR #239

Verdicts use five words and nothing softer: **PASS** (built and observed working),
**PARTIAL** (built, with a named limit), **NOT IMPLEMENTED** (not built), **NOT VERIFIED**
(built, but no evidence it works), **BLOCKED** (cannot proceed, with the blocker named).

---

## 1. The model as it actually is

The canonical model is VENUE -> SPACE -> LAYOUT -> EVENT CONFIGURATION -> INVENTORY. The
database holds **two parallel hierarchies**, and only one of them sells tickets.

```
Venue --> VenueArea                        the dead one
Venue? -> Cinema -> Screen -> SeatMap      the live one
      ^
      the "?" is the whole problem
```

### 1.1 `VenueArea` is dead

`VenueArea` has `id`, `venueId`, `name`, `capacity` and timestamps. Nothing else.

It has **zero references in the entire codebase** - no service, no controller, no UI, no
test. The only thing that touches it is `venues.service.ts`, which does
`include: { areas: true }` on three reads, so every venue response carries an `areas: []`
that is always empty and that nothing consumes. It is a table that was created and never
wired up.

### 1.2 `Cinema` is the real space, and it duplicates the venue

`Cinema` is what a space actually is on this platform: it owns `Screen`s, which own
`SeatMap`s, which own the sections, rows and seats that inventory is sold against.

It also carries its own copy of where it is:

| Column                                                     | Also on `Venue`               |
| ---------------------------------------------------------- | ----------------------------- |
| `city` (required)                                          | yes (required)                |
| `address`                                                  | yes                           |
| `country`                                                  | yes (defaults `India`)        |
| `region`                                                   | yes                           |
| `timezone` (defaults `Asia/Kolkata`)                       | yes (defaults `Asia/Kolkata`) |
| `latitude`, `longitude`                                    | no                            |
| `district`, `localBodyType`, `cinemaFormat`, `climateType` | no - genuinely cinema-only    |

And `venueId` is **optional**. So a space can exist with no venue at all, carrying its own
address, and nothing in the schema says which address wins.

**This is the root cause of "a space appears to be somewhere else".** It was not a display
bug. The two rows could genuinely disagree, and nothing arbitrated between them.

### 1.3 `SeatMap` is in much better shape than the rest

Worth stating plainly, because it changes what should be built next: `SeatMap` already has
versioning, lineage, `effectiveFrom`, `GRID | SECTIONED` geometry, focal shapes, and
`SeatCategory` / `SeatSection` / `SeatRow` / `Seat`. The layout layer of the canonical model
is the **strongest** part of this system, not the weakest. It does not need rebuilding.

---

## 2. What was wrong in the product, before this change

1. **Creating a space asked for the location, then asked which venue it was in.** In that
   order: City, Street address, Latitude, Longitude - and then "Which venue is this room
   in?". An organizer entered a place, then named the venue that already had one. Nothing
   reconciled the two.

2. **A venue could be created from three screens, each sending a different object.**

   | Screen                  | Sent                                                     |
   | ----------------------- | -------------------------------------------------------- |
   | `/organizer/venues`     | name, city, country, region, timezone, address, capacity |
   | `/organizer/events/new` | the same, **minus address**                              |
   | `/organizer/onboarding` | the same, **minus region and timezone**                  |

   A venue created mid-wizard had no street address and no way to add one from that screen.
   A venue created by onboarding silently took the default timezone, `Asia/Kolkata` - wrong
   for every organizer outside India, and a venue's timezone is what every showtime on its
   public listing is rendered in. None of this was visible: the organizer filled in "the
   venue form" and got a different venue depending on which door they used.

3. **Two words for one thing, on screen at the same time.** The sidebar said "rooms"; the
   page it opened said "spaces"; the create form's heading disagreed with its own breadcrumb.

---

## 3. What shipped - PR #239

### PASS - the venue decides the location

The venue is chosen **first**. Once chosen, its location is **shown** - venue name, address,
city, country, timezone, attributed as "inherited from the venue" - and not asked for again.
Choosing "create a new venue" still collects the location, because then nothing else knows
it.

Observed in a browser, signed in, at 1440 / 1920 / 390 / 412. No sideways scroll, no console
errors.

### PASS - one venue payload

`apps/organizer-web/components/venue-draft.ts` holds `VenueDraft`, `venuePayload()` and
`venueProblems()`. All three creation screens now build their body through it, so a venue is
the same object whichever door it comes through. Event creation gained the address field it
never had.

The module is deliberately JSX-free so the rules can be unit-tested without a renderer; the
component file re-exports it.

### PASS - one word for the thing

"Spaces" everywhere an organizer can see it. This **overrides a documented, evidence-based
decision**, so the reasoning is recorded in `layout.tsx` beside the label: the word was
"rooms" because that is what made seat maps findable after "Cinemas" drove a concert promoter
away. "Spaces" keeps what that rename was protecting - nothing film-specific in the sidebar -
and matches what the pages, the API and the seating model all call the thing. Film-specific
pages still say _cinema_ and _screen_, where those words are accurate.

### PASS - the contract is tested, and the tests were falsified

`apps/e2e/tests/organizer-space-inherits-venue.spec.ts` asserts that the venue is asked for
first, the location is inherited and shown, no second address box exists, a new venue still
collects its location, the vocabulary is consistent, and the API stores the space in the
venue it was created in.

Falsified by removing the inheritance and rebuilding: the ordering test fails, as it must.
The spec also earned its place by catching two surfaces this change had missed, which an
ad-hoc script with fixed waits had reported clean.

### How the rename was got wrong the first time, and what still does not guard it

The first sweep for leftover "room" copy was run through `grep ... | head -20`. Four files
never reached the output, and a clipped list read as an empty one. CI then failed on
`seated-event-wizard` asserting copy that no longer existed, which is the assertion doing its
job. Re-run untruncated, the sweep found six more user-visible surfaces: four in event
creation, three toasts and a hint in the sessions screen, the schedule conflict message, and
the shape picker's own question.

Worth recording because the same mistake is cheap to repeat: **a truncated grep is not a
sweep.** This is the second time in this piece of work that a convenience-truncated or
fixed-wait check reported clean while the defect was on the page.

The vocabulary assertion in the new spec only visits `/organizer/venues`,
`/organizer/cinemas` and `/organizer/cinemas/new`. The strings CI caught live behind a
multi-step wizard that the assertion never reaches, so **the guard covers three pages, not
the console.** It would not catch this class of regression again on its own.

---

## 4. What did NOT ship, and why

### NOT IMPLEMENTED - merging `Cinema`'s location into `Venue`

**The root cause in section 1.2 is still there.** `Cinema` still has its own `city`,
`address`, `country`, `region` and `timezone`; `venueId` is still optional; the API still
requires `city` on create and still defaults the timezone server-side.

This PR stops the **UI** from feeding the duplication - the city it sends is copied from the
chosen venue - but two rows can still disagree if anything else writes them.

Not attempted here because it is a schema migration touching the cinema booking path, the
regulatory pricing resolver (which reads `Cinema.region` / `district` / `localBodyType` with
the venue as fallback), the schedule day and week grids, and every showtime render. That is
its own PR with its own proof. Doing it inside a UX change is how cinema flows get broken.

### NOT IMPLEMENTED - deleting `VenueArea`

It is dead (section 1.1) and should go, but dropping a table is a migration and belongs with
the work in the section above.

### NOT IMPLEMENTED - `shows/copy`

Still has no UI. Unchanged by this PR; recorded here because it remains outstanding.

### NOT VERIFIED - one assertion is not yet proven load-bearing

Of the assertions in the new spec, the ones that matter most have been observed failing -
either against a deliberately broken build or against the real defect they describe. The "a
new venue still asks for the location" test has **not** been shown to fail, because the
falsification used made its branch always-on. It asserts something true today; it is not yet
proven it would catch a regression.

---

## 5. Defect found and deliberately not fixed

**The organizer header's workspace name overlaps the theme control on a phone.** At 390px the
org name sits on top of the light/dark pill.

It is **not** caused by this work. `packages/web-kit/src/shell.tsx` centres the name with
`absolute inset-x-0`, and a prior commit (`3716368`) added `pointer-events-none` so the
control underneath can still be pressed. The comment there records measurements at 320 / 412
/ 1440 and accepts the visual overlap as the cost of true header centring.

So it is a known, accepted trade-off in shared chrome used by three apps, and outside the
venue scope. Raised rather than changed: **the control works, it just looks broken.** Owner's
call whether the name should be hidden below `sm` instead.

---

## 6. Recommended order of work

1. **Merge `Cinema`'s location into `Venue`** (section 4.1). Make `venueId` required,
   backfill a venue for every cinema that lacks one, drop the duplicated columns, keep the
   genuinely cinema-only regulatory columns. This is the actual fix; everything in PR #239 is
   the UI being made honest ahead of it.
2. **Drop `VenueArea`** in the same migration.
3. Only then consider further seating work. `SeatMap` is the healthy part of this system and
   should not be touched to fix problems that live one level above it.
