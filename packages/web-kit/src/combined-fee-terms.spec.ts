import { describe, expect, it } from 'vitest';
import { combinedFeeTerms, type PlatformFeeBreakdown } from './price-breakdown';

/** The "3% + Rs 5.00 per ticket" line under the platform fee: shown only when it is exact. */
describe('combinedFeeTerms', () => {
  const breakdown: PlatformFeeBreakdown = {
    type: 'COMBINED',
    percentBps: 300,
    fixedPerTicketMinor: 500,
    ticketCount: 3,
    percentPartMinor: 9_000,
    fixedPartMinor: 1_500,
  };

  it('explains a fee the customer pays in full', () => {
    expect(
      combinedFeeTerms({
        bookingFeeMinor: 10_500,
        paymentFeeMinor: 6_210,
        customerFeeMinor: 16_710,
        platformFeeBreakdown: breakdown,
      }),
    ).toEqual({ percent: '3%', fixedPerTicketMinor: 500, ticketCount: 3 });
  });

  it('keeps decimals in a fractional rate', () => {
    expect(
      combinedFeeTerms({
        bookingFeeMinor: 125 + 500,
        paymentFeeMinor: 0,
        platformFeeBreakdown: {
          ...breakdown,
          percentBps: 125,
          ticketCount: 1,
          percentPartMinor: 125,
          fixedPartMinor: 500,
        },
      })?.percent,
    ).toBe('1.25%');
  });

  it('says nothing when the organizer pays some or all of the fee', () => {
    expect(
      combinedFeeTerms({
        bookingFeeMinor: 10_500,
        paymentFeeMinor: 6_210,
        customerFeeMinor: 8_355,
        platformFeeBreakdown: breakdown,
      }),
    ).toBeNull();
  });

  it('says nothing when the parts no longer add up to the fee (a cap lowered it)', () => {
    expect(
      combinedFeeTerms({
        bookingFeeMinor: 1_000,
        paymentFeeMinor: 0,
        platformFeeBreakdown: breakdown,
      }),
    ).toBeNull();
  });

  it('says nothing for any other fee', () => {
    expect(combinedFeeTerms({ bookingFeeMinor: 2_000, paymentFeeMinor: 0 })).toBeNull();
    expect(
      combinedFeeTerms({ bookingFeeMinor: 2_000, paymentFeeMinor: 0, platformFeeBreakdown: null }),
    ).toBeNull();
  });
});
