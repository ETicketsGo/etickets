# ETicketsGo — Customer Support Workflows & Contact Flows

Operational support process for launch. Adapt channels/SLAs to your team.

## Contact channels
| Channel | Audience | Notes |
| --- | --- | --- |
| Help center / FAQ | All | Self-serve first line — see [FAQ.md](FAQ.md). |
| Support email `[support@…]` | Customers + organizers | Primary async channel; ticketed. |
| In-app contact form | Logged-in users | Pre-fills account + booking context. |
| Organizer escalation `[organizers@…]` | Organizers | Payout/onboarding/finance issues. |
| Urgent/event-day hotline `[phone]` | Organizers at live events | Gate/check-in incidents. |

## Response targets (suggested SLAs)
| Priority | Example | First response | Resolution target |
| --- | --- | --- | --- |
| P1 — event-day blocking | Gate can't check in; payments down | 15 min | Same day |
| P2 — transactional | Payment charged, no ticket; refund stuck | 4 business hours | 1 business day |
| P3 — general | How-to, account question | 1 business day | 3 business days |

## Common workflows

**Payment charged but no ticket.** Look up the booking by reference/email → check
`Payment.status` and webhook receipt. If paid but not confirmed, re-drive reconciliation
(payments reconciliation console); if genuinely failed, confirm no charge with the provider
and advise retry. Every action is audited.

**Refund request.** Verify eligibility (confirmed booking, within the refund window — default
48h before session). Route to the organizer/finance console; communicate status
(REQUESTED → PROCESSING → COMPLETED). See [REFUND-POLICY.md](REFUND-POLICY.md).

**Can't access tickets.** Confirm login/email; tickets live under account → Tickets. For
offline/at-gate, guide to Event Day Mode. Resend confirmation if needed.

**Ticket transfer/sharing problem.** Check the share token's scope/expiry; revoke and reissue
if needed.

**Organizer onboarding/payout.** Route to organizer escalation; verify merchant onboarding
state and reconciliation (see [MERCHANT-ONBOARDING.md](../guides/MERCHANT-ONBOARDING.md)).

**Privacy / data request (DSAR).** Until the self-serve export/erasure workflow ships
(follow-up), handle manually: verify identity, locate the user's data per the
[Privacy Policy](PRIVACY-POLICY.md) data map, and fulfill within the legal window.

**Incident (platform-wide).** Escalate to on-call per [INCIDENT-RESPONSE.md](../launch/INCIDENT-RESPONSE.md);
use maintenance mode if needed; keep a status update cadence.

## Tools support agents use
- Admin console: reports, ops health, audit trail, payment config.
- Booking/payment lookup, reconciliation console, refunds console.
- Correlation IDs in logs to trace a specific request end to end.

## Escalation ladder
Tier 1 (support) → Tier 2 (senior support / ops) → Engineering on-call (P1/incidents) →
Finance (payouts/settlement) / Legal (privacy/disputes).
