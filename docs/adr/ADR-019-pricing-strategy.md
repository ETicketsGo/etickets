# ADR-019: Pricing Strategy

- **Status:** Accepted
- **Date:** 2026-07-13
- **Relates to:** ADR-010 (Inventory Strategy)
- **Scope:** Pricing Platform sprint (one concern, one PR)

## Context

Line pricing (the booking subtotal) was computed inline in `BookingsService`
(`subtotal += ticketType.priceMinor × qty`), and coupon math lived there too.
The platform needs pluggable pricing (tiered, seat-based, weekend/holiday/member/
early-bird surcharges & discounts, and flag-gated dynamic pricing) — without
changing any current price.

## Decision

Introduce a `PricingStrategy` seam that the booking engine calls to price lines,
mirroring the Inventory Strategy pattern (ADR-010).

- **Base strategies** resolve the unit price: `FlatPricingStrategy`,
  `TierPricingStrategy` (events), `SeatPricingStrategy` (movies). All return the
  ticket type's face price for the current data, so the subtotal is **byte-for-byte
  identical** to before — this is the backward-compatibility guarantee.
- **`PricingStrategiesService`** resolves the strategy by experience type
  (EVENT→TIER, MOVIE→SEAT) and produces a `PricingQuote` (per-line unit +
  subtotal). The booking engine depends only on this service; it no longer inlines
  price arithmetic.
- **Pricing rules** (`WeekendPricingRule`, `HolidayPricingRule`,
  `EarlyBirdPricingRule`, `MemberPricingRule`, `DynamicPricingRule`) are pure,
  composable adjustments applied on top of the base price. They are the pricing
  extension surface — fully implemented and unit-tested, but `rulesFor()` returns
  an **empty list by default**, so no existing experience's price changes. Rules
  become active only via a future per-experience pricing configuration; dynamic
  pricing is additionally gated by the `dynamicPricing` feature flag and ships as a
  factor-1 no-op (a real demand model binds in later).
- **Coupon math** is centralized in `computeCouponDiscountMinor` (percent/fixed,
  capped at subtotal) and reused by `BookingsService.resolveCoupon` — one
  implementation, identical behaviour.

Fee calculation (`PricingService.quote`, the DB fee tiers) is unchanged and
orthogonal — it operates on the subtotal the strategy produces.

## Consequences

**Positive**

- New pricing behaviour is added by a strategy/rule + a config entry, with zero
  booking-engine changes — open/closed, matching the inventory seam.
- Backward compatible by construction (base price = face price; no rules by
  default); proven by tests asserting the original subtotal.
- Coupon math no longer duplicated.

**Negative / trade-offs**

- Rules have no live activation path until a per-experience pricing-config feature
  lands (schema); they are the intended extension surface, unit-tested, not dead
  arithmetic. Documented rather than speculatively wired.
- No tax model exists; the strategy interface deliberately omits tax rather than
  fabricate one — added when a real tax requirement appears.

## Verification

Base strategies + resolver reproduce the original subtotal (tests); each rule’s
apply/adjust is unit-tested; coupon math centralized and tested. lint, typecheck,
unit tests, madge (no cycles), build, and e2e all green.
