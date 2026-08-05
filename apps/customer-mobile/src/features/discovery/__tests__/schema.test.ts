import { discoverySchema, eventPageSchema } from '../schema';
import { bookingPageSchema, bookingTone, ticketSchema } from '@/features/bookings/schema';

/**
 * These fixtures are REAL responses captured from the QA API on 2026-08-04, trimmed
 * only of ids. They exist so that a contract change on the API side fails here — in a
 * test naming the endpoint — instead of on a phone in a queue.
 */

const discoveryResponse = {
  nowShowing: [
    {
      id: 'mv_1',
      title: 'Interstellar Re-release',
      slug: 'interstellar-re-release',
      posterUrl: 'https://cdn.example.com/p.jpg',
      certificate: 'UA',
      language: 'English',
      genres: ['Sci-Fi', 'Drama', 'Adventure'],
      runtimeMinutes: 169,
    },
  ],
  trendingEvents: [
    {
      id: 'ev_1',
      title: 'Standup Night with Zomato Comedy',
      slug: 'standup-night-with-zomato-comedy',
      category: 'Comedy',
      venue: { name: 'Phoenix Arena', city: 'Bengaluru', country: 'India' },
      organizer: 'Bengaluru Live',
      nextSessionAt: '2026-08-15T20:42:17.541Z',
      fromPriceMinor: 79900,
      currency: 'INR',
    },
  ],
  thisWeekend: [],
  categories: ['Comedy', 'Music', 'Tech'],
};

describe('discovery contract', () => {
  it('parses the live /public/discovery response', () => {
    const parsed = discoverySchema.parse(discoveryResponse);

    expect(parsed.nowShowing[0].genres).toHaveLength(3);
    expect(parsed.trendingEvents[0].venue.city).toBe('Bengaluru');
    // An empty shelf is valid data, not an error — the Home screen hides the section.
    expect(parsed.thisWeekend).toEqual([]);
  });

  it('accepts an event with no scheduled session and no price', () => {
    // Announced-but-not-on-sale events come back with both fields null. Treating them
    // as required would blank the whole Trending shelf over one unscheduled event.
    const parsed = eventPageSchema.parse({
      data: [
        {
          ...discoveryResponse.trendingEvents[0],
          nextSessionAt: null,
          fromPriceMinor: null,
        },
      ],
      meta: { page: 1, pageSize: 20, total: 1, totalPages: 1 },
    });

    expect(parsed.data[0].nextSessionAt).toBeNull();
    expect(parsed.data[0].fromPriceMinor).toBeNull();
  });

  it('rejects a response missing the venue', () => {
    const broken = {
      ...discoveryResponse,
      trendingEvents: [{ ...discoveryResponse.trendingEvents[0], venue: undefined }],
    };

    expect(() => discoverySchema.parse(broken)).toThrow();
  });

  it('rejects a price sent as a formatted string instead of minor units', () => {
    // The failure this guards: "₹799.00" would coerce to NaN in arithmetic and render
    // as a nonsense total rather than failing loudly.
    const broken = {
      ...discoveryResponse,
      trendingEvents: [{ ...discoveryResponse.trendingEvents[0], fromPriceMinor: '₹799.00' }],
    };

    expect(() => discoverySchema.parse(broken)).toThrow();
  });
});

describe('booking contract', () => {
  const booking = {
    id: 'bk_1',
    eventId: 'ev_1',
    eventSessionId: 'es_1',
    reference: null,
    buyerName: 'Test Customer',
    buyerEmail: 'customer1@eticketsgo.test',
    status: 'PENDING_PAYMENT',
    currency: 'INR',
    subtotalMinor: 79900,
    bookingFeeMinor: 1500,
    paymentFeeMinor: 1628,
    discountMinor: 0,
    customerFeeMinor: 3128,
    totalMinor: 83028,
    holdExpiresAt: '2026-08-04T07:48:40.722Z',
    confirmedAt: null,
    cancelledAt: null,
    createdAt: '2026-08-04T07:38:40.722Z',
    event: { title: 'Standup Night', slug: 'standup-night' },
    eventSession: { startsAt: '2026-08-15T20:42:17.541Z' },
    _count: { tickets: 1 },
  };

  it('parses the live /bookings response and keeps money in minor units', () => {
    const parsed = bookingPageSchema.parse({
      data: [booking],
      meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
    });

    // 79900 + 3128 = 83028. If any of these were ever divided by 100 on the way in,
    // this is where it would show.
    expect(parsed.data[0].subtotalMinor + parsed.data[0].customerFeeMinor).toBe(
      parsed.data[0].totalMinor,
    );
  });

  it('rejects a fractional minor amount', () => {
    // 799.5 paise is not a thing; if it appears, something upstream divided already.
    expect(() =>
      bookingPageSchema.parse({
        data: [{ ...booking, totalMinor: 830.28 }],
        meta: { page: 1, pageSize: 50, total: 1, totalPages: 1 },
      }),
    ).toThrow();
  });

  it('maps booking statuses to the right visual tone', () => {
    expect(bookingTone('CONFIRMED')).toBe('success');
    expect(bookingTone('PENDING_PAYMENT')).toBe('neutral');
    expect(bookingTone('CANCELLED')).toBe('error');
    expect(bookingTone('EXPIRED')).toBe('error');
    // An unknown status from a newer API must render, not crash the list.
    expect(bookingTone('SOME_FUTURE_STATE')).toBe('neutral');
  });
});

describe('ticket contract', () => {
  it('parses a ticket and exposes the server-rendered QR image', () => {
    const parsed = ticketSchema.parse({
      id: 't_1',
      serial: 'TKT-0001',
      status: 'VALID',
      holderName: 'Test Customer',
      ticketType: 'General',
      event: { title: 'Standup Night', slug: 'standup-night' },
      startsAt: '2026-08-15T20:42:17.541Z',
      qrToken: 'signed.payload.value',
      qrDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      bookingId: 'bk_1',
      bookingRef: 'ETG-IN-2026-000123',
      experienceType: 'EVENT',
      seatLabel: null,
      venueName: 'Phoenix Arena',
      screenName: null,
      cinemaName: null,
      assignmentStatus: 'ASSIGNED',
      attendeeName: 'Test Customer',
      ownedByViewer: true,
      assignedToViewer: true,
    });

    // The display path is the data URI. The token is present on the type but is never
    // what gets rendered — see the comment in ticket-qr.tsx.
    expect(parsed.qrDataUrl.startsWith('data:image')).toBe(true);
  });
});
