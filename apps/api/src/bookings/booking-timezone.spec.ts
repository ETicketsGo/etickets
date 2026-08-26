import { BookingsService } from './bookings.service';

/**
 * Which clock a booking is displayed in.
 *
 * ── THE DEFECT, AND THE HALF-FIX THAT FOLLOWED IT ──────────────────────────────────
 * A ticket said 9:28 pm while its confirmation said 8:58 am the next day. Both rendered the
 * same instant: the pages used the reader's browser zone, the notification used a hardcoded
 * one.
 *
 * The first fix routed everything through the venue's zone — but read it only from the
 * screen's CINEMA. Cinemas have carried a zone since the theater work; ordinary venues had
 * none, so every non-cinema event still fell through to null and back to the reader's
 * browser. That is most events, and the bug looked fixed from a movie booking.
 */
function serviceWith(booking: unknown) {
  const prisma = {
    booking: { findUnique: jest.fn().mockResolvedValue(booking) },
    showSeat: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const stub = {} as never;
  return new BookingsService(prisma as never, stub, stub, stub, stub, stub, stub, stub, stub);
}

const USER = { id: 'u-1', email: 'a@t.test', fullName: 'A', roles: [] } as never;

const booking = (over: { cinemaTz?: string | null; venueTz?: string | null }) => ({
  id: 'bk-1',
  userId: 'u-1',
  tickets: [],
  taxLines: [],
  items: [],
  event: {
    title: 'Show',
    slug: 's',
    refundsEnabled: true,
    refundCutoffHours: 48,
    venue: over.venueTz === null ? null : { timezone: over.venueTz ?? 'Asia/Kolkata' },
  },
  eventSession: {
    startsAt: new Date('2026-08-26T03:28:00Z'),
    screen: over.cinemaTz ? { cinema: { timezone: over.cinemaTz } } : null,
  },
});

describe('booking timezone resolution', () => {
  it('prefers the cinema, which is the most specific fact about where it plays', async () => {
    const svc = serviceWith(booking({ cinemaTz: 'America/Chicago', venueTz: 'Asia/Kolkata' }));
    expect((await svc.getForUser(USER, 'bk-1')).timeZone).toBe('America/Chicago');
  });

  it('falls back to the venue for an event that is not a cinema showing', async () => {
    // The case the first fix missed, and the majority of events on the platform.
    const svc = serviceWith(booking({ venueTz: 'America/New_York' }));
    expect((await svc.getForUser(USER, 'bk-1')).timeZone).toBe('America/New_York');
  });

  it('returns null rather than a guess when neither is known', async () => {
    // A wrong zone is worse than none: the caller can fall back visibly, but it cannot tell
    // that a confidently-returned zone was invented.
    const svc = serviceWith(booking({ venueTz: null }));
    expect((await svc.getForUser(USER, 'bk-1')).timeZone).toBeNull();
  });
});
