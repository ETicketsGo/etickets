import { QuietBootLogger, quietBootLogger } from './quiet-boot-logger';

/**
 * The point of this logger is what it does NOT print. A boot failure that arrives behind a
 * thousand route-mapping lines is dropped by Railway's 500 logs/sec limit, so these tests pin
 * both halves: the inventory goes, everything else stays.
 */
describe('quietBootLogger', () => {
  it('keeps Nest default in LOCAL and DEV, where the route list is useful', () => {
    expect(quietBootLogger('LOCAL')).toBeUndefined();
    expect(quietBootLogger('dev')).toBeUndefined();
    expect(quietBootLogger(undefined)).toBeUndefined();
  });

  it('quiets QA, UAT and PRODUCTION', () => {
    // Keyed on APP_ENV, because QA and UAT both run NODE_ENV=production.
    for (const env of ['QA', 'UAT', 'STAGING', 'PRODUCTION']) {
      expect(quietBootLogger(env)).toBeInstanceOf(QuietBootLogger);
    }
  });
});

describe('QuietBootLogger', () => {
  let printed: string[];
  let logger: QuietBootLogger;

  beforeEach(() => {
    printed = [];
    logger = new QuietBootLogger();
    // ConsoleLogger writes through printMessages; capture at the stream instead so the real
    // class under test is exercised rather than a stub of it.
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    });
    jest.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      printed.push(String(chunk));
      return true;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it('drops the per-route boot inventory', () => {
    logger.log('Mapped {/api/events, GET} route', 'RouterExplorer');
    logger.log('EventsController {/api/events}:', 'RoutesResolver');
    expect(printed.join('')).toBe('');
  });

  it('keeps the line that says the API is up', () => {
    logger.log('ETicketsGo API listening on 0.0.0.0:8080/api', 'Bootstrap');
    expect(printed.join('')).toContain('ETicketsGo API listening');
  });

  it('keeps a boot guard finding, which is the message that used to be dropped', () => {
    /*
      This is the exact line a production deploy lost behind 803 dropped messages. It is written at
      `log` level from its own context, which is why the filter is by context and not by level.
    */
    logger.log('[payments:PRODUCTION] bootstrapped razorpay:LIVE', 'PaymentConfigService');
    expect(printed.join('')).toContain('razorpay:LIVE');
  });

  it('never touches errors or warnings', () => {
    logger.error('Payment configuration is invalid in PRODUCTION', 'PaymentConfigService');
    logger.warn("Could not bind provider 'razorpay'", 'PaymentProviderFactory');
    const out = printed.join('');
    expect(out).toContain('Payment configuration is invalid');
    expect(out).toContain('Could not bind provider');
  });

  it('keeps a log call that carries no context', () => {
    // A bare `logger.log('...')` must not be mistaken for inventory.
    logger.log('something worth reading');
    expect(printed.join('')).toContain('something worth reading');
  });
});
