import { Reflector } from '@nestjs/core';
import {
  AllowMfaPending,
  Public,
  RequiresRecentMfa,
  type RequestUser,
} from '../../common/decorators';
import { MfaGuard } from './mfa.guard';

/*
  The guard in isolation: the cases that are awkward to reach over HTTP (no MFA state at all,
  a stale check) and the decision table for the rest. The over-the-wire proof that EVERY route
  is covered is the enumeration test in admin-mfa.http.integration-postgres.spec.ts; the
  deferred-enrollment journey is admin-mfa-deferred.http.integration-postgres.spec.ts.
*/
class Routes {
  plain() {
    return 'x';
  }
  @Public()
  open() {
    return 'x';
  }
  @AllowMfaPending()
  pending() {
    return 'x';
  }
  @RequiresRecentMfa()
  sensitive() {
    return 'x';
  }
}

type State = NonNullable<RequestUser['mfa']>;

const state = (over: Partial<State> = {}): State => ({
  required: true,
  enrolled: true,
  verified: true,
  verifiedAt: Date.now(),
  stepUp: 'available',
  ...over,
});
/** A back-office account that does not need MFA for the console (deferred, or no key). */
const relaxed = (stepUp: State['stepUp']): State => ({
  required: false,
  enrolled: false,
  verified: false,
  verifiedAt: null,
  stepUp,
});
const user = (roles: string[], mfa?: RequestUser['mfa']) =>
  ({ id: 'u', email: 'e', fullName: 'n', roles, mfa }) as RequestUser;

function run(handler: keyof Routes, u: RequestUser | undefined, record = jest.fn()) {
  record.mockResolvedValue(undefined);
  const guard = new MfaGuard(new Reflector(), {
    stepUpMs: 10 * 60_000,
    recordSensitiveRefusal: record,
  } as never);
  const ctx = {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({
      getRequest: () => ({ user: u, method: 'POST', path: `/${handler}`, headers: {} }),
    }),
  };
  return () => guard.canActivate(ctx as never);
}

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERROR';
  }
}

describe('MfaGuard decision table', () => {
  it('passes customers and organizers whatever their MFA state says', async () => {
    expect(await run('plain', user(['CUSTOMER']))()).toBe(true);
    expect(await run('plain', user(['ORGANIZER_OWNER'], state({ verified: false })))()).toBe(true);
    // An organizer refunding their own customer has no second factor to give.
    expect(await run('sensitive', user(['ORGANIZER_OWNER']))()).toBe(true);
  });

  it('passes a verified back-office session', async () => {
    expect(await run('plain', user(['ADMIN'], state()))()).toBe(true);
    expect(await run('plain', user(['SUPER_ADMIN'], state()))()).toBe(true);
  });

  it('refuses an unverified back-office session, enrolled or not, with MFA_REQUIRED', async () => {
    for (const s of [state({ verified: false }), state({ verified: false, enrolled: false })]) {
      expect(await codeOf(run('plain', user(['ADMIN'], s)))).toBe('MFA_REQUIRED');
    }
  });

  it('FAILS CLOSED: a back-office user with no MFA state at all is refused', async () => {
    expect(await codeOf(run('plain', user(['SUPER_ADMIN'], undefined)))).toBe('MFA_REQUIRED');
    expect(await codeOf(run('sensitive', user(['SUPER_ADMIN'], undefined)))).toBe('MFA_REQUIRED');
  });

  it('lets an unverified session reach only the routes that declare @AllowMfaPending', async () => {
    const s = state({ verified: false, enrolled: false });
    expect(await run('pending', user(['ADMIN'], s))()).toBe(true);
    expect(await codeOf(run('plain', user(['ADMIN'], s)))).toBe('MFA_REQUIRED');
  });

  it('dormant developer machine (no key, required mode): every route passes, as before', async () => {
    expect(await run('plain', user(['SUPER_ADMIN'], relaxed('dormant')))()).toBe(true);
    expect(await run('sensitive', user(['SUPER_ADMIN'], relaxed('dormant')))()).toBe(true);
  });

  it('no key outside a developer machine: ordinary routes pass, step-up is BLOCKED and audited', async () => {
    const record = jest.fn();
    expect(await run('plain', user(['ADMIN'], relaxed('unconfigured')), record)()).toBe(true);
    expect(record).not.toHaveBeenCalled();
    expect(await codeOf(run('sensitive', user(['ADMIN'], relaxed('unconfigured')), record))).toBe(
      'MFA_NOT_CONFIGURED',
    );
    expect(record).toHaveBeenCalledWith(
      'u',
      'not_configured',
      { operation: 'Routes.sensitive', method: 'POST', path: '/sensitive' },
      expect.any(Object),
    );
  });

  it('a relaxed state with no stepUp verdict reads as unconfigured: step-up fails closed', async () => {
    const legacy = relaxed(undefined);
    expect(await run('plain', user(['SUPER_ADMIN'], legacy))()).toBe(true);
    expect(await codeOf(run('sensitive', user(['SUPER_ADMIN'], legacy)))).toBe(
      'MFA_NOT_CONFIGURED',
    );
  });

  it('deferred, not enrolled: ordinary routes pass, step-up asks for setup and is audited', async () => {
    const record = jest.fn();
    expect(await run('plain', user(['ADMIN'], relaxed('available')), record)()).toBe(true);
    expect(await run('pending', user(['ADMIN'], relaxed('available')), record)()).toBe(true);
    expect(await codeOf(run('sensitive', user(['ADMIN'], relaxed('available')), record))).toBe(
      'MFA_SETUP_REQUIRED',
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      'u',
      'not_enrolled',
      expect.objectContaining({ operation: 'Routes.sensitive' }),
      expect.any(Object),
    );
  });

  it('a relaxed state that claims enrolment still needs a FRESH check on step-up', async () => {
    const odd = { ...relaxed('available'), enrolled: true };
    expect(await codeOf(run('sensitive', user(['ADMIN'], odd)))).toBe('MFA_STEP_UP_REQUIRED');
  });

  it('does not judge public routes or requests with no user', async () => {
    expect(await run('open', user(['ADMIN'], state({ verified: false })))()).toBe(true);
    expect(await run('plain', undefined)()).toBe(true);
  });

  it('step-up: a fresh check passes, a stale one is refused with MFA_STEP_UP_REQUIRED', async () => {
    expect(
      await run('sensitive', user(['ADMIN'], state({ verifiedAt: Date.now() - 60_000 })))(),
    ).toBe(true);
    expect(
      await codeOf(
        run('sensitive', user(['ADMIN'], state({ verifiedAt: Date.now() - 11 * 60_000 }))),
      ),
    ).toBe('MFA_STEP_UP_REQUIRED');
    expect(await codeOf(run('sensitive', user(['ADMIN'], state({ verifiedAt: null }))))).toBe(
      'MFA_STEP_UP_REQUIRED',
    );
  });
});
