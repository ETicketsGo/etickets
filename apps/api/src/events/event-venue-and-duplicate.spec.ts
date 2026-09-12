import { BookingStatus, EventStatus } from '@eticketsgo/shared-types';
import { EventsService } from './events.service';

/**
 * Two ways an organizer's own edits could leave an event that does not sell as it says.
 *
 * Moving an event to another venue accepted ANY venue id — another organization's included —
 * and did so under live bookings, although the venue decides the currency and the place of
 * supply those buyers were charged for. And duplicating a seated event copied the room but
 * not its seats, so the copy published and then refused every booking.
 */
const ORGANIZER = { id: 'u-1', email: 'o@t.test', fullName: 'O', roles: [] } as never;

const EVENT = {
  id: 'ev-1',
  organizationId: 'org-1',
  venueId: 'ven-1',
  status: EventStatus.DRAFT,
  isFree: false,
  title: 'Hamlet',
  experienceType: 'EVENT',
  movieId: null,
  category: 'Theatre',
  description: null,
  feeMode: 'CUSTOMER_PAYS',
  refundPolicy: null,
  refundsEnabled: true,
  refundCutoffHours: 48,
};

function setup(over: { venue?: unknown; liveBookings?: number; sessions?: unknown[] } = {}) {
  const tx = {
    event: { create: jest.fn().mockResolvedValue({ id: 'ev-copy' }) },
    eventImage: { findMany: jest.fn().mockResolvedValue([]), createMany: jest.fn() },
    eventSession: {
      create: jest
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: `copy-of-${String(data.startsAt.toISOString())}`, ...data }),
        ),
    },
    ticketType: {
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    event: {
      findUnique: jest.fn().mockResolvedValue(EVENT),
      update: jest.fn().mockResolvedValue(EVENT),
    },
    venue: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          over.venue === undefined ? { id: 'ven-2', organizationId: 'org-1' } : over.venue,
        ),
    },
    booking: { count: jest.fn().mockResolvedValue(over.liveBookings ?? 0) },
    eventSession: { findMany: jest.fn().mockResolvedValue(over.sessions ?? []) },
    $transaction: jest.fn().mockImplementation((fn: (t: unknown) => unknown) => fn(tx)),
  };
  const shows = {
    resolveLayoutForShow: jest.fn().mockResolvedValue({ id: 'map-3', seats: [], categories: [] }),
    seatSession: jest.fn().mockResolvedValue(undefined),
  };
  const service = new EventsService(
    prisma as never,
    { assertMember: async () => undefined } as never,
    { record: async () => undefined } as never,
    {} as never,
    { get: () => 'http://localhost:3000' } as never,
    shows as never,
    { check: async () => ({ sellable: true, blockers: [], warnings: [] }) } as never,
  );
  return { service, prisma, tx, shows };
}

