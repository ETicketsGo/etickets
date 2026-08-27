import { EventStatus } from '@eticketsgo/shared-types';
import { EventsService } from './events.service';

/**
 * Keeping "this event is free" and "its tickets cost nothing" in agreement.
 *
 * `Event.isFree` is a DECLARATION, not something read off the prices. Inferring it would let
 * an event flip between free and paid as an organizer edited a number, and a booking taken
 * under one reading could be confirmed under the other. But a declaration the data can
 * contradict is worse than no declaration at all: the booking path SKIPS the payment provider
 * on the strength of this flag, so a free event with a ₹500 ticket type would give those
 * tickets away, and nobody would notice until the takings were counted.
 *
 * These are the refusals that keep the two in step — at the point of entry, while the person
 * who typed the price is still looking at the screen.
 */
const ORGANIZER = { id: 'u-1', email: 'o@t.test', fullName: 'O', roles: [] } as never;

function setup(over: {
  eventIsFree?: boolean;
  eventStatus?: string;
  bookings?: number;
  pricedTicketTypes?: number;
}) {
  const event = {
    id: 'ev-1',
    organizationId: 'org-1',
    status: over.eventStatus ?? EventStatus.DRAFT,
    isFree: over.eventIsFree ?? false,
    category: 'Music',
  };
  const eventUpdate = jest.fn().mockResolvedValue({ ...event });
  const ticketTypeCreate = jest.fn().mockResolvedValue({ id: 'tt-1' });
  const ticketTypeUpdate = jest.fn().mockResolvedValue({ id: 'tt-1' });

  const prisma = {
    event: { findUnique: jest.fn().mockResolvedValue(event), update: eventUpdate },
    booking: { count: jest.fn().mockResolvedValue(over.bookings ?? 0) },
    ticketType: {
      count: jest.fn().mockResolvedValue(over.pricedTicketTypes ?? 0),
      create: ticketTypeCreate,
      update: ticketTypeUpdate,
      findUnique: jest.fn().mockResolvedValue({
        id: 'tt-1',
        priceMinor: 0,
        inventory: { quantitySold: 0, quantityHeld: 0, quantityTotal: 100 },
        eventSession: { event },
      }),
    },
    eventSession: {
      findUnique: jest.fn().mockResolvedValue({ id: 'sess-1', event }),
    },
  };

  const service = new EventsService(
    prisma as never,
    { assertMember: async () => undefined } as never,
    { record: async () => undefined } as never,
    {} as never,
    { get: () => 'http://localhost:3000' } as never,
  );
  return { service, prisma, eventUpdate, ticketTypeCreate, ticketTypeUpdate };
}

describe('a free event cannot have priced tickets', () => {
  it('refuses a priced ticket type when the event is free', async () => {
    const { service, ticketTypeCreate } = setup({ eventIsFree: true });

    await expect(
      service.addTicketType(ORGANIZER, {
        eventSessionId: 'sess-1',
        name: 'Entry',
        priceMinor: 50_000,
        currency: 'INR',
        quantityTotal: 100,
        maxPerOrder: 6,
      } as never),
    ).rejects.toThrow(/free event, so its tickets must be priced at zero/i);
    expect(ticketTypeCreate).not.toHaveBeenCalled();
  });

  it('accepts a zero-priced ticket type on a free event', async () => {
    const { service, ticketTypeCreate } = setup({ eventIsFree: true });
    await service.addTicketType(ORGANIZER, {
      eventSessionId: 'sess-1',
      name: 'Entry',
      priceMinor: 0,
      currency: 'INR',
      quantityTotal: 100,
      maxPerOrder: 6,
    } as never);
    expect(ticketTypeCreate).toHaveBeenCalled();
  });

  it('refuses to raise the price of an existing ticket type on a free event', async () => {
    // The way in that a create-time check alone would miss: make it free, then edit a price.
    const { service, ticketTypeUpdate } = setup({ eventIsFree: true });
    await expect(
      service.updateTicketType(ORGANIZER, 'tt-1', { priceMinor: 50_000 } as never),
    ).rejects.toThrow(/free event, so its tickets must be priced at zero/i);
    expect(ticketTypeUpdate).not.toHaveBeenCalled();
  });

  it('leaves priced events alone', async () => {
    // The whole feature is additive, so the ordinary path is asserted rather than assumed.
    const { service, ticketTypeCreate } = setup({ eventIsFree: false });
    await service.addTicketType(ORGANIZER, {
      eventSessionId: 'sess-1',
      name: 'Entry',
      priceMinor: 50_000,
      currency: 'INR',
      quantityTotal: 100,
      maxPerOrder: 6,
    } as never);
    expect(ticketTypeCreate).toHaveBeenCalled();
  });
});

describe('switching an event between free and paid', () => {
  it('refuses once anybody has booked', async () => {
    /*
      Both directions are unsafe after a booking exists.

      Turning it OFF would leave confirmed bookings with no Payment row inside an event the
      rest of the system now reads as paid — reconciliation would look for money that was
      never owed. Turning it ON would strand paid bookings under an event that charges nothing.
    */
    const { service, eventUpdate } = setup({ eventIsFree: false, bookings: 3 });
    await expect(service.update(ORGANIZER, 'ev-1', { isFree: true })).rejects.toThrow(
      /already has bookings/i,
    );
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it('refuses to make an event free while priced ticket types remain', async () => {
    const { service, eventUpdate } = setup({ eventIsFree: false, pricedTicketTypes: 2 });
    await expect(service.update(ORGANIZER, 'ev-1', { isFree: true })).rejects.toThrow(
      /Set all 2 priced ticket types to zero/i,
    );
    expect(eventUpdate).not.toHaveBeenCalled();
  });

  it('allows it on an unbooked event whose tickets are already zero', async () => {
    const { service, eventUpdate } = setup({ eventIsFree: false });
    await service.update(ORGANIZER, 'ev-1', { isFree: true });
    expect(eventUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: { isFree: true } }));
  });

  it('does not run the checks when the flag is not being changed', async () => {
    // An ordinary title edit on a live free event must not be blocked by its own bookings.
    const { service, prisma, eventUpdate } = setup({ eventIsFree: true, bookings: 9 });
    await service.update(ORGANIZER, 'ev-1', { isFree: true, title: 'New name' });
    expect(prisma.booking.count).not.toHaveBeenCalled();
    expect(eventUpdate).toHaveBeenCalled();
  });
});
