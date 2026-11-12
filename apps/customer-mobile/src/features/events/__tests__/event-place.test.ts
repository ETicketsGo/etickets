import { eventPlace, isOnlineOnly } from '../event-place';

/**
 * An online event still carries a placeholder venue (name and a city, for discovery). The app
 * printed it, and offered directions to it. Same rule as the website's lib/event-place.ts.
 */
describe('eventPlace', () => {
  const venue = { name: 'Chelsea Studio Nine', city: 'New York' };

  it('names the venue for an in-person event', () => {
    expect(eventPlace({ venue, attendanceMode: 'IN_PERSON' }).full).toBe(
      'Chelsea Studio Nine, New York',
    );
    expect(eventPlace({ venue }).full).toBe('Chelsea Studio Nine, New York');
  });

  it('says Online, and nothing about the placeholder venue, for an online event', () => {
    const place = eventPlace({
      venue: { name: 'QA Online', city: 'Boise' },
      attendanceMode: 'ONLINE',
    });
    expect(place).toEqual({ full: 'Online', name: 'Online', city: '' });
    expect(isOnlineOnly({ attendanceMode: 'ONLINE' })).toBe(true);
  });

  it('adds Online to the venue for a hybrid event', () => {
    expect(eventPlace({ venue, attendanceMode: 'HYBRID' }).full).toBe(
      'Chelsea Studio Nine, New York + Online',
    );
    expect(isOnlineOnly({ attendanceMode: 'HYBRID' })).toBe(false);
  });
});
