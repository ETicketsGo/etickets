import {
  bookingDetailSchema,
  bookingStatusLabel,
  bookingTone,
  isLiveBooking,
  ticketState,
} from '../schema';
import { PAYMENT_POLL_INTERVAL_MS, PAYMENT_POLL_WINDOW_MS, paymentPollInterval } from '../api';

jest.mock('@/services/api-client', () => ({ apiClient: { get: jest.fn() } }));

/** Trimmed from a real QA GET /bookings/:id response (2026-10-24). */
const qaDetail = {
  id: 'cmvlxr849004b9n2oofe754su',
  eventId: 'cmv6mcnx60108118ooasz7964',
  eventSessionId: 'cmv6mco1r010d118o2juqpwvc',
  reference: 'ETG-IND-2026-000069',
  buyerName: 'Riya Rao',
  buyerEmail: 'customer1@eticketsgo.test',
  status: 'CONFIRMED',
  currency: 'INR',
  subtotalMinor: 149900,
  bookingFeeMinor: 2000,
  paymentFeeMinor: 3038,
  discountMinor: 0,
  customerFeeMinor: 5038,
  totalMinor: 154938,
  holdExpiresAt: '2026-10-24T05:15:49.752Z',
  confirmedAt: '2026-10-24T05:06:37.692Z',
  cancelledAt: null,
  createdAt: '2026-10-24T05:05:49.785Z',
  payment: { provider: 'razorpay', status: 'SUCCEEDED' },
  tickets: [{ id: 't1' }],
  event: {
    id: 'cmv6mcnx60108118ooasz7964',
    title: 'Slow Coffee: A Home Brewing Masterclass',
    slug: 'slow-coffee-a-home-brewing-masterclass-144d29',
    venue: { timezone: 'Asia/Kolkata', country: 'IN', name: 'The Roastery Room', city: 'Bengaluru' },
  },
  eventSession: { id: 'cmv6mco1r010d118o2juqpwvc', startsAt: '2026-11-15T05:00:00.000Z' },
};

describe('booking detail', () => {
  it('parses the real QA detail response, which has no _count', () => {
    const parsed = bookingDetailSchema.parse(qaDetail);
    expect(parsed.tickets).toHaveLength(1);
    expect(parsed.payment?.status).toBe('SUCCEEDED');
  });

  it('parses an unpaid booking with no payment and no tickets yet', () => {
    const parsed = bookingDetailSchema.parse({
      ...qaDetail,
      status: 'PENDING_PAYMENT',
      reference: null,
      payment: null,
      tickets: undefined,
    });
    expect(parsed.tickets).toEqual([]);
  });
});

describe('payment polling', () => {
  const t0 = 1_000_000;

  it('polls only while the booking waits for payment', () => {
    expect(paymentPollInterval('PENDING_PAYMENT', t0, t0 + 1000)).toBe(PAYMENT_POLL_INTERVAL_MS);
    expect(paymentPollInterval('CONFIRMED', t0, t0 + 1000)).toBe(false);
    expect(paymentPollInterval(undefined, t0, t0)).toBe(false);
  });

  it('stops after the window so an abandoned booking does not poll for ever', () => {
    expect(paymentPollInterval('PENDING_PAYMENT', t0, t0 + PAYMENT_POLL_WINDOW_MS + 1)).toBe(
      false,
    );
  });
});

describe('statuses the API actually sends', () => {
  it('shows an ACTIVE ticket as valid with its code', () => {
    // The app tested for "VALID", which the API never sends.
    expect(ticketState('ACTIVE')).toEqual({ label: 'Valid', tone: 'success', showCode: true });
  });

  it.each(['REFUNDED', 'CANCELLED', 'VOID', 'TRANSFERRED', 'CHECKED_IN', 'SOMETHING_NEW'])(
    'never shows a code for a %s ticket',
    (status) => {
      expect(ticketState(status).showCode).toBe(false);
    },
  );

  it('treats a refunded booking as past, not upcoming', () => {
    expect(isLiveBooking('REFUNDED')).toBe(false);
    expect(isLiveBooking('PARTIALLY_REFUNDED')).toBe(true);
  });

  it('gives the refund and dispute states a tone and words', () => {
    expect(bookingTone('PARTIALLY_REFUNDED')).toBe('warning');
    expect(bookingTone('DISPUTED')).toBe('warning');
    expect(bookingStatusLabel('PENDING_PAYMENT')).toBe('Waiting for payment');
  });
});
