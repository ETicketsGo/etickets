import {
  CINEMA_DEFAULT_TIMEZONE,
  requireSpaceOrganizationId,
  showTimezone,
  spaceOrganizationId,
  spaceTimezone,
  spaceVenueName,
} from './space-owner';

/**
 * Who owns a space, where it is, and what it is called.
 *
 * -- THE DEFECT THAT PUT THIS FILE HERE ---------------------------------------------------
 * When a space gained its own venue, `spaceTimezone` was written to prefer the venue, as
 * ownership and naming do. It shipped past 4,970 green API tests and was caught by one e2e
 * twelve minutes into CI:
 *
 *     a Sydney cinema's 00:30 show was stored and reported as 06:00
 *
 * which is exactly the IST offset. `Venue.timezone` is NOT NULL with a default of
 * `Asia/Kolkata`, so a venue nobody had asked for a zone claimed one, and that guess shadowed
 * the cinema's real answer.
 *
 * Every assertion about precedence below exists so that inversion fails here, in
 * milliseconds, instead of in a browser.
 */
describe('resolving a space to its owner, its zone and its place', () => {
  const venue = {
    organizationId: 'org-venue',
    name: 'Phoenix Arena',
    timezone: 'Australia/Sydney',
  };
  const cinema = { organizationId: 'org-cinema', name: 'PVR Whitefield', timezone: 'Asia/Kolkata' };

  describe('ownership comes from the venue', () => {
    it('prefers the venue', () => {
      expect(spaceOrganizationId({ venue, cinema })).toBe('org-venue');
    });

    it('falls back to the cinema for a row written before the venue column', () => {
      expect(spaceOrganizationId({ venue: null, cinema })).toBe('org-cinema');
    });

    it('answers null rather than something that would pass a membership check', () => {
      /*
        A plausible-looking id here would turn a broken row into a silent cross-tenant read,
        which is the worst outcome available.
      */
      expect(spaceOrganizationId({ venue: null, cinema: null })).toBeNull();
    });

    it('throws for callers that cannot continue without one', () => {
      // There is no safe default for "which tenant does this belong to".
      expect(() => requireSpaceOrganizationId({ venue: null, cinema: null })).toThrow();
    });
  });

  describe('the timezone comes from the venue, now that a venue can say "not asked"', () => {
    it('prefers the venue when it actually has a zone', () => {
      expect(
        spaceTimezone({
          venue: { timezone: 'America/Chicago' },
          cinema: { timezone: 'Asia/Kolkata' },
        }),
      ).toBe('America/Chicago');
    });

    it('falls through to the cinema when the venue was never asked', () => {
      /*
        THE SYDNEY DEFECT, AND WHY IT IS FIXED RATHER THAN INVERTED.

        While `Venue.timezone` defaulted to Asia/Kolkata, "the venue says Asia/Kolkata" could
        not be told apart from "nobody asked the venue" - so venue-first stored a Sydney 00:30
        show as 06:00. The column is nullable now, so an unasked venue answers NULL and `??`
        falls through to the zone the operator actually chose.
      */
      expect(
        spaceTimezone({ venue: { timezone: null }, cinema: { timezone: 'Australia/Sydney' } }),
      ).toBe('Australia/Sydney');
    });

    it('uses the venue when there is no cinema at all', () => {
      // An arena or an auditorium has no cinema, so the venue is the only source there is.
      expect(spaceTimezone({ venue: { timezone: 'America/Chicago' }, cinema: null })).toBe(
        'America/Chicago',
      );
    });

    it('returns null rather than inventing a zone', () => {
      /*
        Never silently the launch market's. A hardcoded zone has produced two real defects on
        this track, and a wrong zone on a ticket face is a customer at a door on the wrong day.
      */
      expect(spaceTimezone({ venue: null, cinema: null })).toBeNull();
    });
  });

  describe('the place is the venue', () => {
    it('names the venue, not the cinema', () => {
      // `listSeatingRooms` returned the cinema's name as `venueName`, so the event wizard
      // labelled a space's venue with its tenant's name.
      expect(spaceVenueName({ venue, cinema })).toBe('Phoenix Arena');
    });

    it('falls back to the cinema when a space has no venue yet', () => {
      expect(spaceVenueName({ venue: null, cinema })).toBe('PVR Whitefield');
    });
  });
});

/**
 * `showTimezone`: the ONE answer to "whose clock is this show printed on" for a buyer.
 *
 * T2, QA 2026-10-17: the ticket, booking, guest view, share card, reminders and emails read the
 * CINEMA first. `Cinema.timezone` defaults to Asia/Kolkata, so "Move Hall" - a cinema in a Boise
 * venue - printed a 9:59 am show as "10:29 pm GMT+5:30" on its ticket and in its emails.
 */
describe('showTimezone', () => {
  const boise = { timezone: 'America/Boise', country: 'United States' };

  it('prefers the space venue over a cinema left at the default', () => {
    expect(
      showTimezone({ venue: boise, cinema: { timezone: CINEMA_DEFAULT_TIMEZONE } }, boise),
    ).toBe('America/Boise');
  });

  it('prefers the event venue when the space has no venue row yet', () => {
    expect(showTimezone({ venue: null, cinema: { timezone: 'Asia/Kolkata' } }, boise)).toBe(
      'America/Boise',
    );
  });

  it('prefers the venue even over a cinema zone that was chosen', () => {
    expect(showTimezone({ venue: boise, cinema: { timezone: 'America/Chicago' } }, null)).toBe(
      'America/Boise',
    );
  });

  it('uses the cinema zone when no venue has one', () => {
    const noZone = { timezone: null, country: 'United States' };
    expect(showTimezone({ venue: noZone, cinema: { timezone: 'America/Chicago' } }, noZone)).toBe(
      'America/Chicago',
    );
  });

  it('treats the Kolkata default as unset on a place known to be outside India', () => {
    // Unknown, so the page shows the reader's clock and says so. Never a confident wrong zone.
    const noZone = { timezone: null, country: 'United States' };
    expect(
      showTimezone({ venue: noZone, cinema: { timezone: CINEMA_DEFAULT_TIMEZONE } }, noZone),
    ).toBeNull();
    // A one-zone country still answers.
    const uk = { timezone: null, country: 'United Kingdom' };
    expect(showTimezone({ venue: uk, cinema: { timezone: 'Asia/Kolkata' } }, uk)).toBe(
      'Europe/London',
    );
  });

  it('leaves an Indian cinema exactly as it was', () => {
    const india = { timezone: null, country: 'India' };
    expect(showTimezone({ venue: india, cinema: { timezone: 'Asia/Kolkata' } }, india)).toBe(
      'Asia/Kolkata',
    );
    const kolkata = { timezone: 'Asia/Kolkata', country: 'India' };
    expect(showTimezone({ venue: kolkata, cinema: { timezone: 'Asia/Kolkata' } }, kolkata)).toBe(
      'Asia/Kolkata',
    );
  });

  it('keeps a cinema zone when nobody recorded a country', () => {
    expect(showTimezone({ cinema: { timezone: 'Asia/Kolkata' } }, null)).toBe('Asia/Kolkata');
  });

  it("falls back to the country's only zone, else null", () => {
    expect(showTimezone(null, { timezone: null, country: 'IN' })).toBe('Asia/Kolkata');
    expect(showTimezone(null, { timezone: null, country: 'US' })).toBeNull();
    expect(showTimezone(null, null)).toBeNull();
  });
});
