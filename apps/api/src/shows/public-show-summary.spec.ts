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

  it('puts a room in a venue (no cinema) on the venue clock, not on no clock', async () => {
    /*
      Found on QA: every seated room that is not a cinema screen answered `timeZone: null`, so
      the seat page header printed the READER's clock - an 11:01 pm Hyderabad show read
      "10:31 am" in a Denver browser while its booking said 11:01 pm GMT+5:30.
    */
    const { service } = makeService(
      screening({
        startsAt: new Date('2026-11-12T17:31:00Z'),
        event: { ...screening().event, experienceType: 'EVENT', movie: null },
        screen: { name: 'Main Auditorium', screenType: '2D', cinema: null },
      }),
    );
    const summary = await service.getPublicShowSummary('sess1');
    expect(summary).toMatchObject({ timeZone: 'Asia/Kolkata', localDate: '2026-11-12' });
  });

  it('falls back to the only zone the venue country has when the venue has none', async () => {
    const { service } = makeService(
      screening({
        event: {
          ...screening().event,
          venue: { name: 'Hall', city: 'Hyderabad', country: 'India', timezone: null },
        },
        screen: { name: 'Main Auditorium', screenType: '2D', cinema: null },
      }),
    );
    expect((await service.getPublicShowSummary('sess1')).timeZone).toBe('Asia/Kolkata');
  });

  it("gives a cinema screen the venue's clock, as the ticket does (T2)", async () => {
    // The booking, the ticket and the reminder print the show on the venue's clock; this cinema
    // row kept the schema default Asia/Kolkata, which on a Boise venue can only be the default.
    const { service } = makeService(
      screening({
        event: {
          ...screening().event,
          venue: {
            name: 'Hall',
            city: 'Boise',
            country: 'United States',
            timezone: 'America/Boise',
          },
        },
      }),
    );
    expect((await service.getPublicShowSummary('sess1')).timeZone).toBe('America/Boise');
  });

  it('gives no projection format for a space that is not a cinema screen', async () => {
    /*
      Every space has a screenType, defaulting to "2D". A basketball game in an arena was
      badged "2D" on its seat page, as if it were a film. Format is a cinema screen's fact.
    */
    const { service } = makeService(
      screening({
        event: { ...screening().event, experienceType: 'EVENT', movie: null },
        screen: { name: 'Main Arena', screenType: '2D', cinema: null },
      }),
    );
    const summary = await service.getPublicShowSummary('sess1');
    expect(summary.screen).toEqual({ name: 'Main Arena', format: null });
    expect(summary.cinema).toBeNull();
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
          // On the space's venue, which is read first (`showTimezone`).
          venue: { timezone: 'Mars/Olympus', country: null },
          cinema: { id: 'cin1', name: 'X', timezone: 'Mars/Olympus' },
        },
      }),
    );
    await expect(service.getPublicShowSummary('sess1')).resolves.toMatchObject({
      localDate: '2026-09-13',
    });
  });
});
