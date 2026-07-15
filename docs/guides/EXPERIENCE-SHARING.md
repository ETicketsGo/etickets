# Secure Experience Sharing Platform (ADR-032)

A generic, secure sharing layer over any **ShareableResource** — tickets today;
memberships, passes, vouchers and parking next (Experience Wallet) with no
redesign. Reuses the Sprint-4 attendee/invite ledger, QR signing, notifications,
and audit. **Never mints a second QR** — there is always exactly one source of
truth.

## The generic model (CTO abstraction)

```
interface ShareableResource {
  resourceType; id; ownerUserId; organizationId; status; endsAt;
  canView / canCheckIn / canShowLiveQr / canTransfer / canDownload(permission);
  toShareView();      // scoped recipient view — never leaks owner-private data
  liveQrToken();      // the one real QR token (only exposed when policy allows)
}
```

`Ticket` implements it via `TicketShareableResource`; a `ShareableResourceRegistry`
resolves `(resourceType, id)`. Adding a new wallet item = one adapter + one
registry line — `SharingService` is untouched.

## Sharing types (permissions)

| Permission   | Live QR                 | Check-in | Transfer | Use                                |
| ------------ | ----------------------- | -------- | -------- | ---------------------------------- |
| **VIEW**     | hidden                  | no       | no       | Show someone the ticket, read-only |
| **GUEST**    | **shown** (the real QR) | yes      | no       | Temporary, expiring gate access    |
| **TRANSFER** | no (until accepted)     | no       | yes      | Hand ownership over (rotates QR)   |

The live QR is the ticket's single signed token. GUEST shows it directly (no copy
is made); when the share expires/revokes, the recipient simply loses access — the
QR itself is unchanged and still valid for its rightful holder.

## Share link

`{customer-web}/share/<token>` — the token is 192-bit random; only its **SHA-256
hash** is stored. Signed (unguessable), **expiring**, **revocable**,
**multi/single-use** (via `maxOpens`), and **every open is audited**. Database IDs
are never exposed in the link.

## Lifetime & restrictions

- Expiry presets: **1h / 6h / 24h / until event end / never** (organizer/owner
  choice). `event_end` resolves from the resource's `endsAt`.
- **Max opens** enforces single- or limited-use; exceeding it expires the link.
- Placeholders wired for future policy: IP/device logging, country restriction,
  screenshot warning (columns/hooks present; enforcement is a follow-up).

## QR security

- **VIEW** → no live QR (optionally a watermarked preview later).
- **GUEST** → the single real QR, time-limited by the share; revoke kills access.
- **TRANSFER** → on accept, the ticket **nonce rotates** (`qrVersion++`), so the
  old QR is invalid at the gate — enforced by the existing nonce check.
- A VIEW/GUEST token can **never** be used to take ownership: `accept` rejects any
  non-`TRANSFER` permission.

## API (RESTful, additive — no breaking changes)

| Method + path                 | Who    | Purpose                                           |
| ----------------------------- | ------ | ------------------------------------------------- |
| `POST /tickets/:id/share`     | owner  | Create a share (returns link + QR)                |
| `GET  /tickets/:id/shares`    | owner  | Activity: shares, opens, status                   |
| `POST /shares/:id/revoke`     | owner  | Revoke                                            |
| `POST /shares/:id/extend`     | owner  | Extend expiry                                     |
| `POST /shares/:id/permission` | owner  | Change permission                                 |
| `POST /public/share/:token`   | anyone | Resolve → permission-scoped view (+ QR for guest) |

Transfer acceptance reuses `POST /attendee-invites/:token/accept` (Sprint 4).

## Data model

