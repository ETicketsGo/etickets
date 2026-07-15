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
    booking: { reference: 'ETG-IND-2026-000042' },
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
  return { svc: new TicketsService(prisma, qr), findMany };
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
    expect(t.qrDataUrl.startsWith('data:image/png')).toBe(true);
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
