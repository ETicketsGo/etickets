import { NotificationType } from '@eticketsgo/shared-types';
import { ShowsService } from './shows.service';
import { channelsFor } from '../notifications/policy/channel-policy';
import { dedupeKeyFor } from '../notifications/policy/dedupe-key';

/**
 * Telling the people who already hold a ticket that the show has moved.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────
 * `rescheduleShow` updated the session, wrote an audit entry, and told nobody. A customer
 * who had paid found out by arriving at the old time; the operator saw a successful save and
 * had no reason to think otherwise. The audit trail recorded the change perfectly and the
 * only people it mattered to were the only people not informed.
 */

const NOW = new Date('2026-09-10T10:00:00Z');
const OLD_START = new Date('2026-09-20T13:30:00Z');
const NEW_START = new Date('2026-09-20T16:30:00Z');

const USER = {
  id: 'u-op',
  email: 'op@t.test',
  fullName: 'Op',
  roles: ['ORGANIZER_OWNER'],
} as never;

function setup(
  opts: {
    bookings?: { id: string; userId: string | null; buyerEmail: string; reference: string }[];
    status?: string;
  } = {},
) {
  const bookings = opts.bookings ?? [];
  const session = {
    id: 's-1',
    screenId: 'scr-1',
    startsAt: OLD_START,
    endsAt: new Date(OLD_START.getTime() + 120 * 60_000),
    status: opts.status ?? 'SCHEDULED',
    event: { organizationId: 'org-1', movieId: 'mv-1' },
  };

  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    eventSession: {
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...session, ...data })),
      // Overlap detection: an empty screen unless a test says otherwise.
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({
        screen: { cinema: { timezone: 'Asia/Kolkata' } },
        event: { title: 'Kalki', venue: { timezone: 'Asia/Kolkata' } },
      }),
    },
    booking: { findMany: jest.fn().mockResolvedValue(bookings) },
    showSeat: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
  };

  const prisma = {
    eventSession: { findUnique: jest.fn().mockResolvedValue(session) },
    movie: { findUnique: jest.fn().mockResolvedValue({ id: 'mv-1', runtimeMinutes: 120 }) },
    booking: {
      count: jest.fn().mockResolvedValue(bookings.length),
      findMany: jest.fn().mockResolvedValue(bookings),
    },
    ticket: { count: jest.fn().mockResolvedValue(0) },
    $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
  };

  const notifications = {
    send: jest.fn().mockResolvedValue(undefined),
    sendCritical: jest.fn().mockResolvedValue(undefined),
    fanOutCritical: jest.fn().mockResolvedValue(0),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new ShowsService(
    prisma as never,
    { assertMember: jest.fn().mockResolvedValue(undefined) } as never,
    audit as never,
    { get: jest.fn().mockReturnValue(15) } as never,
    notifications as never,
  );
  /*
    The scheduling policy and the ownership check are exercised in their own suites. Stubbing
    them here keeps these tests about the one thing they are for -- who gets told, and when --
    rather than re-deriving a whole authorization fixture.
  */
  jest
    .spyOn(service as never, 'authorizeOperation')
    .mockResolvedValue({ session, commitments: {}, idempotent: false } as never);

  return { service, prisma, tx, notifications, audit };
}

const booking = (n: number) => ({
  id: `bk-${n}`,
  userId: `u-${n}`,
  buyerEmail: `buyer${n}@example.test`,
  reference: `ETG-IN-2026-000${n}`,
});

beforeAll(() => jest.useFakeTimers().setSystemTime(NOW));
afterAll(() => jest.useRealTimers());

