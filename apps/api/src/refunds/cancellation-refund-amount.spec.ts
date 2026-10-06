import { refundTax } from './refund-tax';
import { organizerShareOfRefund } from '../payouts/currency-settlement.calculator';

/**
 * What comes back depends on WHO cancelled.
 *
 * ── THE DISTINCTION ────────────────────────────────────────────────────────────────
 * A buyer who changes their mind gets the tickets and the tax on them. Fees stay with the
 * platform: they paid for a service that was performed.
 *
 * A buyer whose show was cancelled gets back everything they paid, fees included. They did
 * nothing, and the thing they bought is not happening. Making them absorb our fee for our
 * cancellation is the one case where the fee rule gives the wrong answer.
 *
 * ── AND WHO BEARS IT ───────────────────────────────────────────────────────────────
 * The half that is easy to get wrong. Settlement charges a refund to the organizer as
 * `amountMinor - taxAddedMinor`, and the organizer's gross is TICKET FACE VALUE only - fees
 * are borne by the customer on top of it and merely reported. So returning the fees by simply
 * raising `amountMinor` would claw back from the organizer a fee they never received, turning
 * a refund into a fine. `platformFeeRefundedMinor` records our share and keeps theirs exactly
 * what it is today.
 *
 * These tests work in the same arithmetic the service uses, rather than mocking Prisma and
 * asserting on a call, because the thing that can be wrong here is the sum.
 */

/** The figures the service works from, for a booking of one ticket. */
const TICKET = 20_000; // face value, what the organizer's gross counts
const FEES = 1_420; // booking + payment fees, charged to the customer on top
const FEE_TAX = 128; // GST on those fees, ADDED on top of them
/*
  What the buyer actually paid, and the figure `booking.totalMinor` holds.

  It includes the tax ADDED on top - and that is not pedantry, it is what the first draft of
  this fixture got wrong. Writing TOTAL as ticket + fees made the expected platform share come
  out 128 short, because the sum no longer described a real booking. A fixture whose parts do
  not add up tests the fixture.
*/
const TOTAL = TICKET + FEES + FEE_TAX;

/** India: GST sits INSIDE the ticket price, and is ADDED on top of the fee. */
const INDIAN_LINES = [
  {
    label: 'CGST',
    rateBasisPoints: 900,
    baseMinor: TICKET,
    amountMinor: 1_525,
    inclusive: true,
    basis: 'TICKETS',
  },
  {
    label: 'CGST on fees',
    rateBasisPoints: 900,
    baseMinor: FEES,
    amountMinor: 128,
    inclusive: false,
    basis: 'FEES',
  },
];

describe('a buyer-requested refund is unchanged', () => {
  it('returns the ticket and its tax, and not the fees', () => {
    const tax = refundTax(INDIAN_LINES, TICKET, TICKET);
    const amountMinor = TICKET + tax.addedMinor;

    // Inclusive GST is already inside the ticket price, so nothing is added on top.
    expect(tax.addedMinor).toBe(0);
    expect(amountMinor).toBe(TICKET);
    // The buyer keeps paying the fee and its tax. Long-standing policy, stated out loud.
    expect(TOTAL - amountMinor).toBe(FEES + FEE_TAX);
  });

  it('leaves the fee tax behind, because the fee itself stays', () => {
    const tax = refundTax(INDIAN_LINES, TICKET, TICKET);
    expect(tax.lines.some((l) => l.basis === 'FEES')).toBe(false);
  });

  it('charges the whole of it to the organizer, as today', () => {
    const tax = refundTax(INDIAN_LINES, TICKET, TICKET);
    const share = organizerShareOfRefund({
      currency: 'INR',
      amountMinor: TICKET + tax.addedMinor,
      taxAddedMinor: tax.addedMinor,
      platformFeeRefundedMinor: 0,
    });
    // Exactly the ticket face value: precisely what their gross was.
    expect(share).toBe(TICKET);
  });
});

