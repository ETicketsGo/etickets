import { TicketsService } from './tickets.service';
import { QrService } from './qr.service';
import { PrismaService } from '../prisma/prisma.service';
import type { RequestUser } from '../common/decorators';

const USER: RequestUser = {
  id: 'user-1',
  email: 'buyer@eticketsgo.test',
  fullName: 'Buyer',
  roles: ['CUSTOMER'] as never,
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'tk_1',
    bookingId: 'bk_abc123DEF',
    ticketTypeId: 'tt_1',
    eventSessionId: 'se_1',
    organizationId: 'org_1',
    serial: 'TKT-0001',
    nonce: 'nonce-1',
    qrVersion: 1,
    status: 'ACTIVE',
    seatId: null,
    seatLabel: null,
    holderName: 'Ada',
    assignmentStatus: 'ASSIGNED',
    attendeeUserId: 'user-1',
    booking: { reference: 'ETG-IND-2026-000042', userId: 'user-1' },
    ticketType: { name: 'VIP' },
    eventSession: {
      startsAt: new Date('2026-09-01T10:00:00.000Z'),
      screen: null,
      event: {
        title: 'DevConf India 2026',
        slug: 'devconf-india-2026',
        experienceType: 'EVENT',
        venue: { name: 'Hall A', city: 'Bengaluru' },
      },
    },
    ...over,
  };
}

