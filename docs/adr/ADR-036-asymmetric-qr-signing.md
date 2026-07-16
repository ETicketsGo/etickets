# ADR-036 — Asymmetric QR / manifest signing (migration path)

Status: **Proposed** (hardening for offline gate check-in; not yet implemented)

## Context

QR tokens and offline check-in manifests are currently signed with **symmetric
HMAC-SHA256** (`QR_SIGNING_SECRET` / `MANIFEST_SIGNING_SECRET`). This is correct
for the online path (only the server signs and verifies) and for the offline
protocol shipped so far, because **check-in devices hold no signing secret** — the
server-signed manifest is the offline root of trust and devices only match a
scanned QR's `ticketId`/`nonce`/`version` against it.

However, two future capabilities want a device to **verify a signature offline**:
(1) verifying a scanned QR's signature without the manifest, and (2) verifying
manifests/deltas cryptographically on-device. With HMAC that would require shipping
the shared secret to every gate device — a serious risk (one compromised device
could forge unlimited valid QRs/manifests). Asymmetric signing removes that risk.

## Decision

Introduce **Ed25519** (or ECDSA P-256) signing for QR tokens, manifests, and
revocation deltas, versioned alongside the existing HMAC so it is fully backward
compatible:

- The server holds the **private** key; devices receive only the **public** key.
- QR payloads already carry a `version` field — add a `keyId`/`alg` so verifiers
  pick the right key and algorithm. Old HMAC tokens keep verifying during rollout.
- Manifests/deltas gain `alg` + `keyId`; devices verify with the pinned public key.
- Key rotation: publish a new `keyId`; sign new artifacts with it; keep verifying
  the previous key until all outstanding manifests/tokens expire. Device manifests
  carry the `keyId` they were signed with.

## Consequences

- **Security:** device compromise no longer enables forgery — a device can verify
  but not sign. This is the prerequisite for device-side QR/manifest verification.
- **Compatibility:** additive. HMAC remains for the online path and for already-
  issued tokens until expiry; no re-issue of live tickets required.
- **Ops:** adds a signing-key rotation runbook (private key in the secret manager;
  public keys distributed with device credentials). Manifest/delta size grows by a
  signature (~64 bytes) — negligible.
- **Scope:** implement behind the offline-checkin flag; ship with the organizer
  scan UI when device-side verification is actually used. Until then, the current
  HMAC + manifest-as-root-of-trust model is sufficient and safe.

## Not doing (now)

Rewriting the online QR path or re-issuing existing tickets. The migration is
rollout-friendly and gated to the offline program.
