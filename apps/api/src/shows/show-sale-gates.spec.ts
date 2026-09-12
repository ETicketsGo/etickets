import { BookingStatus, PaymentStatus } from '@eticketsgo/shared-types';
import { ShowsService } from './shows.service';
import { InventoryService } from '../inventory/inventory.service';
import { GeneralAdmissionInventoryStrategy } from '../inventory/general-admission.strategy';
import { SeatBasedInventoryStrategy } from '../inventory/seat-based.strategy';
import { ExperienceTypeRegistry } from '../experience/experience-type.registry';
import { AddOnInventoryService } from '../commerce/addon-inventory.service';

/**
 * Two ways a show could be sold that should not have been.
 *
 * Cancelling a show closed its seats but left the bookings holding them PENDING_PAYMENT, so
 * a buyer on the payment page could still pay and be issued tickets for a show that is not
 * happening. And scheduling a show puts it on sale at once — its film's event is created
 * PUBLISHED — with membership the only check, so an organization the platform had not
 * approved could sell tickets the day it signed up.
 */
const USER = { id: 'u-op', email: 'op@t.test', fullName: 'Op', roles: [] } as never;
const IN_A_WEEK = () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

function realInventory(): InventoryService {
  return new InventoryService(
    new ExperienceTypeRegistry(),
    new GeneralAdmissionInventoryStrategy(),
    new SeatBasedInventoryStrategy(),
  );
}

const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');

describe('cancelling a show with buyers still at the payment step', () => {
  const pendingSeated = () => ({
    id: 'bk-pending',
    eventSessionId: 's-1',
    holdExpiresAt: IN_A_WEEK(),
    seatBased: true,
    status: BookingStatus.PENDING_PAYMENT,
    items: [{ ticketTypeId: 'tt-1', addOnId: null, quantity: 2 }],
  });

  function setup(opts: { pending?: unknown[]; claimed?: number; wired?: boolean } = {}) {
    const session = {
      id: 's-1',
      eventId: 'ev-1',
      screenId: 'scr-1',
      startsAt: IN_A_WEEK(),
      status: 'SCHEDULED',
      event: { organizationId: 'org-1', movieId: 'mv-1' },
      screen: null,
    };
    const tx = {
      eventSession: { update: jest.fn().mockResolvedValue({}) },
      booking: {
        findMany: jest.fn().mockResolvedValue(opts.pending ?? []),
        updateMany: jest.fn().mockResolvedValue({ count: opts.claimed ?? 1 }),
      },
      payment: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $executeRaw: jest.fn().mockResolvedValue(1),
      showSeat: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    const prisma = {
      // The paid bookings reported for refund; none in these cases.
      booking: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
    };
    const wired = opts.wired ?? true;
    const service = new ShowsService(
      prisma as never,
      { assertMember: jest.fn().mockResolvedValue(undefined) } as never,
      { record: jest.fn().mockResolvedValue(undefined) } as never,
      undefined,
      undefined,
      undefined,
      wired ? realInventory() : undefined,
      wired ? new AddOnInventoryService() : undefined,
    );
    // The operation policy and the ownership check have their own suites.
    jest.spyOn(service as never, 'authorizeOperation').mockResolvedValue({
      session,
      commitments: { activeHolds: 1, pendingPayment: 1, confirmed: 0 },
      idempotent: false,
    } as never);
    return { service, tx };
  }

  it('expires those bookings so they can no longer be paid for', async () => {
    const { service, tx } = setup({ pending: [pendingSeated()] });
    await service.cancelShow(USER, 's-1', 'projector failure');

    expect(tx.booking.findMany).toHaveBeenCalledWith({
      where: { eventSessionId: 's-1', status: BookingStatus.PENDING_PAYMENT },
      include: { items: true },
    });
    // Whether or not the hold has lapsed: the show is off either way.
    expect(tx.booking.updateMany).toHaveBeenCalledWith({
      where: { id: 'bk-pending', status: BookingStatus.PENDING_PAYMENT },
      data: expect.objectContaining({ status: BookingStatus.EXPIRED }),
    });
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { bookingId: 'bk-pending', status: PaymentStatus.REQUIRES_PAYMENT },
      data: { status: PaymentStatus.FAILED },
    });
  });

  it('releases their holds through the seat strategy before the seats are closed', async () => {
    const { service, tx } = setup({ pending: [pendingSeated()] });
    await service.cancelShow(USER, 's-1', 'projector failure');

    expect(sqlOf(tx.$executeRaw.mock.calls[0])).toContain('"ShowSeat"');
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      tx.showSeat.updateMany.mock.invocationCallOrder[0],
    );
  });

  it('leaves alone a booking a webhook confirmed a moment earlier', async () => {
    // It is a paid booking now, reported for refund with the rest; its seats are SOLD.
    const { service, tx } = setup({ pending: [pendingSeated()], claimed: 0 });
    await expect(service.cancelShow(USER, 's-1', 'projector failure')).resolves.toMatchObject({
      changed: true,
    });

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.payment.updateMany).not.toHaveBeenCalled();
  });

  it('refuses rather than leave them payable when it cannot release their holds', async () => {
    const { service, tx } = setup({ pending: [pendingSeated()], wired: false });
    await expect(service.cancelShow(USER, 's-1', 'projector failure')).rejects.toThrow(
      /not available in this configuration/,
    );
    expect(tx.showSeat.updateMany).not.toHaveBeenCalled();
  });

  it('cancels as before when nobody is mid-checkout', async () => {
    const { service, tx } = setup({ pending: [], wired: false });
    await expect(service.cancelShow(USER, 's-1', 'projector failure')).resolves.toMatchObject({
      changed: true,
    });
    expect(tx.booking.updateMany).not.toHaveBeenCalled();
    expect(tx.showSeat.updateMany).toHaveBeenCalled();
  });
});