Extends the **`TicketInvite`** ledger (no duplicate share table): adds
`permission` (SharePermission), `resourceType` (ResourceType), `maxOpens`,
`openCount`, `lastOpenedAt`, `lastOpenedByUserId`, `label`; `email` is now
optional (a link needn't target a person). Existing rows backfill to
`TRANSFER`/`TICKET`. Additive migration `20260715150000_experience_sharing`.

## Threat model

| Threat                               | Mitigation                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| **Token guessing / enumeration**     | 192-bit random tokens; only hashes stored; unknown token → generic "not valid"           |
| **Replay / reuse**                   | Status gate (PENDING only); `maxOpens` limit; accepted/revoked/expired can't resolve     |
| **Expired links**                    | Server checks `expiresAt`, marks EXPIRED, refuses                                        |
| **Revoked links**                    | Status REVOKED refused immediately; next open (even from cache) fails on reconnect       |
| **Privilege escalation** (view→own)  | `accept` refuses any non-TRANSFER permission                                             |
| **Concurrent ownership / double QR** | Single QR; transfer rotates nonce; only one PENDING transfer resolves                    |
| **RBAC / tenant isolation**          | Create/revoke/extend require owner (or admin); `organizationId` stamped; org-scoped gate |
| **Brute force / abuse**              | Global throttler; every create/open/revoke/extend audited                                |
| **Token leakage**                    | Hash-at-rest; short expiry presets; revoke + max-opens limit blast radius                |
| **Stale cache**                      | Guest offline works after first load; a revoked share fails on the next online resolve   |

## Accessibility

Dialog (focus-trapped, keyboard, Escape), radio-group permission picker with
text + icon, labeled inputs, `aria-label` on links/QR, status by text (never
colour alone), large touch targets — WCAG AA, consistent with the shared kit.

## Competitive review

| Capability                            | ETicketsGo | BookMyShow | Ticketmaster   | Eventbrite | District | Ticket Tailor | Humanitix | DICE |
| ------------------------------------- | ---------- | ---------- | -------------- | ---------- | -------- | ------------- | --------- | ---- |
| Transfer ownership (QR rotates)       | ✅         | ⚠️ limited | ✅             | ⚠️         | ⚠️       | ❌            | ❌        | ✅   |
| **View-only** secure share            | ✅         | ❌         | ❌             | ❌         | ❌       | ❌            | ❌        | ❌   |
| **Guest access** (temp QR, revocable) | ✅         | ❌         | ⚠️ (app-bound) | ❌         | ❌       | ❌            | ❌        | ⚠️   |
| Expiring + revocable links            | ✅         | ❌         | ⚠️             | ❌         | ❌       | ❌            | ❌        | ⚠️   |
| Max-opens / single-use links          | ✅         | ❌         | ❌             | ❌         | ❌       | ❌            | ❌        | ❌   |
| Multi-channel (WA/SMS/Email/QR)       | ✅         | ⚠️         | ⚠️             | ⚠️         | ⚠️       | ⚠️            | ⚠️        | ⚠️   |
| Generic across resource types         | ✅         | ❌         | ❌             | ❌         | ❌       | ❌            | ❌        | ❌   |
| Full audit of every open/revoke       | ✅         | ?          | ⚠️             | ?          | ?        | ❌            | ❌        | ⚠️   |
| Anti-scalping (rotating/app-locked)   | ⚠️ roadmap | ❌         | ✅             | ❌         | ❌       | ❌            | ❌        | ✅   |
| Resale marketplace                    | ❌ roadmap | ⚠️         | ✅             | ❌         | ⚠️       | ❌            | ❌        | ✅   |

**Ahead:** view-only + guest access + expiring/revocable/limited links + a
generic resource model — none of the incumbents ship this combination; most only
do full transfer. **Equal:** ownership transfer with QR invalidation (Ticketmaster,
DICE). **Still to improve:** app-locked/continuously-rotating QR for high-demand
anti-scalping, and a resale marketplace (both on the 12-month roadmap, and both
build directly on this sharing + transfer layer).

## Backward compatibility

All columns additive/nullable; existing invites keep working (backfilled to
TRANSFER/TICKET). No change to booking, payment, inventory, or QR signing. Older
clients ignore the new fields.
