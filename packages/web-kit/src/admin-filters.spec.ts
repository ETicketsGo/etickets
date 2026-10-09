import { describe, expect, it } from 'vitest';
import { describeFilters, dayWindowInverted, enumLabel, parseDayParam } from './admin-filters';

/**
 * The admin queues' filter bar, the parts that do not need a browser.
 *
 *  - A date in the URL is passed on only when it is a real day; anything else is dropped rather
 *    than sent to the API, which would answer 400 and empty the list.
 *  - The empty state names every filter in force, and names the dates as UTC days.
 */
describe('parseDayParam', () => {
  it('passes a real day through', () => {
    expect(parseDayParam('2026-10-09')).toBe('2026-10-09');
    expect(parseDayParam(' 2024-02-29 ')).toBe('2024-02-29');
  });

  it.each([null, undefined, '', '2026-02-30', '2026-13-01', '09/10/2026', '2026-10-9', 'today'])(
    'drops %p',
    (raw) => {
      expect(parseDayParam(raw)).toBeUndefined();
    },
  );
});

describe('dayWindowInverted', () => {
  it('is true only when the end is before the start', () => {
    expect(dayWindowInverted('2026-10-09', '2026-10-01')).toBe(true);
    expect(dayWindowInverted('2026-10-01', '2026-10-01')).toBe(false);
    expect(dayWindowInverted('2026-10-01', undefined)).toBe(false);
  });
});

describe('describeFilters', () => {
  it('is empty when nothing is filtered', () => {
    expect(describeFilters({})).toBe('');
  });

  it('names every filter in force, in words', () => {
    expect(
      describeFilters({
        status: 'PARTIALLY_REFUNDED',
        extra: [{ name: 'Kind', value: 'COMPLAINT' }],
        country: 'IN',
        organizer: 'Aurora Events',
        event: 'Diwali Night',
        from: '2026-10-01',
        to: '2026-10-09',
        q: 'ada',
      }),
    ).toBe(
      'status Partially refunded, kind Complaint, country India, organizer Aurora Events, ' +
        'event Diwali Night, from 1 Oct 2026 to 9 Oct 2026 (UTC), search "ada"',
    );
  });

  it('reads the dates as UTC days, whatever zone the browser is in', () => {
    // The last day of a month is where a local-time conversion shows: in any zone west of UTC
    // midnight on the 31st is still the 30th.
    expect(describeFilters({ from: '2026-10-31', to: '2026-10-31' })).toBe('on 31 Oct 2026 (UTC)');
    expect(describeFilters({ to: '2026-01-01' })).toBe('up to 1 Jan 2026 (UTC)');
  });

  it('spells an enum the way a person says it', () => {
    expect(enumLabel('TRANSFER_PROCESSING')).toBe('Transfer processing');
  });
});
