import { ShowsService } from './shows.service';

/**
 * Which show a seat page is for.
 *
 * The seat layout says nothing about the show, so the seat page said only "Select seats" — not
 * the film, the cinema, or the day. This read supplies it, on the layout's public terms.
 */
describe('ShowsService.getPublicShowSummary', () => {
  const film = {
    slug: 'mandaadi',
    title: 'Mandaadi',
    certificate: 'UA16+',
    language: 'Telugu',
    runtimeMinutes: 154,
    genres: ['Action', 'Drama'],
    posterUrl: null,
    status: 'PUBLISHED',
  };

  const screening = (over: Record<string, unknown> = {}) => ({
    id: 'sess1',
    // 19:00 UTC is 00:30 the NEXT day in Hyderabad.
    startsAt: new Date('2026-09-13T19:00:00Z'),
    endsAt: new Date('2026-09-13T21:34:00Z'),
    status: 'SCHEDULED',
    event: {
      id: 'ev1',
      slug: 'mandaadi-miyapur',
      title: 'Mandaadi',
      status: 'PUBLISHED',
      experienceType: 'MOVIE',
      refundsEnabled: false,
      venue: { name: 'Sai Ranga', city: 'Hyderabad', country: 'India', timezone: 'Asia/Kolkata' },
      movie: film,
    },
    screen: {
      name: 'Screen 1',
      screenType: '4K Laser',
      cinema: { id: 'cin1', name: 'Sai Ranga 70MM', timezone: 'Asia/Kolkata' },
    },
    ...over,
  });

  function makeService(session: unknown) {
    const prisma = { eventSession: { findUnique: jest.fn().mockResolvedValue(session) } };
    return { service: new ShowsService(prisma as never, {} as never), prisma };
  }

  it('names the film, the cinema, the screen and the local day of a screening', async () => {
    const { service } = makeService(screening());
    const summary = await service.getPublicShowSummary('sess1');

    expect(summary).toMatchObject({
      sessionId: 'sess1',
      startsAt: '2026-09-13T19:00:00.000Z',
      timeZone: 'Asia/Kolkata',
      // The cinema's calendar day, not the UTC one: this show is on the 14th in Hyderabad.
      localDate: '2026-09-14',
      event: { slug: 'mandaadi-miyapur', experienceType: 'MOVIE', refundsEnabled: false },
      movie: { slug: 'mandaadi', title: 'Mandaadi', certificate: 'UA16+', language: 'Telugu' },
      venue: { city: 'Hyderabad' },
      cinema: { id: 'cin1', name: 'Sai Ranga 70MM' },
      screen: { name: 'Screen 1', format: '4K Laser' },
    });
  });

  it('uses the venue’s own zone for an event that is not in a cinema', async () => {
    const { service } = makeService(
      screening({
        startsAt: new Date('2026-09-14T03:00:00Z'),
        event: {
          ...screening().event,
          experienceType: 'EVENT',
          movie: null,
          venue: {
            name: 'Hall',
            city: 'Chicago',
            country: 'United States',
            timezone: 'America/Chicago',
          },
        },
        screen: null,
      }),
    );
    const summary = await service.getPublicShowSummary('sess1');
    // 03:00 UTC on the 14th is still the evening of the 13th in Chicago.
    expect(summary).toMatchObject({
      timeZone: 'America/Chicago',
      localDate: '2026-09-13',
      movie: null,
      cinema: null,
      screen: null,
    });
  });

  it('leaves the film out while the film itself is unpublished', async () => {
    const { service } = makeService(
      screening({ event: { ...screening().event, movie: { ...film, status: 'DRAFT' } } }),
    );
    await expect(service.getPublicShowSummary('sess1')).resolves.toMatchObject({ movie: null });
  });

  it.each([
    [
      'a show whose event is not published',
      screening({ event: { ...screening().event, status: 'DRAFT' } }),
    ],
    ['a show that does not exist', null],
  ])('answers "not found" for %s', async (_case, session) => {
    // The layout's terms: nothing about an unpublished event is public, not even that it exists.
    const { service } = makeService(session);
    await expect(service.getPublicShowSummary('sess1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('still answers when a stored zone is one Intl does not know', async () => {
    const { service } = makeService(
      screening({
        screen: {
          ...screening().screen,
          cinema: { id: 'cin1', name: 'X', timezone: 'Mars/Olympus' },
        },
      }),
    );
    await expect(service.getPublicShowSummary('sess1')).resolves.toMatchObject({
      localDate: '2026-09-13',
    });
  });
});
