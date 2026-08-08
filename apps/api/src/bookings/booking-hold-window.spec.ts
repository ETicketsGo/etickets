import { BookingsService } from './bookings.service';

/**
 * The unpaid-hold window is configuration, not a constant.
 *
 * It was `const HOLD_MINUTES = 10` in the service. A hold window is a commercial decision —
 * cinemas run tighter windows than festivals, and QA needs a short one to exercise expiry
 * without waiting out the production value — so it now comes from BOOKING_HOLD_MINUTES.
 *
 * The client never learns the duration: it renders the server's `holdExpiresAt`, so the
 * countdown follows this automatically and cannot disagree with what the server enforces.
 *
 * `holdMinutes` is private, and these reach it deliberately. The alternative is driving the
 * whole of `create()` with a dozen mocks to observe one arithmetic result, which would test
 * the mocks more than the wiring.
 */
const holdMinutesOf = (service: BookingsService): number =>
  (service as unknown as { holdMinutes: number }).holdMinutes;

/** The service takes nine collaborators before the optional ConfigService. */
const build = (config?: { get: (k: string) => unknown }): BookingsService =>
  new BookingsService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    config as never,
  );

describe('booking hold window', () => {
  it('uses the configured number of minutes', () => {
    expect(holdMinutesOf(build({ get: () => 5 }))).toBe(5);
  });

  it('honours a different value, so the setting is really read', () => {
    expect(holdMinutesOf(build({ get: () => 20 }))).toBe(20);
  });

  it('reads the BOOKING_HOLD_MINUTES key specifically', () => {
    const get = jest.fn().mockReturnValue(7);
    expect(holdMinutesOf(build({ get }))).toBe(7);
    expect(get).toHaveBeenCalledWith('BOOKING_HOLD_MINUTES');
  });

  it('falls back to 10 when no ConfigService was injected', () => {
    // Many existing unit tests construct this service positionally without a config, and
    // must keep the historical window rather than silently changing behaviour.
    expect(holdMinutesOf(build(undefined))).toBe(10);
  });

  describe('never yields a hold that cannot expire', () => {
    // Every one of these, used directly in `now + minutes * 60_000`, produces either an
    // Invalid Date or a hold in the past — a seat locked forever, or released instantly.
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['zero', 0],
      ['negative', -5],
      ['a string', '15'],
    ])('rejects %s and uses the default', (_label, value) => {
      const minutes = holdMinutesOf(build({ get: () => value }));
      expect(minutes).toBe(10);
      expect(Number.isFinite(new Date(Date.now() + minutes * 60_000).getTime())).toBe(true);
    });
  });

  it('produces a future expiry from the configured window', () => {
    const minutes = holdMinutesOf(build({ get: () => 3 }));
    const now = Date.now();
    const expiry = new Date(now + minutes * 60_000).getTime();
    expect(expiry).toBeGreaterThan(now);
    expect(expiry - now).toBe(3 * 60_000);
  });
});
