import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';
import { AppException } from '../common/errors';

function context(user?: { id: string; roles: string[] }): ExecutionContext {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function guardRequiring(roles: string[] | undefined): RolesGuard {
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(roles) } as unknown as Reflector;
  return new RolesGuard(reflector);
}

describe('RolesGuard (payment admin RBAC)', () => {
  it('allows an ADMIN to reach an ADMIN-guarded payment route', () => {
    const guard = guardRequiring(['ADMIN', 'SUPER_ADMIN']);
    expect(guard.canActivate(context({ id: 'u1', roles: ['ADMIN'] }))).toBe(true);
  });

  it('denies a CUSTOMER (403) on an ADMIN-guarded route', () => {
    const guard = guardRequiring(['ADMIN', 'SUPER_ADMIN']);
    expect(() => guard.canActivate(context({ id: 'u2', roles: ['CUSTOMER'] }))).toThrow(
      AppException,
    );
  });

  it('denies an ORGANIZER_OWNER (no cross-role access to payment admin)', () => {
    const guard = guardRequiring(['ADMIN', 'SUPER_ADMIN']);
    expect(() => guard.canActivate(context({ id: 'u3', roles: ['ORGANIZER_OWNER'] }))).toThrow(
      AppException,
    );
  });

  it('requires authentication (401) when no user is present', () => {
    const guard = guardRequiring(['ADMIN']);
    expect(() => guard.canActivate(context(undefined))).toThrow(AppException);
  });

  it('is open when a route declares no roles', () => {
    const guard = guardRequiring(undefined);
    expect(guard.canActivate(context({ id: 'u4', roles: ['CUSTOMER'] }))).toBe(true);
  });

  it('SUPER_ADMIN also satisfies an ADMIN-or-SUPER_ADMIN route', () => {
    const guard = guardRequiring(['ADMIN', 'SUPER_ADMIN']);
    expect(guard.canActivate(context({ id: 'u5', roles: ['SUPER_ADMIN'] }))).toBe(true);
  });
});
