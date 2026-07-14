import { reportQueryEvent, resolveSlowQueryMs } from './prisma.service';

describe('reportQueryEvent (slow-query reporting)', () => {
  const makeMetrics = () => ({ observeDbQuery: jest.fn() });

  it('observes the histogram for every query but only logs+counts over threshold', () => {
    const metrics = makeMetrics();
    const logWarn = jest.fn();

    // Under threshold: observed, not slow, no log.
    reportQueryEvent({ duration: 20, target: 'Booking' }, 500, metrics, logWarn);
    expect(metrics.observeDbQuery).toHaveBeenCalledWith(0.02, false);
    expect(logWarn).not.toHaveBeenCalled();

    // Over threshold: observed as slow AND logged.
    reportQueryEvent({ duration: 750, target: 'Payment' }, 500, metrics, logWarn);
    expect(metrics.observeDbQuery).toHaveBeenLastCalledWith(0.75, true);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('emits a structured JSON warn line with duration + target but no SQL/params', () => {
    const logWarn = jest.fn();
    reportQueryEvent({ duration: 900, target: 'Ticket' }, 500, makeMetrics(), logWarn);
    const parsed = JSON.parse(logWarn.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ level: 'warn', msg: 'slow query', ms: 900, target: 'Ticket' });
    // Never leak query text or params.
    expect(Object.keys(parsed)).not.toContain('query');
    expect(Object.keys(parsed)).not.toContain('params');
  });

  it('is best-effort: a throwing metrics sink does not propagate', () => {
    const metrics = {
      observeDbQuery: () => {
        throw new Error('boom');
      },
    };
    expect(() =>
      reportQueryEvent({ duration: 800, target: 'X' }, 500, metrics, jest.fn()),
    ).not.toThrow();
  });

  it('resolves SLOW_QUERY_MS from env with a 500ms default', () => {
    expect(resolveSlowQueryMs(undefined)).toBe(500);
    expect(resolveSlowQueryMs('250')).toBe(250);
    expect(resolveSlowQueryMs('not-a-number')).toBe(500);
    expect(resolveSlowQueryMs('0')).toBe(500);
  });
});
