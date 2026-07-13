# ETicketsGo — Performance Report

_Performance engineering sprint. Date: 2026-07-13._

## Scope & rules

Optimize only measurable / structural bottlenecks. No micro-optimization, no behaviour
change, backward compatible, additive, strict TypeScript. Everything not implemented here is
analyzed and given an explicit status so the register stays honest.

The one clear structural bottleneck left after the prior hardening sprint was **TECH-DEBT
D10 — public discovery/catalog recomputed on every anonymous request**. That is the only item
implemented this sprint. All other areas were audited and are either already optimized, verified
OK, or deferred with a reason.

**Status legend:** `Optimized-prior-sprint` · `Optimized-this-sprint` · `Verified-OK` ·
`Deferred-with-reason`.

---

## Summary table

| Area                   | Status                               | Note                                                                              |
| ---------------------- | ------------------------------------ | --------------------------------------------------------------------------------- |
| Database (query shape) | Verified-OK / Optimized-prior-sprint | Set-based writes, single aggregate rounds, no fan-out                             |
| Indexes                | Verified-OK (added prior sprint)     | Every hot filter/sort/join column is indexed; discovery hot paths covered         |
| N+1 queries            | Optimized-prior-sprint               | Organizer dashboard fan-out removed; discovery composes via bounded `Promise.all` |
| Caching                | **Optimized-this-sprint**            | Short-TTL Redis read-through cache on discovery + movie catalog (D10)             |
| API latency            | Optimized-this-sprint                | Repeated anonymous discovery/catalog now served from Redis vs recomputation       |
| React rendering        | Verified-OK                          | Seat selection page already memoizes lookup maps + totals                         |
| Bundle size            | Verified-OK / Deferred               | No structural problem observed; deferred per sprint rules                         |
| Worker                 | Verified-OK                          | Hold-expiry sweep is bounded and set-based                                        |
| Memory                 | Verified-OK                          | Read paths are bounded (`take`/page sizes); cache values are small + TTL'd        |

---

## 1. Database (query shape)

**Findings.** The write and analytics paths were reshaped in the hardening sprint and remain
optimal:

- **Seat / GA holds** are single atomic conditional UPDATEs, not read-modify-write loops.
  `inventory/seat-based.strategy.ts` flips the exact `ShowSeat` rows in one
  `UPDATE "ShowSeat" … WHERE …` and `inventory/general-admission.strategy.ts` guards oversell
  with `UPDATE "TicketInventory" … WHERE (total - sold - held) >= qty`. One round trip, no race.
- **Seat-map / show creation** uses `prisma.createMany` (`shows/shows.service.ts`) rather than
  per-row inserts.
- **`listShows`** collapses per-session counts into a single `groupBy`
  (`events/public-events.service.ts`) instead of one count query per session.
