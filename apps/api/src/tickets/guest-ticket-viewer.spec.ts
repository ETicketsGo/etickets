import { TicketsService } from './tickets.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { QrService } from './qr.service';

/**
 * What a ticket shows somebody who is not an account.
 *
 * ── THE NULL THAT WOULD HAVE BEEN A DEFECT ─────────────────────────────────────────
 * `decorate` decided who is handed a QR by comparing the viewer's user id to the ticket's
 * holder and attendee. Widening the viewer to null for guest bookings puts a null on the left
 * of those comparisons — and `attendeeUserId` is null on every unassigned ticket, while a
 * legacy transfer's recipient can be null too. `null === null` is true, so the plain comparison
 * would have handed a transferred ticket's live credential straight back to the guest who gave
 * it away: exactly the defect the transfer rule was written to close, reintroduced through a
 * type change with no behaviour in it.
 *
 * These tests are that comparison, from the guest side.
 */

const TRANSFER_TO = 'user-recipient';

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'tk_1',
    bookingId: 'bk_guest',
    ticketTypeId: 'tt_1',
    eventSessionId: 'se_1',
    organizationId: 'org_1',
    serial: 'TKT-0001',
    nonce: 'nonce-1',
    qrVersion: 1,
    status: 'ACTIVE',
    seatId: null,
    seatLabel: 'H1',
    holderName: null,
    assignmentStatus: 'UNASSIGNED',
    attendeeUserId: null,
    // A guest booking: nobody owns it.
    booking: { reference: 'ETG-IND-2026-000123', userId: null },
    invites: [],
    ticketType: { name: 'Gold' },
    eventSession: {
      startsAt: new Date('2026-09-20T13:30:00.000Z'),
      screen: { name: 'Screen 3', cinema: { name: 'PVR Vijayawada', timezone: 'Asia/Kolkata' } },
      event: {
        title: 'Kantara',
        slug: 'kantara',
        experienceType: 'MOVIE',
        venue: { name: 'PVR Forum Mall', city: 'Vijayawada', timezone: 'Asia/Kolkata' },
      },
    },
    ...over,
  };
}

function setup(rows: ReturnType<typeof row>[]) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const prisma = { ticket: { findMany } } as unknown as PrismaService;
  const qr = { sign: jest.fn().mockReturnValue('signed-token') } as unknown as QrService;
  return {
    svc: new TicketsService(prisma, qr, {} as never, {} as never),
    findMany,
    sign: qr.sign as jest.Mock,
  };
}

describe('TicketsService.ticketsForGuestBooking', () => {
  it('hands over the QR for a ticket the guest still holds', async () => {
    const { svc } = setup([row()]);
    const [ticket] = await svc.ticketsForGuestBooking('bk_guest');
    expect(ticket.qrToken).toBe('signed-token');
    expect(ticket.qrDataUrl?.startsWith('data:image/png')).toBe(true);
    expect(ticket.transferred).toBe(false);
  });

  it('presents NO QR for a ticket the guest transferred away', async () => {
    /*
      The recipient's credential is the recipient's. A guest who gave a seat away can still see
      that the ticket exists and that it was transferred — and nothing that opens a gate.
    */
    const { svc } = setup([row({ invites: [{ acceptedByUserId: TRANSFER_TO }] })]);
    const [ticket] = await svc.ticketsForGuestBooking('bk_guest');
    expect(ticket.transferred).toBe(true);
    expect(ticket.qrToken).toBeNull();
    expect(ticket.qrDataUrl).toBeNull();
    expect(ticket.vendorBarcode).toBeNull();
  });

  it('presents no QR even when the transfer’s recipient was never recorded', async () => {
    // A legacy transfer row: `acceptedByUserId` is null, and so is the guest viewer. Two
    // nulls agreeing must not read as "this is you".
    const { svc } = setup([row({ invites: [{ acceptedByUserId: null }] })]);
    const [ticket] = await svc.ticketsForGuestBooking('bk_guest');
    expect(ticket.transferred).toBe(true);
    expect(ticket.qrToken).toBeNull();
  });

  it('presents no QR because the ticket is assigned to nobody, either', async () => {
    // `attendeeUserId` is null on an unassigned ticket. Compared directly against a null
    // viewer it would grant the credential on the attendee branch instead.
    const { svc } = setup([
      row({ invites: [{ acceptedByUserId: TRANSFER_TO }], attendeeUserId: null }),
    ]);
    const [ticket] = await svc.ticketsForGuestBooking('bk_guest');
    expect(ticket.qrToken).toBeNull();
    expect(ticket.assignedToViewer).toBe(false);
  });

  it('claims no ownership on a guest’s behalf', async () => {
    // A guest booking has no account, so there is no owner to be. Saying otherwise would put
    // owner-only actions in front of somebody the server will then refuse.
    const { svc } = setup([row()]);
    const [ticket] = await svc.ticketsForGuestBooking('bk_guest');
    expect(ticket.ownedByViewer).toBe(false);
    expect(ticket.assignedToViewer).toBe(false);
  });

  it('will not read an account booking’s tickets, whoever calls it', async () => {
    /*
      The method takes an id and no viewer, so the only thing standing between it and somebody
      else's QR codes is this clause. It is asserted on the QUERY: a filter applied afterwards
      would still have loaded the row.
    */
    const { svc, findMany } = setup([]);
    await svc.ticketsForGuestBooking('bk_account');
    expect(findMany.mock.calls[0][0].where).toEqual({
      bookingId: 'bk_account',
      booking: { userId: null },
    });
  });

  it('keeps the account wallet’s rules untouched', async () => {
    // The widening must not change what a signed-in holder sees: a ticket they still hold
    // presents, and one they transferred away does not.
    const held = setup([row({ booking: { reference: 'R', userId: 'user-1' } })]);
    const [mine] = await held.svc.wallet({
      id: 'user-1',
      email: '',
      fullName: '',
      roles: [] as never,
    });
    expect(mine.qrToken).toBe('signed-token');
    expect(mine.ownedByViewer).toBe(true);

    const givenAway = setup([
      row({
        booking: { reference: 'R', userId: 'user-1' },
        invites: [{ acceptedByUserId: TRANSFER_TO }],
      }),
    ]);
    const [gone] = await givenAway.svc.wallet({
      id: 'user-1',
      email: '',
      fullName: '',
      roles: [] as never,
    });
    expect(gone.qrToken).toBeNull();
    expect(gone.ownedByViewer).toBe(false);
  });
});
