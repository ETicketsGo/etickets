import 'reflect-metadata';

/**
 * unit - every route that accepts a credential is rate limited, at the production default.
 *
 * ── WHY THIS FILE EXISTS ───────────────────────────────────────────────────────────────
 * The throttle on the credential routes had no test of any kind. The decorators were there,
 * and nothing would have noticed a new auth route shipping without one - which is the way this
 * control actually fails. Nobody removes `@Throttle` from `login`; somebody adds
 * `POST /auth/something-new` and forgets it, and the gap is invisible in review.
 *
 * So this enumerates the controller's handlers rather than naming them, and a new credential
 * route must either carry the throttle or be added to the exemptions below with a reason.
 *
 * It also pins the DEFAULT. Production sets no `AUTH_THROTTLE_LIMIT`, so the default IS the
 * production limit: a test that sets the variable proves nothing about the deployed system.
 */

/* `@Throttle({ default: ... })` records these per named throttler. */
const LIMIT = 'THROTTLER:LIMITdefault';
const TTL = 'THROTTLER:TTLdefault';

/**
 * Handlers that legitimately carry no throttle, with the reason.
 *
 * Both require a valid token already, so neither is a route anybody can guess their way
 * through. Adding to this list is a deliberate act that has to survive review.
 */
const EXEMPT: Record<string, string> = {
  logout: 'needs a valid refresh token; nothing to guess',
  me: 'needs a valid access token; returns only your own record',
};

describe('the credential routes are rate limited', () => {
  /* Imported fresh with the variable unset, so we read the production default. */
  function controllerWithProductionEnv() {
    const saved = process.env.AUTH_THROTTLE_LIMIT;
    delete process.env.AUTH_THROTTLE_LIMIT;
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('./auth.controller') as typeof import('./auth.controller');
    if (saved !== undefined) process.env.AUTH_THROTTLE_LIMIT = saved;
    return mod.AuthController;
  }

  function handlers(controller: unknown) {
    const proto = (controller as unknown as { prototype: object }).prototype;
    return Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
  }

  it('throttles every handler that is not explicitly exempt', () => {
    const controller = controllerWithProductionEnv();
    const unthrottled = handlers(controller).filter((name) => {
      const fn = (controller as unknown as { prototype: Record<string, object> }).prototype[name];
      return Reflect.getMetadata(LIMIT, fn) === undefined && !(name in EXEMPT);
    });
    /*
      If this fails, a credential route shipped without a limit. Add the throttle - do not add
      the route to EXEMPT unless it genuinely cannot be guessed at.
    */
    expect(unthrottled).toEqual([]);
  });

  it('still covers the routes that matter most, by name', () => {
    // Belt and braces: the enumeration above cannot silently shrink to nothing.
    const controller = controllerWithProductionEnv();
    const proto = (controller as unknown as { prototype: Record<string, object> }).prototype;
    for (const route of ['login', 'register', 'forgotPassword', 'resetPassword', 'refresh']) {
      // A failure names the route in the loop output above.
      expect(Reflect.getMetadata(LIMIT, proto[route])).toBeDefined();
    }
  });

  it('allows ten attempts a minute when nothing is configured', () => {
    /*
      THE PRODUCTION NUMBER. PROD sets no AUTH_THROTTLE_LIMIT, so this default is the live
      limit on password guessing and on OTP requests that cost us an SMS each.
    */
    const controller = controllerWithProductionEnv();
    const proto = (controller as unknown as { prototype: Record<string, object> }).prototype;
    expect(Reflect.getMetadata(LIMIT, proto.login)).toBe(10);
    expect(Reflect.getMetadata(TTL, proto.login)).toBe(60_000);
  });

  it('keeps the exemptions honest', () => {
    // An exemption for a route that no longer exists is a stale claim about the attack surface.
    const controller = controllerWithProductionEnv();
    const names = handlers(controller);
    for (const exempt of Object.keys(EXEMPT)) {
      expect(names).toContain(exempt);
    }
  });
});
