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
  is covered is the enumeration test in admin-mfa.http.integration-postgres.spec.ts.
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

const state = (over: Partial<NonNullable<RequestUser['mfa']>> = {}) => ({
  required: true,
  enrolled: true,
  verified: true,
  verifiedAt: Date.now(),
  ...over,
});
const user = (roles: string[], mfa?: RequestUser['mfa']) =>
  ({ id: 'u', email: 'e', fullName: 'n', roles, mfa }) as RequestUser;

function run(handler: keyof Routes, u: RequestUser | undefined) {
  const guard = new MfaGuard(new Reflector(), { stepUpMs: 10 * 60_000 } as never);
  const ctx = {
    getHandler: () => Routes.prototype[handler],
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => ({ user: u }) }),
  };
  return () => guard.canActivate(ctx as never);
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERROR';
  }
}

describe('MfaGuard decision table', () => {
  it('passes customers and organizers whatever their MFA state says', () => {
    expect(run('plain', user(['CUSTOMER']))()).toBe(true);
    expect(run('plain', user(['ORGANIZER_OWNER'], state({ verified: false })))()).toBe(true);
  });

  it('passes a verified back-office session', () => {
    expect(run('plain', user(['ADMIN'], state()))()).toBe(true);
    expect(run('plain', user(['SUPER_ADMIN'], state()))()).toBe(true);
  });

  it('refuses an unverified back-office session, enrolled or not, with MFA_REQUIRED', () => {
    for (const s of [state({ verified: false }), state({ verified: false, enrolled: false })]) {
      expect(codeOf(run('plain', user(['ADMIN'], s)))).toBe('MFA_REQUIRED');
    }
  });

  it('FAILS CLOSED: a back-office user with no MFA state at all is refused', () => {
    expect(codeOf(run('plain', user(['SUPER_ADMIN'], undefined)))).toBe('MFA_REQUIRED');
  });

  it('lets an unverified session reach only the routes that declare @AllowMfaPending', () => {
    const s = state({ verified: false, enrolled: false });
    expect(run('pending', user(['ADMIN'], s))()).toBe(true);
    expect(codeOf(run('plain', user(['ADMIN'], s)))).toBe('MFA_REQUIRED');
  });

  it('is a pass-through while dormant (no key configured)', () => {
    const dormant = { required: false, enrolled: false, verified: false, verifiedAt: null };
    expect(run('plain', user(['SUPER_ADMIN'], dormant))()).toBe(true);
    expect(run('sensitive', user(['SUPER_ADMIN'], dormant))()).toBe(true);
  });

  it('does not judge public routes or requests with no user', () => {
    expect(run('open', user(['ADMIN'], state({ verified: false })))()).toBe(true);
    expect(run('plain', undefined)()).toBe(true);
  });

  it('step-up: a fresh check passes, a stale one is refused with MFA_STEP_UP_REQUIRED', () => {
    expect(run('sensitive', user(['ADMIN'], state({ verifiedAt: Date.now() - 60_000 })))()).toBe(
      true,
    );
    expect(
      codeOf(run('sensitive', user(['ADMIN'], state({ verifiedAt: Date.now() - 11 * 60_000 })))),
    ).toBe('MFA_STEP_UP_REQUIRED');
    expect(codeOf(run('sensitive', user(['ADMIN'], state({ verifiedAt: null }))))).toBe(
      'MFA_STEP_UP_REQUIRED',
    );
  });
});