describe('who is told when a show moves', () => {
  it('tells nobody when nobody has booked', async () => {
    const { service, notifications, tx } = setup({ bookings: [] });
    await service.rescheduleShow(USER, 's-1', { startsAt: NEW_START, padMinutes: 0 } as never);

    // The move still happens. An empty house is not a reason to refuse a reschedule.
    expect(tx.eventSession.update).toHaveBeenCalled();
    expect(notifications.fanOutCritical).not.toHaveBeenCalled();
  });

  it('tells the one person who booked', async () => {
    const { service, notifications } = setup({ bookings: [booking(1)] });
    await service.rescheduleShow(USER, 's-1', { startsAt: NEW_START, padMinutes: 0 } as never);

    expect(notifications.fanOutCritical).toHaveBeenCalledTimes(1);
    const call = notifications.fanOutCritical.mock.calls[0][1];
    expect(call.type).toBe(NotificationType.SHOW_CHANGED);
    expect(call.recipients).toHaveLength(1);
    expect(call.recipients[0]).toMatchObject({ userId: 'u-1', toEmail: 'buyer1@example.test' });
  });

  it('tells everybody who booked, in one call', async () => {
    /*
      One call, not one per booking. This transaction holds a FOR UPDATE lock on the screen
      row and every other scheduling operation on that screen waits behind it; a sold-out
      house written one row at a time is hundreds of round trips with that lock held.
    */
    const { service, notifications, prisma } = setup({
      bookings: [booking(1), booking(2), booking(3)],
    });
    await service.rescheduleShow(USER, 's-1', { startsAt: NEW_START, padMinutes: 0 } as never);

    expect(notifications.fanOutCritical).toHaveBeenCalledTimes(1);
    expect(notifications.fanOutCritical.mock.calls[0][1].recipients).toHaveLength(3);
    // And no provider was contacted from inside the transaction; the worker delivers.
    expect(notifications.send).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('each recipient carries their OWN booking', async () => {
    // One person can hold two bookings on one show. Sharing a payload would name the same
    // booking in both, and the booking id is part of the dedupe subject — so the second
    // message would be discarded as a duplicate of the first.
    const { service, notifications } = setup({
      bookings: [
        { id: 'bk-a', userId: 'u-1', buyerEmail: 'same@example.test', reference: 'A' },
        { id: 'bk-b', userId: 'u-1', buyerEmail: 'same@example.test', reference: 'B' },
      ],
    });
    await service.rescheduleShow(USER, 's-1', { startsAt: NEW_START, padMinutes: 0 } as never);

    const recipients = notifications.fanOutCritical.mock.calls[0][1].recipients;
    expect(recipients.map((r: { payload: { bookingId: string } }) => r.payload.bookingId)).toEqual([
      'bk-a',
      'bk-b',
    ]);
  });

  it('only reads bookings that are still live on THIS session', async () => {
    const { service, tx } = setup({ bookings: [booking(1)] });
    await service.rescheduleShow(USER, 's-1', { startsAt: NEW_START, padMinutes: 0 } as never);

    const where = tx.booking.findMany.mock.calls[0][0].where;
    // Scoped to the session, so a change to one show never mails another show's customers.
    expect(where.eventSessionId).toBe('s-1');
    /*
      CONFIRMED and PARTIALLY_REFUNDED only. A cancelled or expired booking no longer
      involves this show; a partly refunded one still has tickets on it and still needs to
      know when it starts.
    */
    expect(where.status.in.sort()).toEqual(['CONFIRMED', 'PARTIALLY_REFUNDED']);
  });
});

describe('what counts as a change worth sending', () => {
  it('says nothing when the start time did not actually move', async () => {
    /*
      Saving the same time twice is what an operator does by clicking the button again. And
      `endsAt` is DERIVED from the film's runtime, so it never moves on its own — treating a
      recomputed end as material would mail every ticket holder because somebody adjusted a
      padding value by a minute.
    */
    const { service, notifications, tx } = setup({ bookings: [booking(1)] });
    await service.rescheduleShow(USER, 's-1', { startsAt: OLD_START, padMinutes: 0 } as never);

    expect(tx.eventSession.update).toHaveBeenCalled();
    expect(notifications.fanOutCritical).not.toHaveBeenCalled();
  });

  it('records in the audit trail whether anybody was told', async () => {
    const { service, audit } = setup({ bookings: [booking(1)] });
    await service.rescheduleShow(USER, 's-1', { startsAt: NEW_START, padMinutes: 0 } as never);
    expect(audit.record.mock.calls[0][0].metadata.notified).toBe(true);
  });

  it('tells nobody when the reschedule is rejected', async () => {
    // A conflicting slot rolls the transaction back. Nobody may be told about a change that
    // did not happen — which is why the fan-out is inside the transaction, not after it.
    const { service, notifications, tx } = setup({ bookings: [booking(1)] });
    tx.eventSession.findMany.mockResolvedValue([
      {
        id: 'other',
        startsAt: NEW_START,
        endsAt: new Date(NEW_START.getTime() + 60_000),
      },
    ]);

    await expect(
      service.rescheduleShow(USER, 's-1', { startsAt: NEW_START, padMinutes: 0 } as never),
    ).rejects.toThrow(/already booked/);
    expect(notifications.fanOutCritical).not.toHaveBeenCalled();
  });
});

describe('SHOW_CHANGED is not a cancellation', () => {
  it('does not use SMS — that is reserved for the SHOW being off', () => {
    /*
      A time change is important; it is not somebody arriving at a dark venue. SMS costs money
      per message and is the only channel that reaches a phone with no app, no data and no
      email, so it is kept for the case that actually needs it.
    */
    expect(channelsFor(NotificationType.SHOW_CHANGED)).not.toContain('sms');
    expect(channelsFor(NotificationType.SHOW_CHANGED).sort()).toEqual([
      'email',
      'in_app',
      'push',
      'whatsapp',
    ]);
    /*
      And SHOW_CANCELLED, not BOOKING_CANCELLED. A customer cancelling their own booking is
      not an emergency and does not earn an SMS; the show being called off is, and does.
    */
    expect(channelsFor(NotificationType.SHOW_CANCELLED)).toContain('sms');
    expect(channelsFor(NotificationType.BOOKING_CANCELLED)).not.toContain('sms');
  });

  it('cancelling a show sends no SHOW_CHANGED', async () => {
    // Cancellation is a different fact with a different message. Sending both would tell
    // somebody their show had moved and then that their booking was over.
    const { service, notifications } = setup({ bookings: [booking(1)] });
    await service.cancelShow(USER, 's-1', 'projector failure');
    expect(notifications.fanOutCritical).not.toHaveBeenCalled();
    expect(notifications.sendCritical).not.toHaveBeenCalled();
  });
});

describe('a show rescheduled twice', () => {
  it('is two pieces of news, because the time is part of the key', () => {
    /*
      Keyed on the booking alone, the second move would be suppressed as a duplicate of the
      first — and the suppressed one is the only one that is still true.
    */
    const keyAt = (startsAt: string) =>
      dedupeKeyFor({
        type: NotificationType.SHOW_CHANGED,
        channel: 'email',
        recipientRef: 'u-1',
        payload: { bookingId: 'bk-1', startsAt },
      });

    expect(keyAt(NEW_START.toISOString())).not.toBe(keyAt(OLD_START.toISOString()));
    // The same move processed twice is still one message.
    expect(keyAt(NEW_START.toISOString())).toBe(keyAt(NEW_START.toISOString()));
  });

  it('is not deduplicated across different bookings', () => {
    const keyFor = (bookingId: string) =>
      dedupeKeyFor({
        type: NotificationType.SHOW_CHANGED,
        channel: 'email',
        recipientRef: 'u-1',
        payload: { bookingId, startsAt: NEW_START.toISOString() },
      });
    expect(keyFor('bk-1')).not.toBe(keyFor('bk-2'));
  });
});
