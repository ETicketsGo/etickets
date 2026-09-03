import { HttpStatus } from '@nestjs/common';
import { metricsAccess } from '@eticketsgo/shared-types';
import { MetricsAccessGuard } from './metrics-access.guard';
import { AppException } from '../common/errors';

/**
 * Who may read the metrics.
 *
 * ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────────────
 * The route carried a comment saying it "MUST be network-restricted to the metrics
 * scraper only". No such restriction existed — on Railway a service either has a public
 * domain or it does not, and the API has one. Probed on both live environments, GET
 * /api/metrics returned 200 to an unauthenticated request, and among the 413 lines was:
 *
 *     etg_gmv_minor_total   gross merchandise value, summed on booking confirm
 *
 * On QA that is test data. In production it is revenue.
 *
 * ── WHY THE RULE IS TESTED SEPARATELY FROM THE GUARD ───────────────────────────────
 * Two processes serve metrics and only one of them has Nest in it. The rule is a pure
 * function so the worker's raw `http.createServer` handler reaches the same verdict; the
 * guard is a thin translation of that verdict into HTTP. They are tested as what they are.
 */
describe('metricsAccess — the rule', () => {
  const base = { token: undefined, authorization: undefined, appEnv: undefined };

  describe('when a scrape token is configured', () => {
    const token = 'a-long-enough-scrape-token';

    it('lets the scraper in with the right bearer token', () => {
      expect(metricsAccess({ ...base, token, authorization: `Bearer ${token}` })).toBe('allow');
    });

    it('accepts the header however it is cased or spaced', () => {
      // Prometheus, curl and a hand-written probe do not agree on this, and none of them
      // is wrong.
      for (const header of [`bearer ${token}`, `BEARER ${token}`, `Bearer   ${token}  `]) {
        expect(metricsAccess({ ...base, token, authorization: header })).toBe('allow');
      }
    });

    it('refuses a request with no credential at all', () => {
      expect(metricsAccess({ ...base, token })).toBe('unauthorized');
    });

    it('refuses a wrong token, a prefix of the token, and the token plus a suffix', () => {
      /*
        The prefix case is the one worth stating: a comparison that stops at the first
        differing byte would still reject these, but it would take measurably longer to
        reject a long correct prefix than a short one, which is how a token gets guessed a
        byte at a time.
      */
      const wrong = ['nope', token.slice(0, -1), `${token}x`, ''];
      expect(
        wrong.map((w) => metricsAccess({ ...base, token, authorization: `Bearer ${w}` })),
      ).toEqual(['unauthorized', 'unauthorized', 'unauthorized', 'unauthorized']);
    });

    it('refuses a credential presented under some other scheme', () => {
      expect(metricsAccess({ ...base, token, authorization: `Basic ${token}` })).toBe(
        'unauthorized',
      );
    });

    it('applies in EVERY environment, including a developer machine', () => {
      // Configuring a token is an explicit act. Honouring it only in production would mean
      // the thing you set up locally to test the scraper does not actually gate anything.
      for (const appEnv of ['LOCAL', 'DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION']) {
        expect(metricsAccess({ ...base, token, appEnv })).toBe('unauthorized');
      }
    });
  });

  describe('when NO scrape token is configured', () => {
    it('stays open on a developer machine, so dev and the test suites are untouched', () => {
      for (const appEnv of ['LOCAL', 'DEV', 'local', undefined]) {
        expect(metricsAccess({ ...base, appEnv })).toBe('allow');
      }
    });

    it('turns the endpoint OFF in every deployed environment', () => {
      /*
        The asymmetry is the whole design. An unset token in a deployed environment means
        somebody shipped without configuring it, and the safe reading of that is "metrics
        are unavailable" — not "metrics are available to everyone", which is the reading
        that published GMV.
      */
      for (const appEnv of ['QA', 'UAT', 'STAGING', 'PRODUCTION']) {
        expect(metricsAccess({ ...base, appEnv })).toBe('disabled');
      }
    });

    it('keys on APP_ENV, NOT on NODE_ENV', () => {
      /*
        QA and UAT both run NODE_ENV=production on Railway, so a rule keyed on NODE_ENV
        would call a developer's machine "production" the moment anything set it — and,
        worse, would have called QA production and looked correct while doing so.

        Set NODE_ENV to production around a LOCAL call: the verdict must not move.
      */
      const original = process.env.NODE_ENV;
      try {
        process.env.NODE_ENV = 'production';
        expect(metricsAccess({ ...base, appEnv: 'LOCAL' })).toBe('allow');
        process.env.NODE_ENV = 'development';
        expect(metricsAccess({ ...base, appEnv: 'PRODUCTION' })).toBe('disabled');
      } finally {
        process.env.NODE_ENV = original;
      }
    });

    it('treats a blank or whitespace token as unset rather than as a password', () => {
      // `METRICS_TOKEN=""` in a Railway variable is an easy thing to end up with, and it
      // must not become a credential that an empty Authorization header satisfies.
      expect(metricsAccess({ ...base, token: '   ', appEnv: 'QA' })).toBe('disabled');
    });
  });
});

describe('MetricsAccessGuard — the rule as HTTP', () => {
  const guard = (env: Record<string, string | undefined>, authorization?: string) => {
    const g = new MetricsAccessGuard({ get: (k: string) => env[k] } as never);
    const context = {
      switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
    };
    return () => g.canActivate(context as never);
  };

  it('admits an authorised scrape', () => {
    expect(
      guard(
        { METRICS_TOKEN: 'a-long-enough-scrape-token', APP_ENV: 'QA' },
        'Bearer a-long-enough-scrape-token',
      )(),
    ).toBe(true);
  });

  it('answers 404 when no token is configured, so the route reads as absent', () => {
    /*
      Not 403. "Forbidden" confirms to anyone asking that there IS a metrics endpoint here
      worth coming back for once they have a credential.
    */
    let thrown: AppException | undefined;
    try {
      guard({ APP_ENV: 'PRODUCTION' })();
    } catch (e) {
      thrown = e as AppException;
    }
    expect(thrown).toBeInstanceOf(AppException);
    expect(thrown!.getStatus()).toBe(HttpStatus.NOT_FOUND);
  });

  it('answers 401 when a token IS configured and the request failed it', () => {
    // The distinction is for whoever is debugging a scraper. It tells an attacker nothing
    // they could not learn by trying an empty token.
    let thrown: AppException | undefined;
    try {
      guard({ METRICS_TOKEN: 'a-long-enough-scrape-token', APP_ENV: 'PRODUCTION' }, 'Bearer no')();
    } catch (e) {
      thrown = e as AppException;
    }
    expect(thrown!.getStatus()).toBe(HttpStatus.UNAUTHORIZED);
  });

  it('lets a developer machine through untouched', () => {
    // Nothing about local development, jest, vitest or Playwright changes.
    expect(guard({})()).toBe(true);
  });
});