- **Organizer analytics** is computed in a single set of aggregate/`groupBy` rounds
  (`analytics/analytics.service.ts`; the controller documents "single aggregate round; no
  per-event fan-out").

**Status:** `Verified-OK` / `Optimized-prior-sprint`. No behaviour-preserving structural change
was available this sprint.

## 2. Indexes

**Findings.** The schema (`prisma/schema.prisma`) carries every index the hot paths need, all
added in prior sprints — verified present this sprint, no changes made:

- `Booking`: `organizationId`, `eventId`, `status`, `holdExpiresAt`, `userId`,
  `[eventSessionId, status]`, `confirmedAt`.
- `Event`: `status`, `experienceType`, `publishedAt`, `movieId`, `venueId`, `category`, and the
  composite `[status, experienceType, publishedAt]`.
- `Movie`: `status`, `[status, releaseDate]` (covers the public catalog filter+sort exactly).
- `ShowSeat`: `[eventSessionId, status]`, `holdBookingId`. `Ticket`: `seatId`, `status`,
  `eventSessionId`, `bookingId`. `Refund`: `organizationId`, `bookingId`, `status`.

The discovery read paths are index-covered:

- Public movie catalog — `Movie` filter `status = PUBLISHED` + sort `releaseDate desc` is served
  by `[status, releaseDate]`; the optional city filter traverses `Event.venueId` (indexed) →
  `Venue.city` (indexed).
- Legacy discovery categories — distinct over `Event(status, experienceType)` uses
  `[status, experienceType, publishedAt]`.

**Status:** `Verified-OK` (added prior sprint). **No further index changes** were made or are
warranted; the hot paths are already covered.

## 3. N+1 queries

**Findings.** The classic offender — the organizer dashboard issuing one query per event — was
removed in the prior sprint via the analytics aggregate. Discovery composition is **not** N+1: it
fans out a **fixed** number of independent sub-queries through `Promise.all`
(`discovery.service.ts` runs movies + trending + weekend + categories concurrently; the sections
feed runs a fixed strategy set concurrently in `discovery-sections.service.ts`). The count is
constant in the number of rows, so it does not scale with data volume.

**Status:** `Optimized-prior-sprint`. No new N+1 patterns found.

## 4. Caching — implemented this sprint (D10)

**Problem.** `GET /public/discovery`, `GET /public/discovery/sections`, and
`PublicMoviesService.list` are anonymous and identical for every visitor, yet each request
recomputed several aggregate/join queries (movie catalog scan, two paginated event lists with
their price/next-session `groupBy`s, a distinct-category scan, plus the full strategy fan-out for
sections). That fixed compute cost was paid on every hit.

**Fix.** A tiny reusable read-through cache over the existing Redis client:

- **`CacheService.getOrSet(key, ttlSeconds, producer)`** (`src/cache/cache.service.ts`):
  - **Hit** → returns `JSON.parse` of the stored value; the producer is not called.
  - **Miss** → runs the producer, stores `JSON.stringify(value)` with `EX <ttl>`, returns the
    value.
  - **Fail-open** → any Redis error (read _or_ write) is logged (`Logger.warn`) and the producer
    result is returned. The cache can never fail or slow a request beyond the underlying compute.
- **`CacheModule`** (`src/cache/cache.module.ts`) is `@Global`, depends on the already-global
  `RedisModule`, and exports `CacheService`, so read paths inject it with no per-module import
  wiring.

**Wiring (three read paths only):**

| Path                                             | Key                                                | TTL  |
| ------------------------------------------------ | -------------------------------------------------- | ---- |
| `DiscoveryService.get` (legacy composed payload) | `disc:legacy`                                      | 45 s |
| `DiscoverySectionsService.sections(city)`        | `disc:sections:<city\|all>`                        | 45 s |
| `PublicMoviesService.list(filters)`              | `catalog:movies:<city\|all>:<genre\|all>:<q\|all>` | 60 s |

Design notes:

- **Keys are namespaced** and carry every input that changes the output (city for sections; all
  three filters for the catalog), so distinct queries never collide. City/filter values are used
  **raw, not lowercased**, so a strategy that matches city case-sensitively can never be served
  another casing's result.
- **Behaviour is unchanged.** Values are round-tripped through JSON exactly as the HTTP layer
  serializes them, so a cached response is byte-for-byte equal to an uncached one on the wire
  (e.g. `Date` → ISO string happens identically on both paths).
- **Nothing dynamic is cached.** Authenticated/user-specific endpoints and seat-availability
  (`showSeats`) are deliberately excluded — they change on every hold and must stay live.

**Expected effect (structural, not benchmarked).** On a cache hit the request cost drops from
"recompute N aggregate/join queries against Postgres" to "one Redis `GET` + a JSON parse" —
sub-millisecond in the same data centre versus multiple DB round trips. Because it is a
read-through with a 45–60 s TTL, at most one request per key per TTL window pays the full compute;
the rest are served from Redis. Under any real anonymous browse load (many identical
homepage/catalog hits) this removes the dominant repeated cost on these endpoints. No numbers are
claimed — the improvement is the elimination of repeated recomputation, reasoned from round-trip
count.

**Status:** `Optimized-this-sprint`.

## 5. API latency

**Findings.** The discovery/catalog endpoints were the latency hot spot for anonymous traffic
because they recomputed on every hit (§4). With the read-through cache, repeated hits are served
from Redis. Other endpoints are dominated by single indexed queries or set-based writes (§1–2) and
were not a structural concern.

**Status:** `Optimized-this-sprint` (for the three cached paths); rest `Verified-OK`.

## 6. React rendering

**Findings (analysis only — no refactor per sprint rules).** The heaviest client component, the
seat-selection page (`apps/customer-web/app/shows/[sessionId]/page.tsx`), already memoizes its
derived state: `seatsById` and `categoriesById` lookup maps, the `grouped` selection, and the
running `total` are all `useMemo`'d, so re-renders on seat toggles don't rebuild the maps. No
obvious render-thrash or unmemoized heavy computation was observed in the customer app's browse
pages.

**Status:** `Verified-OK`. `Deferred` (by rule) for any deeper render tuning — no structural
problem observed to justify it.

## 7. Bundle size

**Findings (analysis only).** No structural bundle problem was observed that would warrant a
behaviour-touching change this sprint. The three Next apps share `packages/web-kit` and
`packages/design-tokens`, so common UI/icon/animation code is de-duplicated across apps rather
than copied. Icon usage is via `lucide-react` (tree-shakeable named imports). Any code-splitting /
dynamic-import tuning is a client-render optimization explicitly out of scope for this sprint.

**Status:** `Verified-OK` / `Deferred-with-reason` (out of scope; no measured problem).

## 8. Worker

**Findings.** The standalone worker (`apps/worker`) runs a BullMQ repeatable job that reuses
`BookingsService.releaseExpiredHolds`. The sweep is **bounded and set-based** — it targets expired
holds via the `Booking.holdExpiresAt` index and releases inventory with the same atomic conditional
UPDATEs used on the hot path, not a per-booking read loop. Work per tick scales with the (small)
number of expired holds, not total bookings.

**Status:** `Verified-OK`.

## 9. Memory

**Findings.** Read paths are bounded: the public catalog is `take: 60`, discovery lists use fixed
page sizes (`TRENDING_PAGE_SIZE`/`WEEKEND_PAGE_SIZE` = 8), and sections drop empty groups. The new
cache stores only these already-bounded JSON payloads under a 45–60 s TTL, so Redis memory for the
cache is small and self-expiring; no unbounded accumulation is introduced. No large in-process
buffers or leaks were observed.

**Status:** `Verified-OK`.

---

## Files changed this sprint

Added:

- `apps/api/src/cache/cache.service.ts` — reusable `getOrSet` read-through cache (fail-open).
- `apps/api/src/cache/cache.module.ts` — `@Global` module exporting `CacheService`.
- `apps/api/src/cache/cache.service.spec.ts` — hit / miss+TTL / read-error fallback / write-error
  fallback.
- `docs/reports/PERFORMANCE-REPORT.md` — this report.

Modified:

- `apps/api/src/app.module.ts` — register `CacheModule`.
- `apps/api/src/discovery/discovery.service.ts` — cache `get()` (`disc:legacy`, 45 s); compute
  logic moved to `compose()`.
- `apps/api/src/discovery/discovery-sections.service.ts` — cache `sections(city)`
  (`disc:sections:<city|all>`, 45 s); compute moved to `compose(city)`.
- `apps/api/src/movies/movies.service.ts` — cache `PublicMoviesService.list(filters)`
  (`catalog:movies:<city|all>:<genre|all>:<q|all>`, 60 s); query moved to `query(filters)`.
- `apps/api/src/discovery/discovery.service.spec.ts` and
  `apps/api/src/discovery/discovery-sections.service.spec.ts` — inject a pass-through cache stub to
  match the new constructor signatures (behaviour of the specs unchanged).

_No migration. No schema change. No API contract change._

## Cache design recap

- **TTLs:** discovery legacy 45 s, discovery sections 45 s, movie catalog 60 s (all within the
  30–60 s target).
- **Fallback:** any Redis read or write error is logged and the producer runs — the request never
  fails because of the cache.
- **Not cached:** authenticated / user-specific endpoints and seat availability (dynamic).

## Test results

- `npm run typecheck --workspace @eticketsgo/api` — passes (strict TS, no errors).
- `npx jest` (apps/api) — **31 suites, 185 tests, all green**, including the 4 new
  `cache.service.spec.ts` cases. The `CacheService` WARN logs during the run are the intentional
  fallback-path tests exercising Redis read/write errors.
