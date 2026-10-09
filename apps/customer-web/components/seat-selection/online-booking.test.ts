import { describe, expect, it } from 'vitest';
import { ApiRequestError, type SeatLayoutResponse } from '@eticketsgo/web-kit';
import en from '@eticketsgo/i18n/messages/en/storefront.json';
import frCA from '@eticketsgo/i18n/messages/fr-CA/storefront.json';
import { bookingFailure, closeSeatsNotForSale, isSaleNotOpen } from './online-booking';

/*
  QA, 2026-10-09: seats stayed selectable for a show nobody could buy, and the refusal was a
  toast that vanished. These pin what the seat page does with the server's answer.
*/

const layout = {
  view: 'seats',
  layoutKind: 'GRID',
  country: 'India',
  focal: null,
  categories: [
    { id: 'cat-std', name: 'Standard', priceMinor: 15_000, ticketTypeId: 'tt-std' },
    { id: 'cat-gold', name: 'Gold', priceMinor: 20_000, ticketTypeId: 'tt-gold' },
  ],
  sections: [
    {
      id: 's1',
      name: 'Main',
      shape: null,
      tier: null,
      rotationDeg: 0,
      rows: [
        {
          label: 'A',
          seats: [
            {
              id: 'a1',
              label: '1',
              colIndex: 1,
              categoryId: 'cat-std',
              kind: 'STANDARD',
              status: 'AVAILABLE',
            },
            {
              id: 'a2',
              label: '2',
              colIndex: 2,
              categoryId: 'cat-gold',
              kind: 'STANDARD',
              status: 'AVAILABLE',
            },
            {
              id: 'a3',
              label: '3',
              colIndex: 3,
              categoryId: 'cat-gold',
              kind: 'STANDARD',
              status: 'SOLD',
            },
          ],
        },
      ],
    },
  ],
} as unknown as SeatLayoutResponse;

const statuses = (l: SeatLayoutResponse | undefined) =>
  l && l.view === 'seats' ? l.sections[0].rows[0].seats.map((s) => s.status) : [];

describe('seats a buyer cannot buy online', () => {
  it('leaves an open show exactly as the server sent it', () => {
    expect(closeSeatsNotForSale(layout, false, new Set())).toBe(layout);
  });

  it('makes every free seat unavailable when the show is closed', () => {
    expect(statuses(closeSeatsNotForSale(layout, true, new Set()))).toEqual([
      'BLOCKED',
      'BLOCKED',
      'SOLD',
    ]);
  });

  it('closes only the ticket types that cannot be sold, so the rest of the room sells', () => {
    expect(statuses(closeSeatsNotForSale(layout, false, new Set(['tt-std'])))).toEqual([
      'BLOCKED',
      'AVAILABLE',
      'SOLD',
    ]);
  });

  it('does not touch the layout it was given', () => {
    closeSeatsNotForSale(layout, true, new Set());
    expect(statuses(layout)).toEqual(['AVAILABLE', 'AVAILABLE', 'SOLD']);
  });
});

describe('what the buyer reads when paying fails', () => {
  const refusal = new ApiRequestError(
    'VALIDATION_FAILED',
    'Online booking is not open for this show yet. Please check back later or contact the venue.',
    { reason: 'SALE_NOT_OPEN', blockers: ['NO_PRICING_POLICY'] },
  );

  it('recognises the not-open refusal by its reason, not its words', () => {
    expect(isSaleNotOpen(refusal)).toBe(true);
    expect(isSaleNotOpen(new ApiRequestError('VALIDATION_FAILED', 'x', {}))).toBe(false);
    expect(isSaleNotOpen(new Error('x'))).toBe(false);
  });

  it('words the refusal itself, in the buyer language', () => {
    expect(bookingFailure(refusal)).toEqual({ key: 'salesClosedBody' });
  });

  it('keeps the server sentence for any other refusal, and has words when there is none', () => {
    expect(bookingFailure(new ApiRequestError('CONFLICT', 'Seat A4 was just taken.'))).toEqual({
      message: 'Seat A4 was just taken.',
    });
    expect(bookingFailure(new ApiRequestError('CONFLICT', ''))).toEqual({ key: 'bookingFailed' });
    expect(bookingFailure(new Error('network'))).toEqual({ key: 'seatTaken' });
  });

  it.each([
    ['en', en],
    ['fr-CA', frCA],
  ])('has the plain buyer copy in %s, naming no regulation and no code', (_locale, messages) => {
    const seats = (messages as unknown as { seats: Record<string, string> }).seats;
    for (const key of ['salesClosedTitle', 'salesClosedBody', 'bookingFailed']) {
      expect(seats[key]).toBeTruthy();
      expect(seats[key]).not.toMatch(/regulat|r.glement|Telangana|polic|G\.O\.|SALE_NOT_OPEN/i);
    }
  });

  it('says exactly the agreed English sentence', () => {
    expect((en as unknown as { seats: Record<string, string> }).seats.salesClosedBody).toBe(
      'Online booking is not open for this show yet. Please check back later or contact the venue.',
    );
  });
});
