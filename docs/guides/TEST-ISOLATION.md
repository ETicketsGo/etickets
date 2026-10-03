# Test isolation: shared fixture dimensions

**Status:** standing P2 engineering-quality debt. Not a blocker for any certification.

## The failure this describes

The API integration suites run **in parallel against one PostgreSQL database**. A spec that asserts
on a fact true of the _whole database_ can be invalidated by any other spec writing at the same
time.

Both the assertion and the interfering write are individually correct. The bug is the **shared
fixture dimension** — a value another file can also write.

These fail intermittently, so **a green run proves nothing about the next one.** Every instance
below was found by a failing gate, never by reading code.

## The rule

> A fixture dimension another spec file can also write is not a fixture. It is a shared global.

If your spec asserts "the database contains N of X", ask who else can create an X.

## Observed instances

| #   | Spec                                           | Shared dimension                                     | Status                                             |
| --- | ---------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------- |
| 1   | `admin-grouping` summary-vs-list               | every row of a resource, read twice                  | fixed — `agrees()` retry (#187)                    |
| 2   | `admin-grouping` retry convergence             | `0` vs `undefined` for a vanished group              | fixed — `?? 0` (#195)                              |
| 3   | `cinema-policy` / `telangana-and-immutability` | country `'Testland'`                                 | fixed — own country (#195)                         |
| 4   | `admin-grouping` events-by-country             | country `'India'`, written by **50 spec files**      | mitigated — bounded retry + 5 specs renamed (#196) |
| 5   | `notifications/policy/fallback`                | _"Record to update not found"_ under full-suite load | **open** — passes 3/3 in isolation                 |

### Why #2 is instructive

The fix for #1 _introduced_ #2. The retry compared a count of `0` against `undefined` — the same
fact, since a group with no rows is absent from a `GROUP BY` — so it could never converge on the
benign case it existed to tolerate.

### Why #3 is instructive

`cinema-policy` cleaned up correctly, scoped to its own `regulatoryReference`. That cleanup
**cannot** isolate a country-scoped question, because the question it asks is _"does this country
have any active policies"_ and another file was answering yes.

### Why #4 is the general shape

`country: 'India'` appears in **50 spec files**; `city: 'Bengaluru'` in 18. A global
events-by-country count is therefore a moving target for the entire run.

## Remediation, in preference order

### 1. Give the spec file its own fixture dimension

Cheapest and most reliable. Costs nothing when the spec does not assert on that dimension:

```ts
// Nothing here asserts on country, so a unique one removes this file as an interferer.
const COUNTRY = 'Financeland';
```

Applied in: `unified-finance*.integration-postgres.spec.ts` (`Financeland`, `Authland`,
`Consistencyland`, `Queryland`), `payout-certification` (`Certland`), `cinema-policy`
(`Policyland`).

### 2. Replace a database-wide assertion with a scoped one

Where a scoped question answers the same thing. Comparing SQL against a Prisma `where` is just as
meaningful over rows the test owns — and it is deterministic.

### 3. Tolerate a moving target without weakening the assertion

Only where the comparison must be global. `agrees()` reads until a pair converges, bounded:

```ts
// A real SQL/Prisma disagreement is wrong on EVERY attempt and can never converge, so it fails
// exactly as before. A target that moves between reads is no longer mistaken for one.
```

Verified by re-injecting a row-multiplying join: still fails 8 tests, identical to before.

### Not available: serialising the suite

`apps/api/jest.config.js` documents why parallelism must stay at **≥2 workers** — fewer makes Jest
run in-band, where leaked handles stop the process exiting and CI burns its whole budget while
reporting a green suite. Serialising to hide isolation defects would trade an intermittent failure
for a guaranteed timeout.

## Not yet done

No audit of the remaining ~390 suites. All five instances were found by failing gates, so **expect
more.** A deliberate pass over integration specs that assert unscoped counts would be worth more
than waiting for the next red CI run.
