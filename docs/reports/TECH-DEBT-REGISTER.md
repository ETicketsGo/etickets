# ETicketsGo — Technical Debt Register

- **Date:** 2026-07-13 · **HEAD:** `feat/hardening-excellence`
- All **Critical/High** items are **fixed**. The following are the open **Medium/Low** items (not fixed per the "fix only Critical/High" mandate) plus one High-severity item whose full fix requires a schema change.

| # | Severity | Area | Item | Recommended fix | Effort |
|---|---|---|---|---|---|
| D1 | High* | Payouts | Settled-cursor: `settle()` still re-sums all confirmed bookings; the immediate double-payout vectors are guarded (atomic finalize + single open payout), but there is no linkage excluding already-PAID revenue across payout cycles. | Add `Payout ↔ Booking` settlement linkage (or a per-booking `settledPayoutId`) so each booking's revenue is paid once. *Requires a schema change → alters payout semantics, hence deferred.* | M |
| D2 | Medium | Inventory | Dual source of truth: `ShowSeat` (authoritative) + `TicketInventory` counters kept in step manually. | Derive seat availability/sold from `ShowSeat` aggregates and drop the parallel counter, or funnel every transition through one guarded routine. | M |
| D3 | Medium | Bounded context | `ShowsService.scheduleShow` / `EventsService.addTicketType` create `TicketInventory`/`ShowSeat` directly. | Add `InventoryService.provision(...)` and route both callers through it. | S |
| D4 | Medium | Governance | Movie shows auto-publish (`Event` created `PUBLISHED`), bypassing the admin review events go through. | Route movie events through the same DRAFT→review flow, or gate auto-publish behind organizer trust level. | S |
| D5 | Medium | Security | Refresh-token rotation has no reuse detection. | On replay of a rotated token, revoke the whole descendant chain + force re-auth. | S |
| D6 | Medium | Security | Access/refresh tokens in `localStorage` → any XSS = persistent ATO. | Move refresh token to `HttpOnly`+`Secure`+`SameSite` cookie; keep access token in memory; add CSRF for the cookie refresh. | M |
| D7 | Medium | Security | Auth endpoints share the global 120/min throttle; no `trust proxy`. | Tight per-account/IP throttle on login/register/refresh; configure proxy trust. | S |
| D8 | Medium | Security | Financial reads (payouts, event reports) allow any active member incl. `CHECKIN_STAFF`. | Restrict to `ORGANIZER_OWNER`/`MANAGER` + platform admin. | S |
| D9 | Medium | Performance | Organizer dashboard N+1 (one report request per event). | Single `reports.organizerSummary(orgId)` aggregate endpoint. | M |
| D10 | Medium | Performance | Public discovery/catalog recomputed per request. | Short-TTL Redis cache (30–60s) on discovery + movie list. | S |
| D11 | Medium | Ops | API logs not structured JSON; no metrics. | JSON log fields (method/path/status/ms/cid) matching the worker; add `prom-client` counters (bookings/confirms/refunds/check-ins/errors). | M |
| D12 | Medium | API | No versioning strategy (single `/api` prefix). | `enableVersioning({type:URI})` under `/api/v1`. | S |
| D13 | Low | Testing | Unit tests mock `tx`; no real-DB concurrency test of the atomic holds. | Integration project against CI Postgres; fire N concurrent reserves → exactly one wins. **Highest-value test investment.** | M |
| D14 | Low | Testing | E2E gaps: refund, check-in, seat-map authoring; admin spec has conditional (no-op-able) assertions. | Add refund + check-in e2e; seed a deterministic pending event; remove `if` guards. | M |
| D15 | Low | Security | QR tokens never expire; nonce/qrVersion not rotated on check-in reversal. | Enforce a validity window in `verify()`; bump `qrVersion` on issue/reversal. | S |
| D16 | Low | UX/a11y | Seat status color-only (SOLD/HELD grey); 28px touch targets; selected-seat `text-white` on arbitrary swatch. | Non-color affordance for taken seats; larger mobile targets; luminance-aware foreground. | S |
| D17 | Low | Product | Movie `trailerUrl` captured but never surfaced to customers. | "Watch trailer" affordance on the movie detail page. | S |

\* D1's exploitable vectors are already blocked; the residual is a structural correctness improvement gated behind a schema change, so it is registered rather than force-fixed under the "no business-functionality change" constraint.
