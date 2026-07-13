# ETicketsGo — Architecture Review Report

- **Date:** 2026-07-13
- **Reviewer:** Principal Architect
- **Scope:** Entire repository at HEAD `feat/hardening-excellence` (contains PRs #1–#5 stacked; none merged to `main` yet)
- **Method:** 5-lens analysis (architecture/DDD, security, performance/DB, testing/ops, UX/a11y) + targeted re-verification + full toolchain run
- **Mandate:** prove correctness; fix only Critical/High; change no business functionality

## 1. Verdict

The architecture is **sound and internally consistent**. The Experience/Inventory-Strategy seam is the load-bearing abstraction and it holds: new experience types (movie/seat-based) were added with **zero booking-engine changes**, proving the open/closed design. All **Critical and High** findings identified across reviews have been fixed and verified. Remaining items are **Medium/Low** and are logged in the Technical Debt Register.

## 2. Domain-by-domain

| Domain                 | State           | Notes                                                                                                                                                                  |
| ---------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Experience**         | ✅ Correct      | Discriminator on `Event` (`experienceType`), not a duplicate table. Registry maps type → inventory kind — the single extension point.                                  |
| **Inventory Strategy** | ✅ Correct      | `reserve/confirm/release/refund/availability` interface; GA + Seat implementations. Atomic conditional `UPDATE … WHERE` at reservation is oversell-/double-book-proof. |
| **Booking Engine**     | ✅ Correct      | Depends only on `InventoryService` + interface; booking created then reserved in one tx; seat/category price integrity validated.                                      |
| **Movie Domain**       | ✅ Correct      | Reuses Event/Session/Booking/Ticket; `Movie/Cinema/Screen` additive; movie = `Event(MOVIE)`, show = `EventSession(screenId)`.                                          |
| **Seat Reservation**   | ✅ Correct      | `ShowSeat` authoritative per-show state; atomic hold; confirm self-sufficient from persisted seats; **refund now frees seats** (verified live).                        |
| **Discovery**          | ✅ Correct      | Composes existing services; routed through `RecommendationEngine` port (noop today).                                                                                   |
| **Community**          | ✅ Consolidated | Reuses existing follow/saved/reviews/profiles; `/account/following` added.                                                                                             |
| **Organizer CRM**      | ⚠️ Foundation   | Flag-gated placeholder (ADR-015); no live services — no dead code.                                                                                                     |
| **Venue Platform**     | ✅ Incremental  | `Cinema→Screen` reuses `Venue`; deeper hierarchy deferred (ADR-012).                                                                                                   |

## 3. Cross-cutting review

- **Aggregate roots / bounded contexts:** Clear. Inventory mutations now flow through the strategy (refund included). **One residual coupling (Medium):** `ShowsService.scheduleShow` and `EventsService.addTicketType` still create `TicketInventory`/`ShowSeat` rows directly rather than via an inventory provisioning method. Documented, not a correctness bug.
- **Dependency direction:** Acyclic — `madge --circular` reports **no cycles** (141 files). Gate added to CI.
- **Repositories/services:** Prisma via `PrismaService`; services own transactions; strategies receive the caller's `tx` so composition stays atomic.
- **Domain events:** Not yet a formal bus; cross-domain calls are direct application-service calls (acceptable for a modular monolith; an event bus is a scaling option, not a correctness need).
- **Transactions & concurrency:** All money/inventory transitions are atomic and guarded — reserve (conditional hold), confirm (atomic status claim + settle), refund (atomic claim → provider → settle), payout (atomic finalize + single-open guard). Verified by unit tests + live API proofs.
- **Migrations:** All additive (new tables, nullable FKs, `DEFAERR`-safe defaults, indexes). No destructive DDL in any migration. Backward compatible.
- **Feature flags:** Central `FEATURE_DEFAULTS` + env override + `/capabilities` endpoint; enterprise capabilities default off.
- **API contracts:** Stable; every change was additive (new fields/endpoints). Web-kit client is the single typed contract. **No API versioning yet (Medium).**
- **Backward compatibility:** Preserved throughout — existing event booking/payment/QR/refund/reporting/check-in behaviour unchanged (e2e 4/4 green).

## 4. Findings ledger (this review)

- **Critical:** 0 open (5 fixed in Milestone 2).
- **High:** 0 open (payout double-payout **fixed this pass**; all others fixed in M2).
- **Medium/Low:** 12 open — see Technical Debt Register.

## 5. Toolchain proof (HEAD)

lint ✅ · typecheck 16/16 ✅ · prettier ✅ · unit **85/85 (16 suites)** ✅ · `madge` no cycles ✅ · build 8/8 ✅ · Playwright e2e **4/4** ✅.

Live API proofs: concurrent double-book **rejected**; movie refund **frees the seat** (SOLD→AVAILABLE); double refund-request **blocked**; payout double-finalize **blocked**.
