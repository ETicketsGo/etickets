# Offline Gate Check-In & Native Wallet Passes (ADR-035) — Program status

**Offline gate check-in is DISABLED by default and NO-GO for production** until the
full protocol below is complete and live drills pass. This sprint shipped the
**safe, verified foundation** (device model, signed manifest, the pure validator,
the reconciliation classifier, the readiness gate — all flag-off, unit-tested) plus
customer **storage-eviction** enforcement. The organizer offline scan UI, live
two-device conflict drills, background-sync queue, and native Apple/Google Wallet
passes remain a documented, staged follow-up — not faked as complete.

## Security model

A server-signed, short-lived, device-scoped **manifest** is the offline root of
trust. It lists, per ticket, the current `nonce/version` + `status` + `eligible`.
A scanned QR is decoded and matched against the manifest; a device holds **no QR
signing secret** (avoids distributing a symmetric secret to gates). Anything the
manifest cannot confirm returns `REQUIRES_ONLINE_VALIDATION` — never `VALID`.
Duplicate detection (local ledger + server reconciliation) stops replays. The
**server always wins** at reconnect, and the gate re-validates online whenever it
can. Offline never grants entry authority — it defers to the eventual server truth.

## What shipped (verified, flag-off)

- **`CheckInDevice`** model + `CheckInDeviceService` — register (PENDING) → manager
  approve (ACTIVE, expiring) → revoke; event/session scoped; audited. No org-wide
  offline credential; private keys never leave the device (only a `publicKeyRef`).
- **`CheckInManifest`** + `OfflineManifestService` — builds + HMAC-signs a scoped,
  short-lived (6h) manifest of minimal validation data; `verify()` is deterministic;
  audit header persisted. No profiles/emails/phones/payment data.
- **`validateOfflineScan`** (pure, shared-types) — the full validation order and the
  15 result states (`VALID`, `ALREADY_CHECKED_IN_LOCAL/SERVER_KNOWN`,
  `INVALID_SIGNATURE`, `WRONG_EVENT/SESSION`, `REVOKED/REFUNDED/CANCELLED/
TRANSFERRED`, `EXPIRED`, `MANIFEST_STALE`, `DEVICE_NOT_AUTHORIZED`,
  `REQUIRES_ONLINE_VALIDATION`, `SUPERVISOR_REVIEW_REQUIRED`). Never accepts
  uncertainty. Supervisor override allowed only for soft states — never crypto/
  scope/revoke failures.
- **`classifyReconciliation`** (pure) + `OfflineReconciliationService` — classifies
  each queued check-in against current server state: accepted / duplicate same-
  device / duplicate other-device / refunded/revoked/transferred-after-download /
  wrong-session / already-online / review. Accepting reuses the atomic
  ACTIVE→CHECKED_IN claim (idempotent, no double issue). Revoked device → rejected.
- **`OfflineCheckinReadinessService`** + `GET /checkin/offline-readiness` →
  `GO / CONDITIONAL_GO / NO_GO` (default NO_GO; only pass/fail exposed).
- **Flag-gated controller** (`OFFLINE_CHECKIN_ENABLED`, off): operational endpoints
  404 while off; readiness always answers NO_GO.

All of the above is unit-tested (validator + reconciliation: 16 web-kit tests;
manifest signing, reconciliation idempotency/conflict, readiness: API tests).

## Offline check-in threat model (summary)

| Threat                                      | Mitigation / status                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Stolen/lost device                          | Remote **revoke** → reconciliation rejects its queue; short device expiry              |
| Copied/expired/rollback manifest            | Signed + short-lived + monotonic version; validity window checked                      |
| Revoked/refunded/transferred after download | Reconciliation flags it; server wins; nonce rotation invalidates the QR                |
| Rotated QR nonce                            | Manifest nonce mismatch → `REQUIRES_ONLINE_VALIDATION`, never valid                    |
| Two offline devices scan same ticket        | Local ledger (same device) + reconciliation duplicate-other-device (cross device)      |
| QR replay / screenshot                      | Same as online: first check-in wins; duplicates surfaced                               |
| Device clock manipulation                   | Manifest validity is server-stamped; large drift → preflight blocks (planned)          |
| Fake supervisor override                    | Override never bypasses crypto/scope/revoke; audited; default-deny                     |
| Symmetric QR secret on device               | **Avoided** — manifest is the root of trust; asymmetric QR signing is future hardening |

Residual (accepted, documented): a stale device can display a pass changed after
its last sync — the **gate re-validates and the server wins**; offline never grants
final entry.

## Remaining program (NO-GO until done + drills pass)

1. Organizer offline scan UI: manifest download/refresh, preflight checklist, the
   scan-offline flow using `validateOfflineScan`, encrypted local ledger + durable
   IndexedDB queue (idempotency, backoff, dead-letter, multi-tab lock), operations
   drawer, and the reconciliation console.
2. Asymmetric device keys (WebCrypto) + encrypted per-device manifest delivery +
   revocation deltas (incremental) with a configurable max-stale window.
3. Live drills — two-device conflict, device-loss, reconciliation — **required**
   before enabling at any real event.

## Storage eviction (M13) — SHIPPED

`selectForOfflineStorage` (pure, tested) enforces the per-user offline ceiling:
historical/expired passes are evicted first (retention window), **upcoming/event-
day active passes are always preserved**, ranked by soonest start. `saveWallet`
applies it and requests persistent storage (`StorageManager.persist`).

## Background sync (M14) — POLICY DOCUMENTED

Allowed for safe actions only (wallet refresh, feedback, ack, non-sensitive
prefs). **Never** for payments/refunds/payouts/transfers/assignment/share changes/
admin approvals/check-in (except under the offline protocol above). Wallet
refresh-on-reconnect is wired; a general Background Sync queue is a follow-up.

## Native wallet passes (M15/M16) — NO-GO (no issuer credentials)

The `WalletPassProvider` abstraction + Apple `.pkpass` / Google Wallet adapters are
a documented next step and **must remain NO-GO in production** until real Apple
signing certificates and a Google issuer service account are configured and
certified. Passes must update or invalidate on transfer/refund/revoke/nonce-
rotation (reuse the existing rotation + reconciliation), and the ETicketsGo server/
gate remain authoritative. No fake credentials are committed.

## GO / NO-GO

- **Customer storage eviction:** GO (shipped, tested).
- **Offline gate check-in foundation:** shipped + tested, **feature flag OFF**.
- **Offline gate check-in activation:** **NO-GO** — needs the organizer UI + live
  drills above.
- **Native wallet passes:** **NO-GO** — needs real Apple/Google issuer credentials.
