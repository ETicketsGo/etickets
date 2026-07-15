# Resilient Offline Experience Platform (ADR-034)

Make every already-issued pass reliably accessible during weak/absent connectivity
— **without weakening QR security or presenting stale access as guaranteed valid**.
Offline is a resilience feature, not an authorization bypass: the gate scanner
remains the ultimate authority (signature + nonce + status + session + ownership).

## Architecture

- **Service worker** (`public/sw.js`) — versioned caches, strict same-origin
  scope, app-shell + static offline. Registered production-only, after `load`
  (never competes with hydration). Never caches `/api/*` or any non-GET request.
- **User-scoped IndexedDB** (`lib/offline/wallet-store.ts`) — the primary offline
  store (replaces the localStorage snapshot). Records keyed by user id; hold only
  offline-eligible items with the minimum needed to render a pass.
- **Eligibility policy** (`web-kit/offline-eligibility.ts`) — pure, generic; the
  same policy will serve future wallet items (Membership, Parking, Coupon).
- **Sync engine** (`lib/offline/sync.ts`) — network-first with an IndexedDB
  fallback; server-wins on reconnect (replace + purge). Event-driven (login /
  foreground / reconnect / React Query refetch); no polling loop.

## What the customer gets

After loading their wallet/ticket **once online**, a customer can — with no
connection — reopen the app, open **My experiences**, open a booking, see the
**cached QR**, navigate grouped tickets, and open **Event Day Mode** (which shows
"Offline — last verified <time>" and defers entry to the scanner). Sync state is
always visible (Up to date / Syncing / Offline / …) with a last-updated time,
Sync now, and Clear offline data.

## Caching policy matrix

| Resource                            | Policy                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| App shell / navigations             | Network-first, cache the shell, offline → cached page then `/offline.html`                          |
| Next static (`/_next/static/`)      | Cache-first (immutable, versioned)                                                                  |
| `/api/*` and all mutations (POST/…) | **Never cached** — pass through; app uses IndexedDB                                                 |
| Authenticated wallet data           | IndexedDB, user-scoped, network-first with cached fallback                                          |
| QR images (`qrDataUrl`)             | Cached **only** for offline-eligible, owned/assigned tickets; replaced on re-sync; purged on logout |
| Payment / refund / payout / admin   | Never offline-enabled; nothing sensitive cached                                                     |

## Offline eligibility

Cacheable only if issued, in an eligible status, **held by the viewer**, and it
has a QR. Eligible: `ACTIVE`, `CHECKED_IN` (historical display). Never:
`PENDING_PAYMENT`, `CANCELLED`, `REFUNDED`, `VOID`, `EXPIRED`, `DECLINED`,
`REVOKED`, or transferred-away (owner no longer holds it). Generic
(`isOfflineEligible`) so new wallet items implement their own rules.

## Sync & conflict resolution

The **server always wins** on ownership, status, QR nonce/version, transfer,
refund, cancellation, revocation, assignment, share expiry and check-in. On
reconnect the wallet refetches and **replaces** the cache — a rotated nonce yields
a new `qrDataUrl` (old QR dropped); a refunded/transferred/revoked item fails the
eligibility filter and is **purged**. Conflicts handled: transfer/refund/revoke
while offline, nonce rotation, cancellation, check-in on another device, multi-
device same user, logout while offline — all reconcile to the server on the next
successful sync.

## Data stored / never stored

Stored (minimized): wallet item id, resource type, booking reference, title,
date/time, venue/cinema/screen, ticket type, seat, attendee display name, last-
known status, QR **display image**, nonce/version implied by the image, last-sync
timestamp, ownership context, offline eligibility. **Never stored:** auth/refresh
tokens, payment details, full attendee profiles, share-token hashes, provider
data, unnecessary phone/email.

## Privacy & shared-device safety

Records are namespaced by the JWT `sub` (decoded locally only to partition
storage — never trusted for authz). **Logout purges** that user's cached wallet +
QR payloads; a different user on the same device loads only their own namespace
(verified by Playwright). "Clear offline data" wipes everything on the device.

## Threat model (offline)

| Threat                             | Mitigation                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cached QR extraction               | Only owned/assigned issued passes; the QR is already the user's; the gate still validates nonce/status/session/ownership             |
| Shared-device leakage              | User-scoped IndexedDB + logout purge + no token caching                                                                              |
| Stale transferred / revoked ticket | Eligibility purge on re-sync; nonce rotation invalidates old QR at the gate regardless                                               |
| Cache poisoning / SW takeover      | Strict same-origin scope, cache allowlist, versioned caches, activate-time cleanup                                                   |
| Old SW serving obsolete code       | Versioned caches + user-accepted update flow (reload only on explicit accept)                                                        |
| XSS → IndexedDB                    | Data minimization (no secrets/tokens) limits blast radius; standard CSP applies                                                      |
| Storage exhaustion                 | Only eligible items + minimized fields; StorageManager estimate; eviction is a documented follow-up                                  |
| Downgrade / stale window           | Documented residual: an offline device can show a pass revoked after last sync; the **gate rejects it** — offline never grants entry |

**Residual risk (accepted):** between the last successful sync and reconnect, a
device can display a pass whose server-side state has changed. This never grants
entry — the scanner re-validates. It is the unavoidable offline stale-window;
mitigated by frequent sync, short-lived context, and gate authority.

## Accessibility

Offline/sync status via `role="status"` live regions, text + icon (never colour-
only), keyboard-operable Sync/Clear, focus retained across online/offline
transitions, Event Day Mode remains screen-reader usable offline, WCAG AA.

## Browser support

Service Worker + Cache Storage + IndexedDB: all modern evergreen browsers
(Chrome/Edge/Firefox/Safari 16+). Where a service worker is unavailable the app
still works online and degrades gracefully (no offline shell). Wake Lock and
Background Sync are progressive enhancements.

## Organizer offline gate check-in — status: DOCUMENTED PROPOSAL (not shipped)

Full offline gate check-in is **intentionally not enabled** this sprint — doing it
safely needs an encrypted signed event manifest, device registration, revocation
deltas, local duplicate detection, a queued-check-in reconciliation protocol, and
a supervisor-override audit trail. Shipping a half-safe version would risk letting
revoked/duplicate tickets through the gate. Proposed foundation (interfaces +
schema + threat model) to build next: signed `EventTicketManifest` (versioned,
expiring), `DeviceRegistration`, `RevocationDelta`, `OfflineCheckInQueue`,
`ReconciliationJob`, `SupervisorOverride`, all behind a feature flag, with
reconcile-on-reconnect and full audit. Until then, gate check-in requires
connectivity (the current, safe behaviour).

## Known limitations

- Offline requires the wallet/ticket to be opened online **once** first.
- App-Router client-side navigation between routes needs connectivity (RSC data);
  **reopening/reloading** a pass offline is fully supported (the real scenario).
- Storage eviction (oldest-completed-first) is specified but not yet enforced;
  current wallets are far below quota.
- Background Sync mutation queue (feedback / wallet-refresh) is documented policy;
  only wallet refresh-on-reconnect is wired.
- Guest-share offline is documented; the owned-wallet offline path is what ships.
- Organizer offline check-in: proposal only (see above).

## GO / NO-GO

**GO** for the customer offline wallet — verified end-to-end by Playwright
(book → cache → offline reload → QR + group nav + Event Day Mode → reconnect →
resync; plus logout-purge and second-user isolation). **NO-GO / deferred** for
organizer offline gate check-in, by design, until the safe protocol above is built.