function setup(rows: ReturnType<typeof row>[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { ticket: { findMany } } as unknown as PrismaService;
  const qr = { sign: jest.fn().mockReturnValue('signed-token') } as unknown as QrService;
  return { svc: new TicketsService(prisma, qr, {} as never, {} as never), findMany };
}

describe('TicketsService.wallet', () => {
  it('projects booking-grouping + seat/venue context onto each ticket', async () => {
    const { svc } = setup([row()]);
    const [t] = await svc.wallet(USER);
    expect(t.bookingId).toBe('bk_abc123DEF');
    // Prefers the real public reference when present.
    expect(t.bookingRef).toBe('ETG-IND-2026-000042');
    expect(t.experienceType).toBe('EVENT');
    expect(t.venueName).toBe('Hall A');
    // `qrDataUrl` became nullable when third-party barcodes arrived — a non-QR symbology
    // is not rendered server-side, because encoding CODE128 content into a QR produces a
    // scannable image of the wrong shape. Our own tickets always have one, so assert that
    // rather than assuming it away.
    expect(t.qrDataUrl).not.toBeNull();
    expect(t.qrDataUrl!.startsWith('data:image/png')).toBe(true);
  });

  it('falls back to a derived short code when no reference is set (legacy booking)', async () => {
    const { svc } = setup([row({ booking: { reference: null } })]);
    const [t] = await svc.wallet(USER);
    expect(t.bookingRef).toBe('123DEF'); // last 6 of bk_abc123DEF
  });

  it('surfaces movie screen + cinema + seat label', async () => {
    const { svc } = setup([
      row({
        seatLabel: 'A1',
        eventSession: {
          startsAt: new Date('2026-09-01T10:00:00.000Z'),
          screen: { name: 'Screen 2', cinema: { name: 'PVR Forum' } },
          event: {
            title: 'Skyfront Protocol',
            slug: 'skyfront-protocol',
            experienceType: 'MOVIE',
            venue: { name: 'PVR Forum', city: 'Bengaluru' },
          },
        },
      }),
    ]);
    const [t] = await svc.wallet(USER);
    expect(t.experienceType).toBe('MOVIE');
    expect(t.screenName).toBe('Screen 2');
    expect(t.cinemaName).toBe('PVR Forum');
    expect(t.seatLabel).toBe('A1');
  });

  it('includes non-active tickets (refunded/checked-in) so booking history is complete', async () => {
    const { svc, findMany } = setup([
      row({ id: 'a', serial: 'S-A', status: 'CHECKED_IN' }),
      row({ id: 'b', serial: 'S-B', status: 'REFUNDED' }),
    ]);
    const result = await svc.wallet(USER);
    expect(result.map((t) => t.status)).toEqual(['CHECKED_IN', 'REFUNDED']);

    // The query must not filter tickets by status (only the booking scope).
    const call = findMany.mock.calls[0][0];
    expect(call.where.status).toBeUndefined();
  });
});

/**
 * The zone the printed time is read in, for events that are not in a cinema.
 *
 * `timezone` came only from the cinema, so every concert, conference and match sent null and
 * its ticket went back to the DEVICE's zone — the defect `ticket-timezone.spec.ts` describes,
 * still live for everything but films.
 */
describe('TicketsService — the ticket’s timezone', () => {
  const session = (screen: unknown, venueTimezone: string | null) => ({
    startsAt: new Date('2026-09-01T10:00:00.000Z'),
    screen,
    event: {
      title: 'DevConf',
      slug: 'devconf',
      experienceType: screen ? 'MOVIE' : 'EVENT',
      venue: { name: 'Hall A', city: 'Chicago', timezone: venueTimezone },
    },
  });

  it('falls back to the venue’s zone for an event with no cinema', async () => {
    const { svc } = setup([row({ eventSession: session(null, 'America/Chicago') })]);
    const [t] = await svc.wallet(USER);
    expect(t.timezone).toBe('America/Chicago');
  });

  it('still prefers the cinema’s zone when there is one', async () => {
    const screen = { name: 'Screen 1', cinema: { name: 'PVR', timezone: 'Asia/Kolkata' } };
    const { svc } = setup([row({ eventSession: session(screen, 'America/Chicago') })]);
    const [t] = await svc.wallet(USER);
    expect(t.timezone).toBe('Asia/Kolkata');
  });

  it('asks the database for the venue’s zone, so the fallback has something to read', async () => {
    const { svc, findMany } = setup([]);
    await svc.wallet(USER);
    const include = findMany.mock.calls[0][0].include;
    expect(include.eventSession.select.event.select.venue.select.timezone).toBe(true);
  });
});

/**
 * A transferred ticket belongs to its recipient.
 *
 * Accepting a transfer rotated the QR, and then the wallet re-signed the NEW QR for the buyer
 * who had just given the ticket away — so both of them held a code that opened the gate.
 */
describe('TicketsService — a transferred ticket', () => {
  const BUYER = USER; // user-1, the booking's userId in `row()`
  const RECIPIENT: RequestUser = { ...USER, id: 'user-2', email: 'rec@eticketsgo.test' };
  const STAFF: RequestUser = { ...USER, id: 'staff-9', roles: ['CHECKIN_STAFF'] as never };

  const transferred = (over: Record<string, unknown> = {}) =>
    row({
      attendeeUserId: 'user-2',
      assignmentStatus: 'ACCEPTED',
      invites: [{ acceptedByUserId: 'user-2' }],
      ...over,
    });

  it('is not presented to the buyer who gave it away', async () => {
    const { svc } = setup([transferred()]);
    const [t] = await svc.wallet(BUYER);
    expect(t.transferred).toBe(true);
    expect(t.qrToken).toBeNull();
    expect(t.qrDataUrl).toBeNull();
    expect(t.ownedByViewer).toBe(false);
  });

  it('withholds a third-party barcode as well, which is the gate credential for those', async () => {
    const { svc } = setup([
      transferred({ vendorBarcode: 'VENDOR-7788', vendorBarcodeFormat: 'CODE128' }),
    ]);
    const [t] = await svc.wallet(BUYER);
    expect(t.vendorBarcode).toBeNull();
    expect(JSON.stringify(t)).not.toContain('VENDOR-7788');
  });

  it('is presented to, and owned by, its new holder', async () => {
    const { svc } = setup([transferred()]);
    const [t] = await svc.wallet(RECIPIENT);
    expect(t.qrToken).toBe('signed-token');
    expect(t.qrDataUrl).not.toBeNull();
    expect(t.ownedByViewer).toBe(true);
  });

  it('is presented to somebody the new holder assigned it to, without making them its owner', async () => {
    const { svc } = setup([transferred({ attendeeUserId: 'friend-3' })]);
    const [t] = await svc.wallet({ ...USER, id: 'friend-3' });
    expect(t.qrToken).toBe('signed-token');
    expect(t.ownedByViewer).toBe(false);
  });

  it('stays viewable by the buyer as history, without its QR', async () => {
    const findUnique = jest.fn().mockResolvedValue(transferred());
    const svc = new TicketsService(
      { ticket: { findUnique } } as unknown as PrismaService,
      { sign: jest.fn().mockReturnValue('signed-token') } as unknown as QrService,
      {} as never,
      {} as never,
    );
    const t = await svc.getForUser(BUYER, 'tk_1');
    expect(t.transferred).toBe(true);
    expect(t.qrToken).toBeNull();
    expect(t.qrDataUrl).toBeNull();
  });

  it('prints without its QR when staff print the booking at the counter', async () => {
    // Otherwise the buyer who gave it away could simply ask the counter for it.
    const prisma = {
      booking: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'bk_abc123DEF',
          organizationId: 'org_1',
          status: 'CONFIRMED',
          reference: 'ETG-IND-2026-000042',
        }),
      },
      ticket: { findMany: jest.fn().mockResolvedValue([transferred(), row({ id: 'tk_2' })]) },
    };
    const svc = new TicketsService(
      prisma as unknown as PrismaService,
      { sign: jest.fn().mockReturnValue('signed-token') } as unknown as QrService,
      { assertMember: jest.fn().mockResolvedValue(undefined) } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const [gone, kept] = await svc.ticketsForBookingAsStaff(STAFF, 'bk_abc123DEF');
    expect(gone.qrDataUrl).toBeNull();
    expect(gone.transferred).toBe(true);
    // The negative control: an ordinary ticket on the same booking still prints.
    expect(kept.qrDataUrl).not.toBeNull();
  });

  it('changes nothing for a ticket that was never transferred', async () => {
    // Assigned to an attendee, but not transferred: the buyer still owns and presents it.
    const { svc } = setup([row({ attendeeUserId: 'friend-3', invites: [] })]);
    const [t] = await svc.wallet(BUYER);
    expect(t.transferred).toBe(false);
    expect(t.qrToken).toBe('signed-token');
    expect(t.ownedByViewer).toBe(true);
  });

  it('keeps it in the recipient’s wallet after they assign it onward', async () => {
    const { svc, findMany } = setup([]);
    await svc.wallet(RECIPIENT);
    expect(findMany.mock.calls[0][0].where.OR).toContainEqual({
      invites: {
        some: { kind: 'TRANSFER', status: 'ACCEPTED', acceptedByUserId: 'user-2' },
      },
    });
  });
});
