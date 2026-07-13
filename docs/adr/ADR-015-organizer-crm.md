# ADR-015: Organizer CRM

- **Status:** Proposed (foundation only)
- **Date:** 2026-07-13
- **Relates to:** ADR-018 (AI Foundations), feature-flag architecture
- **Scope:** PR-4 — architecture/flag only, no live implementation

## Context

The roadmap calls for an organizer CRM: attendee history, repeat visitors,
segments, coupons/discount rules, email/WhatsApp campaigns, memberships, VIP
clubs, loyalty, customer notes and lifetime value. Building all of this now would
create large amounts of code with no consumer.

## Decision

Represent CRM as a **feature-flagged capability**, not dead code. The
`organizerCrm` (and related `marketingAutomation`, `memberships`,
`subscriptions`) flags default off and are surfaced through the existing
organizer **Premium & enterprise** page (driven by `ENTERPRISE_FEATURES`), which
reads live flag state via `isFeatureEnabled` and the `GET /capabilities`
endpoint. No empty service classes are created until a flag has a real consumer.

When CRM is built, it lands behind these flags with clean services and reuses
existing data: bookings/tickets already encode attendee history; reviews and
follows encode engagement; the AI ports (ADR-018) provide segmentation/copilot
extension points.

## Consequences

- The capability is visible and toggleable without shipping unfinished code.
- Data foundations (attendees, engagement) already exist to build on.
- Actual CRM services arrive in a dedicated PR, flag-gated, when prioritised.
