# ADR-017: Sponsor Management

- **Status:** Proposed (foundation only)
- **Date:** 2026-07-13
- **Scope:** PR-4 — architecture/flag only

## Context

The roadmap includes sponsor management: sponsors, packages, booths, invoices,
assets, brand visibility, benefits, reports and payments. None of it has a
consumer yet.

## Decision

Represent sponsor management as a **feature-flagged capability** (`sponsors`,
default off), surfaced through the organizer Premium & enterprise page and the
`GET /capabilities` endpoint — the same non-dead-code pattern as CRM (ADR-015).
No sponsor tables or services are created until the capability is prioritised;
when built it reuses the existing money/payment primitives (fee snapshots,
payouts, invoices) rather than inventing a parallel billing stack.

## Consequences

- Capability is declared and toggleable with zero unfinished code.
- A future PR adds the schema + services behind the flag, reusing commerce
  primitives.
