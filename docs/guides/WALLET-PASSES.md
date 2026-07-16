# Wallet-Pass Sandbox — Apple & Google Wallet (Sprint 12)

A production-safe integration layer that projects an **existing valid ticket** into an
Apple/Google Wallet pass. A wallet pass is **not a separate ticket** — it is a
projection of the ticket source of truth, carrying the **same signed QR token**. The
layer is **environment-based, typed, and fails closed**: with no credentials
configured it is `unavailable` and the existing customer wallet behaviour is unchanged.

## Design

- **Reuses** the ticket source of truth + QR signing + per-ticket authorization
  (`TicketsService.getForUser`) — a pass never bypasses ticket rules and never mints a
  new identifier. Booking reference, attendee/holder, seat, venue and the signed QR all
  come from the existing ticket projection.
- **Pure eligibility + config policy** in `@eticketsgo/shared-types/wallet-pass.ts`
  (unit-tested): `walletPassEligible` is true **only for an ACTIVE ticket** — revoked,
  transferred, refunded, cancelled, void, expired or already-checked-in tickets cannot
  generate a valid current pass. `resolveWalletProviderStatus` is fail-closed.
- **Adapters** (`apps/api/src/wallet/provider/`): `AppleWalletAdapter` produces a
  `pass.json`-shaped eventTicket descriptor; `GoogleWalletAdapter` an EventTicketObject
  descriptor. Both set the barcode to the existing signed QR token. Neither embeds
  secret material.
- **Provider status**: `unavailable` (not enabled / missing required config),
  `sandbox` (enabled + valid required config; test descriptors, no real signing), or
  `configured` (production; additionally requires resolvable signing material).

## API

- `GET /wallet/providers` — non-secret status only (`{provider, status, mode}`).
- `POST /wallet/passes` `{ ticketId, provider }` — **rate-limited** (30/min) and
  **audited** (`WALLET_PASS_GENERATE`). Returns `available:false` when the provider is
  unavailable, `eligible:false` for an invalid ticket state, or the pass descriptor
  when eligible. Authorization is the ticket's (owner / assigned attendee / admin) — a
  different customer gets **403**. No secret material appears in any response.

## Configuration (environment only — never sent to the browser)

Set these on the **API** process; they are read server-side and never bundled:

| Variable                            | Purpose                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `WALLET_APPLE_ENABLED`              | `true` to enable Apple Wallet                                                                        |
| `WALLET_APPLE_MODE`                 | `sandbox` (default) or `production`                                                                  |
| `WALLET_APPLE_PASS_TYPE_ID`         | Pass Type identifier (non-secret)                                                                    |
| `WALLET_APPLE_TEAM_ID`              | Apple Developer Team ID (non-secret)                                                                 |
| `WALLET_APPLE_CERT_REF`             | **Reference** to the Pass Type ID signing certificate (secret manager); never the certificate itself |
| `WALLET_GOOGLE_ENABLED`             | `true` to enable Google Wallet                                                                       |
| `WALLET_GOOGLE_MODE`                | `sandbox` (default) or `production`                                                                  |
| `WALLET_GOOGLE_ISSUER_ID`           | Google Wallet issuer id (non-secret)                                                                 |
| `WALLET_GOOGLE_SERVICE_ACCOUNT_REF` | **Reference** to the service-account key (secret manager); never the key itself                      |

With none of these set (the default), both providers are `unavailable`, the customer UI
shows **no wallet actions**, and generation fails closed.

## External dependencies still required for production

Real, installable passes are **out of scope without credentials** and require, per
provider:

- **Apple Wallet**: an Apple Developer account, a **Pass Type ID** + a **signing
  certificate** (`.p12`), signed into a `.pkpass`. The adapter's descriptor is the
  input; production signing must resolve `WALLET_APPLE_CERT_REF` via a secret manager.
- **Google Wallet**: a Google Pay & Wallet Console **issuer id** + a **service
  account** with the Wallet Objects API enabled, used to sign the "Add to Google
  Wallet" JWT (resolving `WALLET_GOOGLE_SERVICE_ACCOUNT_REF`).

No production credentials, certificates, issuer keys, service accounts or signing keys
are hardcoded or bundled anywhere in this repository.

## Pass refresh / revocation semantics

A pass is a projection, so its validity tracks the ticket. When a ticket is revoked,
transferred, refunded, or otherwise leaves `ACTIVE`, `walletPassEligible` returns false
and (re)generation returns `eligible:false` — no valid current pass is produced. In
production, a state change would additionally trigger a provider push update (Apple
APNs pass update / Google Wallet object patch) using the same server-side credentials;
that push path is documented here and gated on the production credentials above.

## Customer UI

On the ticket detail page, wallet actions appear **only** for an eligible (ACTIVE)
ticket **and** a provider whose status is `sandbox`/`configured`, with a `sandbox`
badge in sandbox mode. In sandbox the action downloads the non-secret pass descriptor
so the flow is exercised end to end. When unavailable, nothing renders.

## Verification

Unit tests cover eligibility + fail-closed config resolution; API tests cover
authorization, invalid ticket states, missing credentials (unavailable), successful
sandbox behaviour, no-secret responses, and audit records. The drill
`apps/e2e/tests/wallet-passes.spec.ts` verifies both the default fail-closed state
(no UI) and the sandbox state (pass projects the ticket's signed QR, no secrets,
ineligible refused, cross-customer 403).