describe('moving an event to another venue', () => {
  it("refuses another organization's venue", async () => {
    const { service, prisma } = setup({ venue: { id: 'ven-9', organizationId: 'org-2' } });
    await expect(service.update(ORGANIZER, 'ev-1', { venueId: 'ven-9' })).rejects.toThrow(
      /Venue not found for this organization/,
    );
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  it('refuses a venue that does not exist', async () => {
    const { service, prisma } = setup({ venue: null });
    await expect(service.update(ORGANIZER, 'ev-1', { venueId: 'nope' })).rejects.toThrow(
      /Venue not found/,
    );
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  it('refuses while any booking that is not expired or cancelled exists', async () => {
    // The venue decides the currency and the place of supply. Live buyers agreed to both.
    const { service, prisma } = setup({ liveBookings: 2 });
    await expect(service.update(ORGANIZER, 'ev-1', { venueId: 'ven-2' })).rejects.toThrow(
      /cannot be moved to another venue/,
    );
    expect(prisma.booking.count.mock.calls[0][0].where).toEqual({
      eventId: 'ev-1',
      status: { notIn: [BookingStatus.EXPIRED, BookingStatus.CANCELLED] },
    });
    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  it('moves the event to its own organization’s venue when nothing is live', async () => {
    const { service, prisma } = setup();
    await service.update(ORGANIZER, 'ev-1', { venueId: 'ven-2' });
    expect(prisma.event.update).toHaveBeenCalledWith({
      where: { id: 'ev-1' },
      data: { venueId: 'ven-2' },
    });
  });

  it('does not look the venue up when it is not changing', async () => {
    const { service, prisma } = setup();
    await service.update(ORGANIZER, 'ev-1', { venueId: 'ven-1', title: 'Hamlet, again' });
    expect(prisma.venue.findUnique).not.toHaveBeenCalled();
    expect(prisma.event.update).toHaveBeenCalled();
  });
});

describe('duplicating a seated event', () => {
  const STARTS = new Date('2027-03-01T14:00:00Z');
  const seated = {
    id: 's-seated',
    screenId: 'room-1',
    seatMapId: 'map-1',
    startsAt: STARTS,
    endsAt: new Date('2027-03-01T17:00:00Z'),
    ticketTypes: [
      {
        seatCategoryId: 'cat-gold',
        name: 'Gold',
        priceMinor: 90_000,
        currency: 'INR',
        quantityTotal: 40,
        maxPerOrder: 4,
        salesStartAt: null,
        salesEndAt: null,
        status: 'INACTIVE',
      },
    ],
  };
  const standing = {
    id: 's-standing',
    screenId: null,
    seatMapId: null,
    startsAt: new Date('2027-03-02T14:00:00Z'),
    endsAt: new Date('2027-03-02T17:00:00Z'),
    ticketTypes: [
      {
        seatCategoryId: null,
        name: 'Standing',
        priceMinor: 50_000,
        currency: 'INR',
        quantityTotal: 300,
        maxPerOrder: 8,
        salesStartAt: null,
        salesEndAt: null,
        status: 'ACTIVE',
      },
    ],
  };

  it('copies the seats with the room, the way adding a session does', async () => {
    const { service, tx, shows } = setup({ sessions: [seated] });
    await service.duplicate(ORGANIZER, 'ev-1');

    // The layout in force for that date, pinned — as addSession does.
    expect(shows.resolveLayoutForShow).toHaveBeenCalledWith('room-1', STARTS);
    expect(tx.eventSession.create.mock.calls[0][0].data).toMatchObject({
      screenId: 'room-1',
      seatMapId: 'map-3',
    });
    // Seated through the one shared implementation, at the original's prices.
    expect(shows.seatSession).toHaveBeenCalledWith(
      tx,
      expect.any(String),
      expect.objectContaining({ id: 'map-3' }),
      [{ seatCategoryId: 'cat-gold', priceMinor: 90_000 }],
    );
    // Not created a second time beside the ones seatSession made.
    expect(tx.ticketType.create).not.toHaveBeenCalled();
  });

  it("keeps the original category's settings, including being off sale", async () => {
    const { service, tx } = setup({ sessions: [seated] });
    await service.duplicate(ORGANIZER, 'ev-1');

    expect(tx.ticketType.updateMany).toHaveBeenCalledWith({
      where: { eventSessionId: expect.any(String), seatCategoryId: 'cat-gold' },
      data: expect.objectContaining({ name: 'Gold', maxPerOrder: 4, status: 'INACTIVE' }),
    });
  });

  it('still copies a general-admission session as it always did', async () => {
    const { service, tx, shows } = setup({ sessions: [standing] });
    await service.duplicate(ORGANIZER, 'ev-1');

    expect(shows.resolveLayoutForShow).not.toHaveBeenCalled();
    expect(shows.seatSession).not.toHaveBeenCalled();
    expect(tx.eventSession.create.mock.calls[0][0].data).toMatchObject({
      screenId: null,
      seatMapId: null,
    });
    expect(tx.ticketType.create).toHaveBeenCalledTimes(1);
    expect(tx.ticketType.create.mock.calls[0][0].data).toMatchObject({
      name: 'Standing',
      inventory: { create: { quantityTotal: 300 } },
    });
  });
});
