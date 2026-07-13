# ETicketsGo — Engineering Health Report

- **Date:** 2026-07-13 · **HEAD:** `feat/hardening-excellence`

## Scorecard

| Dimension     | Grade  | Evidence                                                                                                                                            |
| ------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build health  | **A**  | 8/8 packages build; turbo caching correct.                                                                                                          |
| Type safety   | **A**  | Strict TS; typecheck 16/16 across all packages.                                                                                                     |
| Lint / format | **A**  | ESLint clean; Prettier normalized repo-wide.                                                                                                        |
| Unit tests    | **B+** | 85 tests / 16 suites; money + auth + inventory paths covered. Gap: DB-backed concurrency integration harness (mocked `tx` today).                   |
| E2E           | **B**  | 4 journeys (GA booking, movie seat booking, organizer wizard, admin review). Gaps: refund, check-in, seat-map authoring.                            |
| Architecture  | **A-** | Clean seams, no cycles; one residual inventory-write coupling (Medium).                                                                             |
| Security      | **A-** | RBAC/tenant isolation enforced + tested; money paths hardened. Backlog: refresh-token reuse detection, token storage, per-endpoint auth throttling. |
| Performance   | **B+** | Hot-path indexes added; atomic set-based inventory ops. Backlog: organizer-dashboard N+1 rollup, discovery cache.                                   |
| Observability | **C+** | Health/readiness probes + correlation ids; API logs not yet structured JSON; no metrics.                                                            |
| CI/CD         | **B+** | format→lint→typecheck→madge→build→e2e; Postgres+Redis services. Gaps: coverage threshold, integration stage.                                        |
| Docs          | **A**  | 18 ADRs + these 5 reports; context captured.                                                                                                        |

**Overall engineering health: B+ (strong; production-capable with the documented backlog addressed).**

## Strengths

- The pluggable inventory strategy is a genuinely correct extension seam — proven by adding seat-based booking with no booking-engine edits.
- Money/inventory transitions are uniformly atomic and now regression-guarded by tests.
- Additive-only migrations; strict backward compatibility discipline.
- No circular dependencies; single typed API client contract.

## Weaknesses / watch-items

- Mocked-`tx` unit tests can't catch a real Postgres concurrency regression in the atomic holds — the highest-value remaining test investment.
- Two inventory counters of record (ShowSeat vs TicketInventory) kept in step manually — drift risk if a future path updates one only.
- Observability is thin for a payments platform (no metrics/SLOs).

## Test inventory (16 suites, 85 tests)

inventory (GA + seat: reserve/confirm/release/refund/oversell/double-book), payments confirm (idempotency/atomic/expiry), refunds process + request hardening, payouts double-payout guards, OrgAccess RBAC/tenant, check-in branches, experience registry, discovery, movies, shows, fee calculator, refund eligibility, QR, mock provider, booking expiry sweep, validation.
