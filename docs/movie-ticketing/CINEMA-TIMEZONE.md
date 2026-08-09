# Cinema timezone

Every local date and time the platform computes for a venue comes from `Cinema.timezone`.

---

## The rule

**The cinema record is the authority.** Not the deployment region, not the browser, not a
launch-market default.

This is not a theoretical concern. A hardcoded `Asia/Kolkata` produced two real defects on the
scheduling workspace before this change — the day view queried one zone while the rows
rendered in another, and the week view bucketed a 00:30 Hyderabad show under the previous day
for anyone west of India. Both were invisible while every cinema was in one country.

## Where it is read

| Path                                            | Uses                               |
| ----------------------------------------------- | ---------------------------------- |
| `scheduleShow`, `bulkScheduleShows`             | the screen's cinema                |
| `copySchedule`                                  | the **source** cinema              |
| `cinemaSchedule` (day + week)                   | the cinema                         |
| Live operations, live seat map, override report | the cinema                         |
| Public showtimes                                | the cinema, exposed as `localDate` |
| Organizer schedule / live ops / reports pages   | `cinema.timezone` from the API     |

An explicit `timezone` query parameter is still honoured — that is how somebody asks "what
does this day look like in UTC" — but nothing defaults to a literal any more.

## Storage and the default

`Cinema.timezone` is `NOT NULL DEFAULT 'Asia/Kolkata'`.

The default exists for exactly two reasons, and **is not a runtime fallback**:

1. It backfilled every pre-existing India cinema in place, with no table rewrite and no
   separate data migration.
2. It lets an older API instance that does not yet write the column keep inserting cinemas
   during a rolling deploy.

Application code reads the column. It never substitutes a literal when the column is present.

### The fallback rule for legacy or unmigrated data

There is currently **no runtime fallback, and none is needed** — the migration guarantees
every row has a value, and the column is NOT NULL so none can be written without one.

If a future path ever produces a cinema without a resolvable zone, the rule is:

> **Fail loudly, do not guess.** A missing zone must surface as an error naming the cinema,
> never as a silently substituted default. A wrong local date looks like data and gets acted
> on; an error gets fixed. The organizer pages already hold a loading state rather than
> rendering a guessed day, which is the same principle at the UI layer.

## Validation

`ianaTimeZoneSchema` asks `Intl` whether the runtime can actually resolve the name, rather
than checking a hardcoded list that would rot as the IANA database changes.

**Fixed offsets are refused** — `UTC+5:30`, `UTC-8`. They look equivalent to a zone and are
not: an offset cannot follow daylight saving, so a venue stored that way is silently an hour
out for part of the year in any market that observes it.

An unresolvable zone rejected at the edge is a bad form field. Stored, it is an exception
thrown on every read of that cinema's schedule.

## Creating a cinema

`timezone` is optional on create and defaults to `Asia/Kolkata`, so an Indian operator is not
made to choose from six hundred names. It is editable on the cinema form, with the IANA format
stated in the field hint. Once stored it is authoritative.

## What is proven, and how

| Claim                                                       | Evidence                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------- |
| A 10:00 Sydney show is stored as 00:00Z                     | Integration test, real PostgreSQL                                    |
| Two cinemas resolve the same wall clock 4h30m apart         | Sydney + Hyderabad in one test                                       |
| A 10:00 show stays 10:00 across Sydney's October DST change | Two dates either side; a stored offset gets exactly one right        |
| The day schedule groups on the venue's date, not UTC        | 08:00 Sydney = 22:00Z the previous day                               |
| The browser's zone cannot change what is displayed          | Playwright with `Europe/London`, `America/Boise`, `Australia/Sydney` |
| A non-India cinema is not treated as India                  | Sydney fixture asserts the instant is **not** 00:30 Kolkata          |
| Unresolvable zones are refused                              | API returns 4xx for `Middle/Earth` and `UTC+5:30`                    |

> **Why a non-India fixture matters.** Against an `Asia/Kolkata` venue, "reads the cinema's
> zone" and "hardcodes the launch market" produce identical output — no India-only test can
> tell them apart. The Sydney fixture caught a real bug on its first run: `CinemasService.create`
> enumerates its fields and was silently dropping `timezone`, so a Sydney cinema was being
> stored as Asia/Kolkata by the column default.

## Known gaps

- **`Venue` has no timezone.** Non-cinema events still group by the viewer's zone. Only
  cinemas are covered.
- **No timezone picker.** The field is free text validated against IANA; a searchable list
  would be kinder.
- **Existing shows are not re-pointed if a cinema's zone is edited.** Their instants were
  resolved when scheduled and remain correct as instants, but the advertised wall-clock time
  will shift. Changing a live cinema's zone is not yet an operationally safe action and should
  be treated as a data migration.