describe('scheduling shows for an organization the platform has not approved', () => {
  function setup(organizationStatus: string) {
    const prisma = {
      movie: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'mv-1',
          title: 'Kalki',
          organizationId: 'org-1',
          runtimeMinutes: 120,
        }),
      },
      organization: { findUnique: jest.fn().mockResolvedValue({ status: organizationStatus }) },
      screen: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'scr-1',
          name: 'Screen 1',
          status: 'ACTIVE',
          cinema: {
            id: 'cin-1',
            organizationId: 'org-1',
            status: 'ACTIVE',
            timezone: 'Asia/Kolkata',
            venueId: 'ven-1',
            name: 'Cine',
            city: 'Hyderabad',
            address: null,
          },
        }),
      },
      eventSession: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn().mockResolvedValue({ eventId: 'ev-1', sessionId: 's-1' }),
    };
    const service = new ShowsService(
      prisma as never,
      { assertMember: jest.fn().mockResolvedValue(undefined) } as never,
    );
    jest
      .spyOn(service, 'resolveLayoutForShow')
      .mockResolvedValue({ id: 'map-1', version: 1, seats: [], categories: [] } as never);
    return { service, prisma };
  }

  const show = () => {
    const startsAt = IN_A_WEEK();
    return { screenId: 'scr-1', startsAt, endsAt: new Date(startsAt.getTime() + 2 * 3600_000) };
  };
  const batch = (dryRun: boolean) =>
    ({
      screenId: 'scr-1',
      dates: ['2027-01-15'],
      times: ['10:30'],
      padMinutes: 0,
      dryRun,
    }) as never;

  it.each(['PENDING', 'SUSPENDED', 'REJECTED'])(
    'cannot put a show on sale while %s',
    async (status) => {
      const { service, prisma } = setup(status);
      await expect(service.scheduleShow(USER, 'mv-1', show() as never)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('schedules exactly as before for an approved organization', async () => {
    const { service } = setup('APPROVED');
    await expect(service.scheduleShow(USER, 'mv-1', show() as never)).resolves.toEqual({
      eventId: 'ev-1',
      sessionId: 's-1',
    });
  });

  it('may preview a bulk schedule but not write one', async () => {
    // A dry run writes nothing and sells nothing; an organization awaiting approval can plan.
    const { service, prisma } = setup('PENDING');
    await expect(service.bulkScheduleShows(USER, 'mv-1', batch(true))).resolves.toMatchObject({
      dryRun: true,
      created: [],
    });
    await expect(service.bulkScheduleShows(USER, 'mv-1', batch(false))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
