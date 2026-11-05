# ETicketsGo — Pricing & Platform-Fee Configuration

How ETicketsGo charges fees, and how an organizer configures who pays them. This
documents the **existing** fee engine (`apps/api/src/pricing/`) — no behavior changes.

## Current fee model (2026-10-30)

The booking (platform) fee is a set of bands per currency, country and region (`FeeRule`). Each
band uses one fee type:

| Fee type           | Charges                                          | Example              |
| ------------------ | ------------------------------------------------ | -------------------- |
| `FLAT`             | A fixed amount once per order                    | Rs 20 per order      |
| `FIXED_PER_TICKET` | A fixed amount for each paid ticket              | Rs 5 x 3 = Rs 15     |
| `PERCENT`          | A percentage of the order                        | 3%                   |
| `COMBINED`         | A percentage plus a fixed amount per paid ticket | 3% + Rs 5 per ticket |

Any band can have an optional minimum and maximum fee. Free events pay no fee. An event override
beats an organizer override, which beats the published schedule (`PlatformFeePolicy`).

Admins change the schedule only through a draft: edit, validate, preview, then publish. Publish
needs admin MFA, writes every band in one transaction and keeps the draft as a version; every
draft save and publish is audited. A quote carries the schedule version, and a booking is refused
if the schedule changed after the quote. The tiered defaults below are the original seed values,
not the production schedule. Status per item: [../PRODUCT-CURRENT-STATE.md](../PRODUCT-CURRENT-STATE.md).

## Fee components

Every booking's fees are computed deterministically in integer minor units
([fee-calculator.ts](../../apps/api/src/pricing/fee-calculator.ts)):

| Component                  | Default                                      | Notes                                                     |
| -------------------------- | -------------------------------------------- | --------------------------------------------------------- |
| **Booking fee**            | Tiered by net subtotal (`DEFAULT_FEE_TIERS`) | The platform's per-order fee; zero on a zero-value order. |
| **Payment-processing fee** | 2.00% (`DEFAULT_PAYMENT_FEE_BPS = 200`)      | Applied to (net subtotal + booking fee).                  |
| **Discounts**              | Coupon-driven                                | Applied to the subtotal before fees.                      |

Fee tiers are overridable per platform via pricing rules
([pricing.service.ts](../../apps/api/src/pricing/pricing.service.ts)); the defaults apply
when no rule exists.

## Fee modes (who pays)

Set per event via `feeMode`:

| Mode               | Customer pays                  | Organizer nets                     |
| ------------------ | ------------------------------ | ---------------------------------- |
| **CUSTOMER_PAYS**  | Ticket price + all fees        | Full ticket price                  |
| **ORGANIZER_PAYS** | Ticket price only              | Ticket price − all fees            |
| **SHARED**         | Ticket price + a share of fees | Ticket price − the remaining share |

The buyer always sees the exact total before paying; fee snapshots are immutable once a
booking is created (money transitions are auditable and idempotent).

## Configuring fees as an organizer

1. Choose the **fee mode** when creating/editing an event (pricing step).
2. Set **ticket-type prices** per tier; inventory is tracked per type.
3. Optional: create **coupons** (percentage or fixed) with limits/expiry.
4. Preview the buyer-facing total (quote endpoint) before publishing.

## Payouts & settlement

Organizer proceeds settle through the payouts/finance module (see
[MERCHANT-ONBOARDING.md](../guides/MERCHANT-ONBOARDING.md) and
[PAYMENT-PLATFORM.md](../guides/PAYMENT-PLATFORM.md)); reconciliation discrepancies are
tracked in the finance console. Live payouts require an ACTIVE merchant account and
completed onboarding.

## Currency

Amounts are stored and computed in integer **minor units** with a per-booking currency
(default `INR`). Multi-currency routing is handled by the payments layer per country; see
[INTERNATIONAL-READINESS.md](../guides/INTERNATIONAL-READINESS.md).

> **Note:** Fee _rates and tiers_ are commercial policy. The values above are the shipped
> defaults; confirm your commercial pricing before onboarding paying organizers.