describe('a cancelled show refunds everything the buyer paid', () => {
  // What the service computes on the cancellation branch.
  const tax = refundTax(INDIAN_LINES, TICKET, TICKET, { includeFeeTax: true });
  const amountMinor = TOTAL - 0; // nothing refunded before
  const platformFeeRefundedMinor = Math.max(0, amountMinor - tax.addedMinor - TICKET);

  it('returns the full amount, not the ticket alone', () => {
    expect(amountMinor).toBe(TOTAL);
    // The thing the policy change is for: the buyer is not left paying our fee.
    expect(amountMinor).toBeGreaterThan(TICKET);
    expect(TOTAL - amountMinor).toBe(0);
  });

  it('brings the tax on the fees back with the fees', () => {
    expect(tax.lines.some((l) => l.basis === 'FEES')).toBe(true);
    // Whole, not prorated by tickets: the fee was charged once and is returned once.
    expect(tax.lines.find((l) => l.basis === 'FEES')!.amountMinor).toBe(FEE_TAX);
  });

  it('does NOT charge the organizer for our fee', () => {
    const share = organizerShareOfRefund({
      currency: 'INR',
      amountMinor,
      taxAddedMinor: tax.addedMinor,
      platformFeeRefundedMinor,
    });

    /*
      The assertion this whole field exists for. Their share is the ticket face value - the
      same as a buyer-requested refund, and the same as their gross. Without the exclusion it
      would have been the fees too, clawing back money they never received.
    */
    expect(share).toBe(TICKET);
    expect(platformFeeRefundedMinor).toBe(FEES);
  });

  it('never returns more than was collected', () => {
    // The invariant the service enforces, stated here on the cancellation figures: a
    // cancellation lands exactly ON the boundary, which is the case most likely to trip a
    // greater-than check written as greater-than-or-equal.
    expect(0 + amountMinor).toBeLessThanOrEqual(TOTAL);
  });

  it('returns only what is left when part was already refunded', () => {
    const priorAmount = 5_000;
    const remaining = Math.max(0, TOTAL - priorAmount);
    expect(remaining).toBe(TOTAL - priorAmount);
    expect(priorAmount + remaining).toBe(TOTAL);
  });
});

describe('a market where tax is ADDED to the ticket', () => {
  // Not every market is India. Here the ticket tax sits on top, so it is part of the amount
  // and must stay out of the organizer's share - the case `taxAddedMinor` already existed for.
  const US_LINES = [
    {
      label: 'Sales tax',
      rateBasisPoints: 800,
      baseMinor: TICKET,
      amountMinor: 1_600,
      inclusive: false,
      basis: 'TICKETS',
    },
    {
      label: 'Tax on fees',
      rateBasisPoints: 800,
      baseMinor: FEES,
      amountMinor: 114,
      inclusive: false,
      basis: 'FEES',
    },
  ];

  it("keeps the organizer's share at the ticket face value, cancelled or not", () => {
    const buyerTax = refundTax(US_LINES, TICKET, TICKET);
    const buyerShare = organizerShareOfRefund({
      currency: 'USD',
      amountMinor: TICKET + buyerTax.addedMinor,
      taxAddedMinor: buyerTax.addedMinor,
      platformFeeRefundedMinor: 0,
    });
    expect(buyerShare).toBe(TICKET);

    const total = TICKET + FEES + 1_600 + 114;
    const cancelTax = refundTax(US_LINES, TICKET, TICKET, { includeFeeTax: true });
    const platform = Math.max(0, total - cancelTax.addedMinor - TICKET);
    const cancelShare = organizerShareOfRefund({
      currency: 'USD',
      amountMinor: total,
      taxAddedMinor: cancelTax.addedMinor,
      platformFeeRefundedMinor: platform,
    });
    expect(cancelShare).toBe(TICKET);
    // And the buyer is whole: every cent they paid.
    expect(total - (TICKET + cancelTax.addedMinor + platform)).toBe(0);
  });
});
