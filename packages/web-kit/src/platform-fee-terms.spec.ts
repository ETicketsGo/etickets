import { describe, expect, it } from 'vitest';
import { combinedFeeTerms, platformFeeTerms, type PlatformFeeBreakdown } from './price-breakdown';

/**
 * The terms line under the platform fee, for both per-ticket types: "Rs 5.00 per ticket, for 3
 * tickets" (FIXED_PER_TICKET) or "3% of the tickets + Rs 5.00 per ticket, for 3 tickets"
 * (COMBINED). Shown only when it explains the fee exactly.
 */
describe('platformFeeTerms', () => {
  const perTicket: PlatformFeeBreakdown = {
    type: 'FIXED_PER_TICKET',
    percentBps: 0,
    fixedPerTicketMinor: 500,
    ticketCount: 3,
    percentPartMinor: 0,
    fixedPartMinor: 1_500,
  };

  it('explains a FIXED_PER_TICKET fee the customer pays in full', () => {
    expect(
      platformFeeTerms({
        bookingFeeMinor: 1_500,
        paymentFeeMinor: 6_030,
        customerFeeMinor: 7_530,
        platformFeeBreakdown: perTicket,
      }),
    ).toEqual({ type: 'FIXED_PER_TICKET', fixedPerTicketMinor: 500, ticketCount: 3 });
  });

  it('a FIXED_PER_TICKET fee is not described as a combined one', () => {
    expect(
      combinedFeeTerms({
        bookingFeeMinor: 1_500,
        paymentFeeMinor: 0,
        platformFeeBreakdown: perTicket,
      }),
    ).toBeNull();
  });

  it('says nothing when a minimum raised the fee', () => {
    expect(
      platformFeeTerms({
        bookingFeeMinor: 2_000,
        paymentFeeMinor: 0,
        platformFeeBreakdown: {
          ...perTicket,
          minFeeMinor: 2_000,
          maxFeeMinor: null,
          limitApplied: 'MIN',
        },
      }),
    ).toBeNull();
  });

  it('says nothing when a maximum lowered the fee', () => {
    expect(
      platformFeeTerms({
        bookingFeeMinor: 1_000,
        paymentFeeMinor: 0,
        platformFeeBreakdown: { ...perTicket, maxFeeMinor: 1_000, limitApplied: 'MAX' },
      }),
    ).toBeNull();
  });

  it('still explains the fee when a limit exists but did not change it', () => {
    expect(
      platformFeeTerms({
        bookingFeeMinor: 1_500,
        paymentFeeMinor: 0,
        platformFeeBreakdown: { ...perTicket, maxFeeMinor: 9_000, limitApplied: null },
      }),
    ).toMatchObject({ type: 'FIXED_PER_TICKET', ticketCount: 3 });
  });

  it('says nothing when the organizer pays some of the fee', () => {
    expect(
      platformFeeTerms({
        bookingFeeMinor: 1_500,
        paymentFeeMinor: 100,
        customerFeeMinor: 800,
        platformFeeBreakdown: perTicket,
      }),
    ).toBeNull();
  });

  it('keeps describing COMBINED fees as before', () => {
    expect(
      platformFeeTerms({
        bookingFeeMinor: 10_500,
        paymentFeeMinor: 0,
        platformFeeBreakdown: {
          type: 'COMBINED',
          percentBps: 300,
          fixedPerTicketMinor: 500,
          ticketCount: 3,
          percentPartMinor: 9_000,
          fixedPartMinor: 1_500,
        },
      }),
    ).toEqual({ type: 'COMBINED', percent: '3%', fixedPerTicketMinor: 500, ticketCount: 3 });
  });
});
