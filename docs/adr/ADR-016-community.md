# ADR-016: Community

- **Status:** Accepted
- **Date:** 2026-07-13
- **Scope:** PR-4 — consolidation of existing community features

## Context

Community features (follow organizer/venue, reviews, ratings, saved experiences,
recently viewed, organizer profiles, verified badges) were shipped incrementally
across earlier work. They existed but weren't presented as a coherent surface.

## Decision

Treat community as a first-class, shipped capability (`community` flag, default
on) and **consolidate the existing pieces** rather than rebuild them:
- Reviews/ratings — existing, booking-gated (ADR from prior work).
- Saved experiences — existing `etg_saved` store + `/account/saved`.
- Follow organizer — existing `etg_following` store + organizer profiles; PR-4
  adds `/account/following` to surface followed organizers coherently.
- Organizer profiles + verified badge — existing `GET /public/organizers/:id`.
- Recently viewed / trending — existing.

Future items (activity feed, collections, follow-venue) are noted as extensions;
they are not built until needed, keeping the surface free of placeholders.

## Consequences

- No duplication: PR-4 adds only the connective surface (`/account/following`)
  and links from the account hub.
- Community becomes discoverable as a coherent whole while reusing every existing
  store and endpoint.
