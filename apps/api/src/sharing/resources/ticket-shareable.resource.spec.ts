import { TicketShareableResource, type ShareableTicketRow } from './ticket-shareable.resource';

/*
  A shared ticket reads the time the ticket itself prints.

  The share page rendered `startsAt` in the viewer's device zone, because the share view carried
  no zone: a friend in Dubai opening a link to a Hyderabad show saw 18:30 for an 20:00 start.
  The view now states the zone — the cinema's for a screening, else the venue's.
*/
const row = (over: Partial<ShareableTicketRow['eventSession']> = {}): ShareableTicketRow => ({
  id: 'tk1',
  organizationId: 'org1',
  status: 'ACTIVE',
  nonce: 'n',
  qrVersion: 1,
  eventSessionId: 's1',
  serial: 'S-1',
  seatLabel: null,
  holderName: null,
  booking: { userId: 'u1', reference: 'ETG-IN-2026-000001' },
  ticketType: { name: 'General' },
  eventSession: {
    startsAt: new Date('2026-10-01T14:30:00Z'),
    endsAt: new Date('2026-10-01T17:30:00Z'),
    screen: null,
    event: {
      title: 'Concert',
      experienceType: 'EVENT',
      venue: { name: 'Shilpakala Vedika', timezone: 'Asia/Kolkata' },
    },
    ...over,
  },
});

describe('TicketShareableResource.toShareView', () => {
  it("states the venue's zone for an ordinary event", () => {
    const view = new TicketShareableResource(row(), {} as never).toShareView();
    expect(view.timeZone).toBe('Asia/Kolkata');
  });

  it("prefers the cinema's zone for a screening", () => {
    const view = new TicketShareableResource(
      row({
        screen: { name: 'Audi 1', cinema: { name: 'PVR', timezone: 'America/Boise' } },
        event: {
          title: 'Film',
          experienceType: 'MOVIE',
          venue: { name: 'Mall', timezone: 'Asia/Kolkata' },
        },
      }),
      {} as never,
    ).toShareView();
    expect(view.timeZone).toBe('America/Boise');
  });

  it('says nothing rather than inventing a zone when neither is known', () => {
    const view = new TicketShareableResource(
      row({ event: { title: 'Gig', experienceType: 'EVENT', venue: null } }),
      {} as never,
    ).toShareView();
    expect(view.timeZone).toBeNull();
  });
});
