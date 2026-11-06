# Node 24 timezone regression (2026-11-06)

Owner decision item 8: test Node 24's timezone behaviour, in particular America/Vancouver,
DST boundaries, stored UTC timestamps, checkout, confirmation emails and tickets.

## Method

`scripts/deploy/tz-compare.mjs` extracts the REAL conversion and formatting code
from `origin/main`, without retyping it, and bundles it with esbuild:

- `zonedWallClockToInstant` / `instantToZonedWallClock` (API, `shows.service.ts`: cinema
  scheduler, show copy);
- `wallClockToInstant` / `instantToWallClock` (organizer console, `lib/zoned-time.ts`: event
  wizard and sessions form, also used for the ticket face);
- `formatShowTime` (SMS templates) and the confirmation-email clock (`Intl` with the same options
  and `zoneAbbrev`).

The bundle ran unchanged in `node:20.20.2-alpine` (production today, tzdata **2025c**) and
`node:24.22.2-alpine` (#586, tzdata **2026e**). It covered six zones (America/Vancouver,
America/Los_Angeles, America/Toronto, America/New_York, Asia/Kolkata, Europe/London) and 15
wall-clock times around every 2026-2027 transition (North American and European), plus four
stored UTC instants. Re-run it before any Node upgrade: it exits 1 if any row differs.

## Results (114 rows)

|                                                                      | Rows | Differ between Node 20 and 24 |
| -------------------------------------------------------------------- | ---- | ----------------------------- |
| Los Angeles, Toronto, New York, Kolkata, London (all DST boundaries) | 95   | **0**                         |
| America/Vancouver before 2026-11-01                                  | 10   | **0**                         |
| America/Vancouver from 2026-11-01                                    | 9    | **9**                         |

**The only change is British Columbia's rule in tzdata 2026e.** BC keeps UTC-7 all year from
November 2026, so it does not fall back on 2026-11-01. Node 20 (2025c) still has BC on UTC-8
in winter.

| Stored UTC (created as 19:00 under Node 20) | Node 20 shows                                       | Node 24 shows                                                   |
| ------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| 2026-11-07T03:00Z                           | ticket 19:00, email "7:00 p.m. PST", SMS "07:00 PM" | ticket **20:00**, email "**8:00 p.m. PDT**", SMS "**08:00 PM**" |
| 2026-12-21T03:00Z                           | 19:00 PST                                           | **20:00 PDT**                                                   |
| 2027-01-16T03:00Z                           | 19:00 PST                                           | **20:00 PDT**                                                   |

And in the other direction: a Vancouver organizer typing 19:00 on 2026-11-06 is stored as
`03:00Z` on Node 20 and as `02:00Z` on Node 24.

**What does not change:**

- stored timestamps (UTC in Postgres, never rewritten);
- every comparison between instants, which is all that checkout, sales-close, hold expiry and
  check-in windows use;
- every other zone.

## What this means

1. **Production is wrong now for any BC show after 2026-11-01**, if 2026e is right. It
   carries tzdata 2025c, so a 19:00 show typed today is stored as 03:00Z, and that is 20:00 in
   Vancouver under the new rule. The organizer's browser may already carry the new rule (Chrome
   updates its ICU data), so the console and the server can disagree today.
2. **Upgrading to Node 24 moves every already-stored BC show after 2026-11-01 by one hour on
   tickets, emails and SMS**, unless those rows are corrected. The instant stays put; only its
   meaning in the zone changes.
3. The short name shown is `PDT` all winter (that is what ICU 78.3 / tzdata 2026e prints for
   en-CA). Correct offset, possibly odd-looking label.

## Owner actions before Node 24 reaches production

- Count the affected rows (read-only), on PROD and UAT:
  ```sql
  SELECT count(*) AS bc_sessions_after_2026_11_01
    FROM "EventSession" s
    JOIN "Event" e ON e.id = s."eventId"
    LEFT JOIN "Venue" v ON v.id = e."venueId"
    LEFT JOIN "Screen" sc ON sc.id = s."screenId"
    LEFT JOIN "Venue" sv ON sv.id = sc."venueId"
    LEFT JOIN "Cinema" c ON c.id = sc."cinemaId"
   WHERE s."startsAt" >= '2026-11-01T09:00:00Z'
     AND ('America/Vancouver' IN (v.timezone, sv.timezone, c.timezone)
          OR (COALESCE(v.timezone, sv.timezone) IS NULL
              AND COALESCE(v.region, sv.region) ILIKE 'British Columbia'));
  ```
  (Checked for syntax on Postgres 16.)
  The public listing is location-scoped, so it cannot prove there are none. QA's listing (49
  events) has none; PROD's anonymous listing returned 0 events.
- If the count is not zero: decide per show whether the organizer meant the wall clock (then
  shift `startsAt` by -1 h in the same release as Node 24) or the instant (leave it). Tell
  affected buyers.
- Expect the same for UAT.

## Pre-existing (both Node versions), not a regression

On a spring-forward day, a nonexistent wall-clock time such as 02:30 is resolved
differently by the two converters: the API returns the jump-to minute (03:30), the
organizer console the minute one hour earlier (01:30). It only matters for a show typed inside
the skipped hour. Register AR-26.
