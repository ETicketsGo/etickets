# ADR-018: AI Foundations

- **Status:** Accepted (extension interfaces only)
- **Date:** 2026-07-13
- **Relates to:** ADR-014 (Experience Discovery)
- **Scope:** PR-4

## Context

The roadmap wants AI capabilities — recommendation engine, organizer copilot,
marketing assistant, pricing assistant, review moderation, search ranking — but
explicitly as _architecture only_, with no model-specific implementation yet.

## Decision

Introduce AI as a set of **extension ports** (interfaces) with dependency-
injection tokens and **no-op default implementations**, in `apps/api/src/ai`:

- `RecommendationEngine`, `SearchRanking`, `OrganizerCopilot`,
  `MarketingAssistant`, `PricingAssistant`, `ReviewModeration`.
- Each token is bound to a Noop (identity ranking / empty generation / allow-all
  moderation) in `AiModule`, which exports the tokens.
- Binding a real implementation is a one-line `useClass` swap in `AiModule` — no
  consumer changes.

To keep the ports live (not dead code), `DiscoveryService` (ADR-014) is a **real
consumer** of `RecommendationEngine`, calling `rankExperiences(userId, items)` on
its sections. Today the noop returns items unchanged; a future model-backed
binding personalises discovery with zero call-site changes. The `aiRecommendations`
flag governs when a non-noop binding is activated.

## Consequences

**Positive**

- The AI extension surface is defined and demonstrably wired, but carries no model
  dependency, cost, or vendor lock-in yet.
- Every future AI feature is a drop-in provider behind an existing port.

**Negative / trade-offs**

- Ports beyond `RecommendationEngine` have no live caller yet; they are published
  extension points (provided + exported + documented), justified as the intended
  architecture rather than speculative dead code. Callers arrive with their
  features.
