import { eventIdFilter, payableBookingWhere } from './payouts.service';

describe('eventIdFilter', () => {
  it('is empty with no scope and nothing claimed', () => {
    expect(eventIdFilter(undefined, [])).toEqual({});
  });

  it('excludes claimed events for an organization-wide request', () => {
    expect(eventIdFilter(undefined, ['x'])).toEqual({ eventId: { notIn: ['x'] } });
  });

  it('keeps the requested event when nothing is claimed', () => {
    expect(eventIdFilter('a', [])).toEqual({ eventId: 'a' });
  });

  it('applies BOTH the requested event and the exclusion, never one in place of the other', () => {
    expect(eventIdFilter('a', ['a'])).toEqual({ eventId: { equals: 'a', notIn: ['a'] } });
  });

  it('reaches the booking predicate as a single condition', () => {
    const where = payableBookingWhere({
      organizationId: 'o',
      eventId: 'a',
      eventFilter: {},
      transferredEventIds: ['a'],
      bookingWindows: [],
      eventSettled: [],
    });
    expect(where.eventId).toEqual({ equals: 'a', notIn: ['a'] });
  });
});
