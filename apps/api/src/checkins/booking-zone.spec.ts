import { bookingZone } from './checkins.service';

/*
  The counter's booking search printed a 7:00 pm Bengaluru lawn concert as "6:30 am" to an
  organizer in Denver: the zone was read from the space's CINEMA only, and a lawn has none.
*/
describe('bookingZone', () => {
  const india = { timezone: null, country: 'India' };

  it('answers for a space that is not a cinema screen, from its venue', () => {
    expect(
      bookingZone(india, { venue: { timezone: 'Asia/Kolkata', country: 'India' }, cinema: null }),
    ).toBe('Asia/Kolkata');
  });

  it('falls back to the only zone the event venue country has', () => {
    expect(bookingZone(india, { venue: null, cinema: null })).toBe('Asia/Kolkata');
    expect(bookingZone(india, null)).toBe('Asia/Kolkata');
  });

  it('keeps the cinema zone for a cinema screen whose venue has none', () => {
    expect(
      bookingZone(
        { timezone: null, country: 'US' },
        { venue: { timezone: null, country: 'US' }, cinema: { timezone: 'America/Chicago' } },
      ),
    ).toBe('America/Chicago');
  });

  it('prefers the space venue zone over the cinema', () => {
    expect(
      bookingZone(india, {
        venue: { timezone: 'America/Denver', country: 'US' },
        cinema: { timezone: 'Asia/Kolkata' },
      }),
    ).toBe('America/Denver');
  });

  it('says it does not know rather than guessing for a multi-zone country', () => {
    expect(
      bookingZone(
        { timezone: null, country: 'US' },
        { venue: { timezone: null, country: 'US' }, cinema: null },
      ),
    ).toBeNull();
  });
});
